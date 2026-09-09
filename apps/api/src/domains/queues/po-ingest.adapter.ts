import type { ExtractedField, MatchCandidate } from '@plastago/shared';
import { buildKey, getStorage } from '../../integrations/storage.js';
import { extractorClient, type ExtractorExtraction } from '../../integrations/extractor.js';
import { logger } from '../../lib/logger.js';
import { accountRepository } from '../accounts/account.repository.js';
import { placeRepository } from '../places/place.repository.js';
import type { IngestExtractionInput } from './po-extraction.repository.js';

const log = logger.child({ module: 'po-ingest' });

/**
 * Turning one extractor result into one review-queue row (M2.12 · I6).
 *
 * ── The division of labour this file exists to hold ───────────────────────
 * The extractor reads paper. It does not know PlastaGo's accounts, its zones or
 * its rate cards, and it is deliberately not told: matching a document to a
 * customer decides what gets invoiced, and a vendor that could assert
 * "this is Domaine" would be making a commercial decision on our behalf.
 *
 * So everything the extractor cannot know is decided here:
 *
 *  1. **Which account.** By the sender's email DOMAIN first, the document text
 *     second. See `matchAccount` for why that order matters.
 *  2. **Which suburb, and therefore which zone.** The zone prices the job
 *     (M6.3) and cannot be guessed from typed text.
 *  3. **How much to trust each field.** See `CONFIDENCE` below — this is a
 *     validation score, not a model score, and the difference is documented
 *     rather than hidden.
 *  4. **Where the original lives.** Copied into our own storage, because a
 *     reviewer reads figures off the PDF and a vendor URL expires.
 *
 * ⚠️ Nothing here decides `reason` or `state`. Both stay with
 * `poReviewService.ingest`, which is the one place that may declare why a human
 * has to look — see the warning on `IngestExtractionSchema`.
 */

/**
 * The template's field keys, as `seed-extractor` defines them.
 *
 * Named as constants rather than inlined so a template rename is one edit here
 * and a compile error everywhere it matters, instead of a silently null field
 * that reads as "the model could not find it".
 */
export const FIELD_KEYS = {
  poNumber: 'po_number',
  builderName: 'builder_name',
  orderDate: 'order_date',
  lotNumber: 'lot_number',
  siteAddress: 'site_address',
  suburb: 'suburb',
  postcode: 'postcode',
  areaM2: 'area_m2',
  bagAllowance: 'bag_allowance',
  supervisorName: 'supervisor_name',
  supervisorMobile: 'supervisor_mobile',
  amountExGst: 'amount_ex_gst',
  documentText: 'document_text',
} as const;

/**
 * ⚠️ These are VALIDATION scores, not model confidence.
 *
 * The extractor's API returns extracted values and no per-field score. Rather
 * than invent one — a number that looks like a measurement and is not — each
 * field is scored on how well what arrived parses against what the field has to
 * be: a mobile that matches an Australian mobile, an amount that parses as a
 * decimal, a suburb that resolves to a serviceable place.
 *
 * That is honest, reproducible from stored inputs, and serves the purpose the
 * score actually has here: EVERY extraction goes to a human (Risk 9), so
 * confidence only orders the reviewer's attention. It never decides whether
 * somebody looks.
 *
 * If the vendor later returns real per-field confidence, this table is where the
 * two would be combined.
 */
const CONFIDENCE = {
  /** Present and shaped as expected. */
  good: 0.95,
  /** Present, but nothing about it could be checked. */
  unverified: 0.7,
  /** Present and the wrong shape — a reviewer should look here first. */
  malformed: 0.35,
  /** Absent. Not always an error — see `areaM2` below. */
  absent: 0,
} as const;

/** Australian mobile, with or without spaces: 04xx xxx xxx. */
const AU_MOBILE = /^(?:\+?61|0)4\d{8}$/;

/** A decimal money string, as the contract requires on the wire (§6A.10 #1). */
const MONEY = /^-?\d+(\.\d{1,4})?$/;

