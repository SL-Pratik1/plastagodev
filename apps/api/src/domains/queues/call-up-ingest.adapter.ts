import type { CallUpKind } from '@plastago/shared';
import type { ExtractorExtraction } from '../../integrations/extractor.js';
import { logger } from '../../lib/logger.js';
import type { RecordCallUpInput } from './call-up.service.js';

const log = logger.child({ module: 'call-up-ingest' });

/**
 * Reading a call-up email into something the service can act on (M2.12b).
 *
 * ── Everything here is a claim ────────────────────────────────────────────
 * Same posture as `po-ingest.adapter.ts`: the caller is a model, its declared
 * field types are advisory, and the values arrive as whatever the page said —
 * "21/09/2026", "Ready 21 Sept", "2026-09-21". So every read below does its own
 * coercion, and a value that will not coerce becomes null rather than a guess.
 * A null date is what sends the call-up to a human instead of scheduling a truck
 * for the wrong day.
 */

/** The template's field names. Mirrors `FIELD_KEYS` in the PO adapter. */
const FIELD_KEYS = {
  poNumber: 'po_number',
  readyDate: 'ready_date',
  /** "new" / "reschedule" / "cancel", or the builder's own colour word. */
  kind: 'notification_type',
  siteAddress: 'site_address',
  note: 'note',
} as const;

/**
 * Matt's colour coding, and the words that arrive with it (24:07).
 *
 * *"This one here is, it's in green, it's been rescheduled from this date to
 * this date… Green means it's been rescheduled from another day, whereas blue is
 * a brand new notification. There are red ones which are like job
 * cancellations."*
 *
 * The extractor reads a word, not a colour, and different builders word it
 * differently — so this maps everything seen on the real notices onto the three
 * things that can actually happen.
 */
const KIND_WORDS: Record<string, CallUpKind> = {
  new: 'new',
  blue: 'new',
  booking: 'new',
  'new booking': 'new',
  notification: 'new',
  'call up': 'new',
  'call-up': 'new',
  callup: 'new',
  green: 'reschedule',
  reschedule: 'reschedule',
  rescheduled: 'reschedule',
  'date change': 'reschedule',
  changed: 'reschedule',
  moved: 'reschedule',
  red: 'cancel',
  cancel: 'cancel',
  cancelled: 'cancel',
  canceled: 'cancel',
  cancellation: 'cancel',
};

export interface AdaptedCallUp {
  input: RecordCallUpInput;
  /** What could not be read, for the log. */
  missing: string[];
}

/**
 * Turns an extraction into a call-up, or explains why it cannot.
 *
 * Returns null only when there is no PO number at all — the one field with
 * nothing to fall back on. Without it the message cannot be matched to an order
 * now or by a human later, so there is nothing to queue.
 */
export function adaptCallUp(
  extraction: ExtractorExtraction,
  context: { receivedAt: Date },
): AdaptedCallUp | null {
  const data = extraction.extractedData ?? {};
  const missing: string[] = [];

  const poNumber = readString(data, FIELD_KEYS.poNumber, 60);
  if (poNumber === null) {
    log.warn(
      { extractionId: extraction.id, fileName: extraction.fileName },
      'call-up email carries no PO number — nothing to match it to, ignored',
    );
    return null;
  }

  const kind = readKind(data);
  if (kind === null) missing.push(FIELD_KEYS.kind);

  const readyDate = readDate(data, FIELD_KEYS.readyDate);
  if (readyDate === null) missing.push(FIELD_KEYS.readyDate);

  /*
   * An unreadable type defaults to `new`, not to nothing.
   *
   * The overwhelming majority of these notices are new bookings — Matt has had
   * ten cancellations in four years — and a new booking is also the SAFE default
   * of the three: it refuses when the order already has a job (`already-booked`)
   * rather than moving or cancelling work on a guess.
   */
  const resolvedKind: CallUpKind = kind ?? 'new';

  /*
   * A cancellation legitimately names no date. Anything else without one cannot
   * schedule anything, so it goes in with a null date and the service queues it
   * for a human rather than inventing today.
   */
  const note = buildNote({
    declaredKind: readString(data, FIELD_KEYS.kind, 40),
    address: readString(data, FIELD_KEYS.siteAddress, 200),
    extra: readString(data, FIELD_KEYS.note, 300),
    subject: extraction.fileName,
    missing,
  });

  return {
    input: {
      poNumber,
      kind: resolvedKind,
      readyDate: resolvedKind === 'cancel' ? null : readyDate,
      receivedAt: context.receivedAt,
      source: 'email',
      note,
      externalId: extraction.id,
    },
    missing,
  };
}