/**
 * Mail domains that identify PlastaGo rather than a builder.
 *
 * ⚠️ Load-bearing. Both sample purchase orders name *"Plasta-Go Pty Ltd"* and
 * *"PLASTA GO"* on the page — as the VENDOR, which is us. An account match that
 * fell through to document text without excluding these would match every
 * purchase order to whichever account happens to look most like PlastaGo.
 */
const OWN_DOMAINS = new Set(['plastago.com.au', 'plastago.com', 'easylift.com.au']);

/** Public mailbox providers — a builder's real domain is what identifies them. */
const PUBLIC_DOMAINS = new Set([
  'gmail.com',
  'outlook.com',
  'hotmail.com',
  'yahoo.com',
  'yahoo.com.au',
  'bigpond.com',
  'live.com.au',
  'icloud.com',
]);

/**
 * Words that carry no identifying signal in an Australian builder's legal name.
 *
 * Stripped before matching so "Domaine Homes (NSW) Pty Ltd" and "Domaine Homes"
 * are the same needle. `homes` is deliberately NOT here: half these companies
 * are "<Something> Homes", and dropping it would leave one-word needles that
 * match each other.
 */
const NOISE_WORDS = new Set([
  'pty',
  'ltd',
  'limited',
  'proprietary',
  'group',
  'australia',
  'aust',
  'nsw',
  'the',
  'and',
]);

export interface AdaptedExtraction {
  /** Ready for `poReviewService.ingest`, which supplies `reason` itself. */
  input: Omit<IngestExtractionInput, 'reason'>;
  /** For the log line, so a bad run is diagnosable without re-reading the PDF. */
  diagnostics: {
    matchedBy: 'email-domain' | 'document-name' | 'none';
    suburbResolved: boolean;
    zone: string | null;
    storedOriginal: boolean;
  };
}

/**
 * Builds the queue row.
 *
 * Takes the extraction as fetched from the vendor with OUR credentials — never
 * a webhook body. See `extractorClient.getExtraction`.
 */
export async function adaptExtraction(
  extraction: ExtractorExtraction,
  context: { receivedAt: Date; subject: string | null },
): Promise<AdaptedExtraction> {
  const data = extraction.extractedData ?? {};
  const fromAddress = extraction.email ?? 'unknown@unknown';

  /* ── The flat values, each parsed and scored ───────────────────────────── */

  const poNumber = readString(data, FIELD_KEYS.poNumber, 60);
  const builderName = readString(data, FIELD_KEYS.builderName, 120);
  const lotNumber = readString(data, FIELD_KEYS.lotNumber, 30);
  const siteAddress = readString(data, FIELD_KEYS.siteAddress, 200);
  const suburbText = readString(data, FIELD_KEYS.suburb, 80);
  const postcodeText = readString(data, FIELD_KEYS.postcode, 10);
  const supervisorName = readString(data, FIELD_KEYS.supervisorName, 80);
  const supervisorMobile = normaliseMobile(readString(data, FIELD_KEYS.supervisorMobile, 40));
  const amountExGst = readMoney(data, FIELD_KEYS.amountExGst);
  const orderDate = readDate(data, FIELD_KEYS.orderDate);

  const areaM2 = readNumber(data, FIELD_KEYS.areaM2, 100_000);
  const bagAllowance = readInteger(data, FIELD_KEYS.bagAllowance, 200);

  /* ── Which account ─────────────────────────────────────────────────────── */

  const match = await matchAccount({ fromAddress, builderName });

  /* ── Which suburb, and therefore which zone ────────────────────────────── */

  const place = await resolvePlace(suburbText, postcodeText);

  /* ── The original, copied into our own storage ─────────────────────────── */

  const storageKey = await storeOriginal(extraction);

  /*
   * The per-field breakdown the review screen renders beside the document.
   *
   * Labels are the office's words, not the template's keys — the reviewer is
   * comparing this list against a PDF, not debugging a schema.
   */
  const fields: ExtractedField[] = [
    field('poNumber', 'Purchase order number', poNumber, poNumber ? CONFIDENCE.good : CONFIDENCE.absent),
    field(
      'accountName',
      'Builder',
      builderName,
      // Scored on whether it RESOLVED, not on whether text was read. A name the
      // model found but no account matches is the case a reviewer must catch.
      match.accountId ? CONFIDENCE.good : builderName ? CONFIDENCE.malformed : CONFIDENCE.absent,
    ),
    field('issuedOn', 'Order date', orderDate, orderDate ? CONFIDENCE.good : CONFIDENCE.absent),
    field('lotNumber', 'Lot number', lotNumber, lotNumber ? CONFIDENCE.good : CONFIDENCE.absent),
    field(
      'siteAddress',
      'Site address',
      // The RESOLVED place is shown where there is one, because that is the
      // address the job will actually be booked against.
      place ? joinAddress(siteAddress, place.label) : joinAddress(siteAddress, suburbText),
      /*
       * ⚠️ Scored on whether the suburb resolves to a serviceable place, not on
       * whether an address was read.
       *
       * A suburb absent from the places table means "we do not go there"
       * (`place.model.ts`), and a purchase order for an unserviceable suburb can
       * be confirmed and then never booked. That is the single most useful thing
       * this screen can warn a reviewer about, so it drives the score.
       */
      place ? CONFIDENCE.good : suburbText || siteAddress ? CONFIDENCE.malformed : CONFIDENCE.absent,
    ),
    field(
      'areaM2',
      'Plasterboard area (m²)',
      areaM2 === null ? null : `${String(areaM2)} m²`,
      /*
       * ⚠️ Absent is a CORRECT answer here, not a failed read.
       *
       * Matt, 31:04, on the Wisdom order: *"we're on a fixed price with them. So
       * they don't actually give us square metres… they just give us a line
       * item."* Scoring a missing area as a failure would send every one of that
       * builder's purchase orders to the top of the queue for a human to
       * confirm a number that is genuinely not on the page.
       */
      areaM2 === null ? CONFIDENCE.unverified : CONFIDENCE.good,
    ),
    field(
      'bagAllowance',
      'Bag allowance',
      bagAllowance === null ? null : String(bagAllowance),
      bagAllowance === null ? CONFIDENCE.unverified : CONFIDENCE.good,
    ),
    field(
      'siteSupervisorName',
      'Site supervisor',
      supervisorName,
      supervisorName ? CONFIDENCE.unverified : CONFIDENCE.absent,
    ),
    field(
      'siteSupervisorMobile',
      'Supervisor mobile',
      supervisorMobile,
      // The one field on these documents that is reliably in small print, and
      // the one a shape check can genuinely verify.
      supervisorMobile ? CONFIDENCE.good : CONFIDENCE.absent,
    ),
    field(
      'amountExGst',
      'Order value (ex GST)',
      amountExGst,
      amountExGst ? CONFIDENCE.good : CONFIDENCE.absent,
    ),
  ];

  return {
    input: {
      fromAddress,
      subject: context.subject ?? extraction.fileName,
      receivedAt: context.receivedAt,
      attachmentName: extraction.fileName,
      // The vendor does not report a page count. One is the honest floor: every
      // document has at least a first page, which is the one being reviewed.
      pageCount: 1,
      storageKey,
      documentText: readString(data, FIELD_KEYS.documentText, 200_000) ?? '',

      poNumber,
      amountExGst,
      extractedAreaM2: areaM2,
      extractedBagAllowance: bagAllowance,
      // The picked place wins over the typed line, because it is the one that
      // resolves to a zone. The raw address is kept when nothing resolved.
      extractedSiteAddress: siteAddress,
      extractedLotNumber: lotNumber,
      extractedSupervisorName: supervisorName,
      extractedSupervisorMobile: supervisorMobile,

      fields,

      suggestedAccountId: match.accountId,
      suggestedAccountName: match.accountName,
      /*
       * ⚠️ Always null, and not because matching is unimplemented.
       *
       * A purchase order arrives three to four months before the work (Matt,
       * 28:40), so there is no job to attach it to. Suggesting one would mean
       * guessing which future pickup a builder had in mind.
       */
      suggestedJobId: null,
      suggestedJobNumber: null,
      accountCandidates: match.candidates,
      jobCandidates: [],

      overallConfidence: overall(fields),
    },
    diagnostics: {
      matchedBy: match.matchedBy,
      suburbResolved: place !== null,
      zone: place?.zone ?? null,
      storedOriginal: storageKey !== null,
    },
  };
}