/* ── Reading the vendor's values ─────────────────────────────────────────── */

function readKind(data: Record<string, unknown>): CallUpKind | null {
  const raw = readString(data, FIELD_KEYS.kind, 40);
  if (raw === null) return null;

  const needle = raw.trim().toLowerCase();
  const exact = KIND_WORDS[needle];
  if (exact) return exact;

  /*
   * The notices are sentences as often as labels — "Job rescheduled to 21/09".
   * Checked longest-word-first so "rescheduled" cannot be beaten by a shorter
   * word that happens to appear in the same line.
   */
  const words = Object.keys(KIND_WORDS).sort((a, b) => b.length - a.length);
  const hit = words.find((word) => needle.includes(word));

  return hit ? (KIND_WORDS[hit] ?? null) : null;
}

function readString(data: Record<string, unknown>, key: string, max: number): string | null {
  const raw = data[key];
  if (raw === null || raw === undefined) return null;

  const text = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '';
  const trimmed = text.trim();

  return trimmed === '' ? null : trimmed.slice(0, max);
}

/**
 * A calendar day, as `YYYY-MM-DD`.
 *
 * ── Why day-first is assumed for an ambiguous slash date ──────────────────
 * These notices come from Australian builders, where 09/12 is the 9th of
 * December. `new Date('09/12/2026')` reads it as September in Node, which would
 * schedule a truck three months early — so slash and dot forms are parsed by
 * hand and only ISO strings are trusted to the Date constructor.
 */
function readDate(data: Record<string, unknown>, key: string): string | null {
  const raw = readString(data, key, 40);
  if (raw === null) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // `-` sits last in each class so it is a literal without needing an escape.
  const dayFirst = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(raw);
  if (dayFirst) {
    const year = Number(dayFirst[3]);
    return validDate(
      // "26" means 2026, not 1926 — these are dates a week or two out.
      year < 100 ? 2000 + year : year,
      Number(dayFirst[2]),
      Number(dayFirst[1]),
    );
  }

  /*
   * "21 September 2026" and "Mon 21 Sept". The year is optional on the real
   * notices, and a missing one means the coming occurrence of that day.
   */
  const named =
    /(\d{1,2})\s+([A-Za-z]{3,9})\.?\s*(\d{4})?/.exec(raw) ??
    /([A-Za-z]{3,9})\.?\s+(\d{1,2})\D*(\d{4})?/.exec(raw);

  if (named) {
    const digits = named[1] ?? '';
    const dayFromFirst = /^\d+$/.test(digits);
    const day = Number(dayFromFirst ? named[1] : named[2]);
    const monthWord = (dayFromFirst ? named[2] : named[1])?.toLowerCase().slice(0, 3) ?? '';
    const month = MONTHS.indexOf(monthWord) + 1;

    if (month > 0) {
      const year = named[3] ? Number(named[3]) : new Date().getUTCFullYear();
      return validDate(year, month, day);
    }
  }

  return null;
}

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

/** Refuses a date that does not exist, rather than letting it roll over. */
function validDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;

  const stamp = Date.UTC(year, month - 1, day);
  const back = new Date(stamp);

  // 31 February would otherwise arrive as 3 March.
  if (back.getUTCMonth() + 1 !== month || back.getUTCDate() !== day) return null;

  return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The note the office reads on the queue row.
 *
 * Carries what the email actually said, including the words that were NOT
 * understood — "notification_type could not be read" is the sentence that lets
 * somebody fix the template rather than re-keying every notice by hand.
 */
function buildNote(input: {
  declaredKind: string | null;
  address: string | null;
  extra: string | null;
  subject: string | null;
  missing: string[];
}): string {
  return [
    input.subject ? `Email: ${input.subject}` : null,
    input.declaredKind ? `Notice: ${input.declaredKind}` : null,
    input.address ? `Site: ${input.address}` : null,
    input.extra,
    input.missing.length > 0 ? `Could not read: ${input.missing.join(', ')}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
    .slice(0, 500);
}