/* ── Account matching ────────────────────────────────────────────────────── */

interface AccountMatch {
  accountId: string | null;
  accountName: string | null;
  candidates: MatchCandidate[];
  matchedBy: 'email-domain' | 'document-name' | 'none';
}

/**
 * Which customer this order belongs to.
 *
 * ── Why the sender's domain is tried before the document text ─────────────
 * Because the document is the weaker signal, and both sample orders show why.
 * Wisdom's order is titled *"Spec Homes"* and names "Wisdom Homes" only in the
 * letterhead and the terms; Domaine's names the client household more
 * prominently than the builder. Meanwhile both name *PlastaGo* as the vendor,
 * in a labelled field, near the top.
 *
 * An email from `orders@wisdomhomes.com.au` is unambiguous in a way none of that
 * is. So the domain decides where it can, and the text is a fallback that
 * produces CANDIDATES for a human rather than an answer.
 */
async function matchAccount(input: {
  fromAddress: string;
  builderName: string | null;
}): Promise<AccountMatch> {
  const domain = domainOf(input.fromAddress);

  /*
   * A domain search runs against the account NAME, because accounts carry no
   * email domain field. `wisdomhomes.com.au` → `wisdomhomes` → `wisdom homes`,
   * which the text index matches.
   */
  if (domain && !OWN_DOMAINS.has(domain) && !PUBLIC_DOMAINS.has(domain)) {
    const needle = domainNeedle(domain);
    const found = needle ? await searchAccounts(needle) : [];

    if (found.length === 1 && found[0]) {
      return {
        accountId: found[0].id,
        accountName: found[0].name,
        candidates: [toCandidate(found[0], 0.95)],
        matchedBy: 'email-domain',
      };
    }

    /*
     * Several accounts share the domain's words. Not an answer — but the
     * candidates are worth carrying, because the reviewer picks from them.
     * `resolveReason` turns two near-equal candidates into `ambiguous-account`.
     */
    if (found.length > 1) {
      return {
        accountId: null,
        accountName: null,
        candidates: found.slice(0, 5).map((row) => toCandidate(row, 0.6)),
        matchedBy: 'none',
      };
    }
  }

  /* ── Fallback: the builder name read off the page ────────────────────── */

  const needle = nameNeedle(input.builderName);
  if (!needle) return { accountId: null, accountName: null, candidates: [], matchedBy: 'none' };

  const found = await searchAccounts(needle);
  if (found.length === 0) {
    return { accountId: null, accountName: null, candidates: [], matchedBy: 'none' };
  }

  const best = found[0];
  if (found.length === 1 && best) {
    return {
      accountId: best.id,
      accountName: best.name,
      // Deliberately below the service's 0.95 auto-accept line: a name read off
      // a scan is a good guess, not an identification.
      candidates: [toCandidate(best, 0.8)],
      matchedBy: 'document-name',
    };
  }

  return {
    accountId: null,
    accountName: null,
    candidates: found.slice(0, 5).map((row, index) => toCandidate(row, index === 0 ? 0.7 : 0.65)),
    matchedBy: 'none',
  };
}

/** Active accounts matching a free-text needle. Office scope — no tenant limit. */
async function searchAccounts(
  needle: string,
): Promise<Array<{ id: string; name: string; code: string }>> {
  const result = await accountRepository.list(
    { page: 1, pageSize: 5, q: needle, status: 'active' },
    { accountId: null },
  );

  return result.data.map((row) => ({ id: row.id, name: row.name, code: row.code }));
}

function toCandidate(
  row: { id: string; name: string; code: string },
  confidence: number,
): MatchCandidate {
  return { id: row.id, label: row.name, detail: row.code, confidence };
}

function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at === -1) return null;
  const domain = address.slice(at + 1).trim().toLowerCase();
  return domain === '' ? null : domain;
}

/**
 * A domain turned into words a text index can match.
 *
 * `wisdomhomes.com.au` → `wisdom homes`. The trailing suffixes go first, then
 * the known company words are split back out — a domain has no spaces, and
 * without this the needle `wisdomhomes` matches nothing at all.
 */
function domainNeedle(domain: string): string | null {
  const bare = domain
    .replace(/\.(com|net|org|co)(\.au|\.nz)?$/i, '')
    .replace(/\.au$/i, '')
    .replace(/[^a-z0-9]/gi, '');

  if (bare.length < 3) return null;

  // Only the suffixes that actually appear in this industry's domains. A general
  // word-splitter would invent boundaries that make the needle worse.
  const split = bare.replace(/(homes|group|constructions|building|projects)$/i, ' $1').trim();

  return split;
}

/** A legal name reduced to its identifying words. See `NOISE_WORDS`. */
function nameNeedle(name: string | null): string | null {
  if (!name) return null;

  const words = name
    .toLowerCase()
    // Bracketed qualifiers are pure noise: "(NSW)", "(Australia)".
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !NOISE_WORDS.has(word));

  const needle = words.join(' ').trim();
  return needle === '' ? null : needle;
}

/* ── Suburb and zone ─────────────────────────────────────────────────────── */

/**
 * The serviceable suburb behind what was read off the page.
 *
 * ⚠️ Returns null rather than a nearby suburb when nothing matches, and that
 * null is the whole point: PlastaGo services three zones, and a suburb absent
 * from the table means "we do not go there" (see `place.model.ts`). Falling back
 * to a neighbour would price a job on a zone the truck never visits.
 *
 * The POSTCODE is tried first. It is a machine-readable number printed in a
 * fixed position on these documents, whereas a suburb line can arrive as
 * "CATHERINE FIELD" or "Catherine Field NSW".
 */
async function resolvePlace(
  suburb: string | null,
  postcode: string | null,
): Promise<{ id: string; label: string; zone: string } | null> {
  const digits = postcode?.replace(/\D/g, '') ?? '';

  if (digits.length === 4) {
    const byPostcode = await placeRepository.search(digits);

    // One suburb for the postcode is an answer. Several is not — a postcode can
    // cover more than one suburb, and picking the first would be a coin toss on
    // a value that decides the price.
    if (byPostcode.length === 1 && byPostcode[0]) {
      return pick(byPostcode[0]);
    }

    // Several suburbs share the postcode: the suburb name breaks the tie.
    if (byPostcode.length > 1 && suburb) {
      const needle = suburb.trim().toLowerCase();
      const exact = byPostcode.find((place) => place.suburb.toLowerCase() === needle);
      if (exact) return pick(exact);
    }
  }

  if (!suburb) return null;

  const byName = await placeRepository.search(suburb.trim());
  const needle = suburb.trim().toLowerCase();

  // An EXACT name match only. A contains-match would resolve "Park" to whichever
  // of Oran Park or Marsden Park sorted first.
  const exact = byName.find((place) => place.suburb.toLowerCase() === needle);
  return exact ? pick(exact) : null;
}

function pick(place: { id: string; label: string; zone: string }): {
  id: string;
  label: string;
  zone: string;
} {
  return { id: place.id, label: place.label, zone: place.zone };
}

/* ── The original document ───────────────────────────────────────────────── */

/**
 * Copies the vendor's file into our own storage.
 *
 * ── Why it is copied rather than linked ───────────────────────────────────
 * The review screen shows the document beside the extracted fields, because
 * that comparison IS the review. A vendor URL would make that screen depend on
 * a third party's retention policy, and the confirmation is an audit record that
 * has to be re-readable years later.
 *
 * A failure here is logged and swallowed. An extraction with no attached PDF is
 * still worth reviewing — the fields are all there, and the reviewer can open
 * the original email. Dropping the row instead would lose a real purchase order
 * because a download timed out.
 */
async function storeOriginal(extraction: ExtractorExtraction): Promise<string | null> {
  if (!extraction.fileUrl) return null;

  try {
    const file = await extractorClient.downloadFile(extraction.fileUrl);

    /*
     * `buildKey` demands a 24-character hex owner id, and the vendor's
     * extraction id is exactly that shape — it is a Mongo ObjectId. Using it
     * keeps the object traceable back to the extraction it came from.
     */
    const key = buildKey({
      scope: 'purchase-orders',
      ownerId: extraction.id,
      kind: 'originals',
      contentType: file.contentType.startsWith('image/') ? file.contentType : 'application/pdf',
    });

    await getStorage().put(key, file.body, file.contentType);
    return key;
  } catch (error) {
    log.warn(
      { extractionId: extraction.id, error: (error as Error).message },
      'could not copy the extracted document into storage — the row is still queued',
    );
    return null;
  }
}

/* ── Reading the vendor's values ─────────────────────────────────────────── */

/**
 * The vendor's field types are advisory.
 *
 * Its templates declare `Number` and `String`, but the values arrive as whatever
 * the model produced — "823.41 m2", "$474.68", "1,120.00". So every read below
 * accepts a string or a number and does its own coercion. Trusting the declared
 * type would put "823.41 m2" into a numeric field as `NaN`.
 */
function readString(
  data: Record<string, unknown>,
  key: string,
  max: number,
): string | null {
  const raw = data[key];
  const value = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : null;
  if (value === null) return null;

  const trimmed = value.trim();
  if (trimmed === '' || isNullish(trimmed)) return null;

  return trimmed.slice(0, max);
}

function readNumber(data: Record<string, unknown>, key: string, max: number): number | null {
  const raw = data[key];

  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 && raw <= max ? raw : null;
  }

  if (typeof raw !== 'string') return null;

  /*
   * ⚠️ The unit is REMOVED before any digit is read, and that order is the
   * whole point of this function.
   *
   * Stripping every non-digit instead keeps the digit that lives INSIDE the
   * unit: "823.41 m2" becomes 823.412, and "1000 m2" becomes 10002. That is a
   * tenfold error on an area which prices the job and is apportioned onto an
   * EPA diversion certificate. Found by a test built from the real order.
   */
  const withoutUnits = raw.replace(UNIT_WORDS, ' ');

  /*
   * The FIRST numeric run, rather than every digit in the string: a trailing
   * item reference or footnote must not be glued onto the quantity. Commas are
   * thousands separators on these documents — "1,120".
   */
  const match = /\d[\d,]*(?:\.\d+)?/.exec(withoutUnits);
  if (!match) return null;

  const parsed = Number.parseFloat(match[0].replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= max ? parsed : null;
}

/**
 * The unit tokens these order tables print beside a quantity.
 *
 * Taken from the real documents: `m2` for an area, `Each` for bags, `Item`
 * and `JB` for a flat line, `NT` on Wisdom's zero-priced heading rows.
 */
const UNIT_WORDS = /\b(?:m2|m²|sqm|sq\s*m|each|items?|jb|nt|ea|units?)\b/gi;

function readInteger(data: Record<string, unknown>, key: string, max: number): number | null {
  const value = readNumber(data, key, max);
  // "2.00 Each" is two bags, so this rounds rather than refusing a decimal.
  return value === null ? null : Math.round(value);
}

/**
 * Money, as the decimal string the contract requires.
 *
 * ⚠️ The caller must have pointed the template at the EX-GST figure. Both sample
 * orders print an inclusive total more prominently than the exclusive one —
 * Domaine's *"ORDER TOTAL (Incl GST) $522.15"* is the largest number on the
 * page, and the value we want is the $474.68 above it. That is a template
 * instruction, not something this function can detect.
 */
function readMoney(data: Record<string, unknown>, key: string): string | null {
  const raw = data[key];
  const text = typeof raw === 'number' ? raw.toFixed(2) : typeof raw === 'string' ? raw : null;
  if (text === null) return null;

  const cleaned = text.replace(/[^\d.-]/g, '');
  if (cleaned === '' || !MONEY.test(cleaned)) return null;

  return cleaned;
}

/**
 * Normalises an Australian mobile, or returns what arrived.
 *
 * A malformed number is kept rather than discarded: the reviewer is looking at
 * the document and can correct it, and a blank field hides that the model read
 * something. Its confidence score is what says the shape is wrong.
 */
function normaliseMobile(value: string | null): string | null {
  if (!value) return null;

  const digits = value.replace(/[\s()-]/g, '');
  if (!AU_MOBILE.test(digits)) return value.slice(0, 20);

  const local = digits.replace(/^\+?61/, '0');
  return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`;
}

/**
 * The order date, as a plain `YYYY-MM-DD`.
 *
 * ── Why day-first is assumed, and why that is safe here ───────────────────
 * These are Australian documents and both samples print `DD/MM/YYYY` —
 * "22/07/2026" is 22 July. Read month-first it becomes 7 February, or an invalid
 * date, and neither failure announces itself.
 *
 * The template asks for ISO, which is handled first. The slash forms below are
 * the fallback for when the model echoes what it saw, which it does. A day that
 * cannot be a month is unambiguous and accepted; anything genuinely ambiguous is
 * still read day-first, because that is what the document meant.
 *
 * A date, not an instant: an order date is a calendar day, and giving it a
 * timezone is how it drifts by one (§6A.10 #5).
 */
function readDate(data: Record<string, unknown>, key: string): string | null {
  const raw = readString(data, key, 40);
  if (!raw) return null;

  // Already ISO, which is what the template asks for.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) return `${iso[1] ?? ''}-${iso[2] ?? ''}-${iso[3] ?? ''}`;

  const slashed = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(raw);
  if (!slashed) return null;

  const day = Number(slashed[1]);
  const month = Number(slashed[2]);
  const year = Number(slashed[3]);

  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  return `${String(year)}-${pad(month)}-${pad(day)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * The street line and the suburb as one displayable address.
 *
 * Joined rather than kept apart because the contract has one address field and
 * the reviewer is comparing it against one address block on the page.
 */
function joinAddress(line: string | null, suburb: string | null): string | null {
  const parts = [line, suburb].filter((part): part is string => Boolean(part));
  return parts.length === 0 ? null : parts.join(', ');
}

/**
 * Strings a model emits to mean "nothing here".
 *
 * Left as text they would land in the database and render to the office as a
 * supervisor called "N/A".
 */
function isNullish(value: string): boolean {
  const lower = value.toLowerCase();
  return lower === 'n/a' || lower === 'na' || lower === 'null' || lower === 'none' || lower === '-';
}

/* ── Scoring ─────────────────────────────────────────────────────────────── */

/**
 * One row of the breakdown.
 *
 * `key` is the contract's own enum, not free text: the review screen renders
 * these against a fixed list of labels, and a key nobody acts on would be a
 * value that lands in the database and is silently never displayed (see the
 * note on `IngestExtractionSchema`).
 */
function field(
  key: ExtractedField['key'],
  label: string,
  value: string | null,
  confidence: number,
): ExtractedField {
  return { key, label, value, confidence };
}

/**
 * One number for the queue to sort by.
 *
 * The MINIMUM of the fields that matter commercially, not an average. An average
 * lets nine good fields hide the one unreadable purchase-order number, and the
 * purchase-order number is the field an invoice is rejected for.
 */
function overall(fields: readonly ExtractedField[]): number {
  /*
   * The three that decide whether this order can become an invoiced job:
   * the number the builder's AP system matches on, the value they authorised,
   * and an address in a suburb PlastaGo actually services.
   */
  const critical = new Set<ExtractedField['key']>(['poNumber', 'amountExGst', 'siteAddress']);
  const scores = fields.filter((row) => critical.has(row.key)).map((row) => row.confidence);

  if (scores.length === 0) return 0;

  return Math.min(...scores);
}
