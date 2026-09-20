import * as z from 'zod';
import {
  AbnSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  ObjectIdSchema,
} from './primitives.js';

/**
 * The party model (M1.2): **Account ≠ Builder ≠ Site ≠ Contact.**
 *
 * Four distinct entities, not one "customer". This is proven by production
 * data: *iPlasta Pty Ltd* is the **account** that gets invoiced; *Fowler Homes*,
 * *GJ Gardner* and *King Homes* are the **builders** whose sites are serviced.
 * Collapsing them into one field is the mistake this file exists to prevent, so
 * there is deliberately no type called `Customer` — the UI says "account" or
 * "builder" and means one of them.
 */

/** M1.1 — brand is a first-class dimension, not a setting. */
export const BRAND_IDS = ['plastago', 'easylift', 'brickgo'] as const;
export const BrandIdSchema = z.enum(BRAND_IDS).meta({ id: 'BrandId' });
export type BrandId = z.infer<typeof BrandIdSchema>;

export const BRAND_LABELS: Record<BrandId, string> = {
  plastago: 'PlastaGo',
  easylift: 'EasyLift',
  brickgo: 'BrickGo',
};

/**
 * M6.3 — service charge and per-m² rate both vary by zone.
 *
 * ── Why this is an id and not an enum ─────────────────────────────────────
 * It WAS `z.enum(['sydney','wollongong','newcastle'])`, which fixed the three
 * at compile time: PlastaGo could not open the Central Coast without a deploy,
 * and every Mongoose model carried `enum: ZONES` so Mongo would have refused
 * the value even once a screen offered it.
 *
 * A zone is a service area with its own prices — business data, not a type — so
 * zones are documents in the `zones` collection and everything that has a zone
 * REFERENCES one by `_id`. Rate cards made the same move already; see
 * `RateCardIdSchema` below for the reasoning at length.
 *
 * ⚠️ Why an ObjectId here and a slug on a rate card. A rate card id is picked by
 * hand and appears in config (`DEFAULT_RATE_CARD_ID`), so it earns a readable
 * key. A zone is pure relational data — five collections point at it and
 * nothing names one in code — so it takes the ordinary Mongo key. The two
 * conventions are a deliberate split, not drift: do not "tidy" one to match.
 *
 * ⚠️ This schema parses RESPONSES on both sides. An enum here meant a zone an
 * administrator added would fail `safeParse` and blank the screen that was meant
 * to show it. That is the single reason this change could not be server-only.
 *
 * ⚠️ Consequence: a zone's name is NO LONGER derivable from its id. Read it off
 * the record — `ZoneSummary.label`, `Place.zoneLabel`, `GET /lookups/zones` —
 * never a lookup table. `SEEDED_ZONE_LABELS` below is for the seed script alone.
 */
export const ZoneSchema = ObjectIdSchema.meta({ id: 'Zone' });
export type Zone = z.infer<typeof ZoneSchema>;

/**
 * The zones the seed installs, by slug.
 *
 * ⚠️ NOT the set of zones that exist — an administrator adds more at runtime and
 * nothing may assume this list is complete. It exists so `seed-settings` has
 * something to write, and so tests have a stable name to reach for.
 */
export const SEEDED_ZONES = ['sydney', 'wollongong', 'newcastle'] as const;
export type SeededZoneSlug = (typeof SEEDED_ZONES)[number];

export const SEEDED_ZONE_LABELS: Record<SeededZoneSlug, string> = {
  sydney: 'Sydney',
  wollongong: 'Wollongong',
  newcastle: 'Newcastle',
};

/**
 * A zone's slug — its human handle, and never a foreign key.
 *
 * Stable across reseeds, readable in a log line or a Mongo shell, and what the
 * settings screen shows under the editable name. Joins use `_id`; nothing joins
 * on this.
 */
export const ZoneSlugSchema = z
  .string()
  .trim()
  .min(1, 'A zone needs a slug')
  .max(40, 'Keep the slug short')
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Lowercase letters, digits and hyphens only')
  .meta({ id: 'ZoneSlug' });

/**
 * One resolved place — a suburb with everything derived from it.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Matt, 7:25: *"as you're typing in an address, it will tell you the suburbs
 * that address could be in and you can just click the suburb and it will paste
 * in the suburb, state, postcode."*
 *
 * That is the visible half. The load-bearing half is that a job cannot be
 * priced or plotted without a `zone` and a coordinate, and until now both came
 * off the site record. With sites gone (Matt, 0:29) the picker is where they
 * come from instead — one click supplies the suburb, the postcode, the zone
 * that decides the rate, and the pin the dispatch map draws.
 *
 * ⚠️ `zone` is not cosmetic. Every zone carries its own service charge and its
 * own rate per m² (M6.3). A wrongly-zoned job is a wrongly-priced
 * invoice, and nobody notices until the customer does — which is why the zone
 * is *resolved from a chosen place* rather than typed or guessed from free text.
 *
 * ── Two backends, one shape ───────────────────────────────────────────────
 * Today this resolves against a table of the suburbs PlastaGo actually services.
 * With a billed Google key it resolves against Places Autocomplete instead. The
 * shape does not change, so neither do any of the call sites.
 */
export const PlaceSchema = z
  .object({
    /**
     * The place's own `_id`.
     *
     * ⚠️ Was a slug of the suburb alone, which collides: suburb names repeat
     * across postcodes, so "Richmond" could only ever be one of them. The row
     * is identified by `{suburb, postcode}` and keyed by an ObjectId.
     */
    id: ObjectIdSchema,
    suburb: NonEmptyStringSchema,
    postcode: NonEmptyStringSchema,
    state: NonEmptyStringSchema,
    /** Decides the rate — a reference into `zones`. See the warning above. */
    zoneId: ZoneSchema,
    /**
     * The zone's name, resolved server-side.
     *
     * Carried on the place so the picker can say "Wollongong" without holding a
     * zone map of its own — and so the customer portal, which is not allowed to
     * read the zone register, can still name the zone it is booking into.
     */
    zoneLabel: NonEmptyStringSchema,
    latitude: z.number(),
    longitude: z.number(),
    /** What the picker shows — "Kellyville NSW 2155". */
    label: NonEmptyStringSchema,
    /**
     * Taken off the picker, but not deleted.
     *
     * ⚠️ Always `false` on anything the type-ahead returns — that read excludes
     * archived rows by design. It is here for the SUBURBS ADMIN screen, which
     * lists both and has to tell them apart: without it the screen would offer
     * "restore" on a row that was never retired, and show a retired row exactly
     * like a live one.
     */
    archived: z.boolean(),
  })
  .meta({ id: 'Place' });

export type Place = z.infer<typeof PlaceSchema>;

/**
 * A suburb as an administrator types it (M6.3).
 *
 * The label is not here: it is built from the other fields on the way in, so two
 * rows cannot disagree about how a suburb reads.
 */
export const PlaceWriteSchema = z
  .object({
    suburb: z
      .string()
      .trim()
      .min(1, 'Name the suburb')
      .max(80, 'Keep the suburb under 80 characters'),
    postcode: z
      .string()
      .trim()
      .regex(/^\d{4}$/, 'Four digits, e.g. 2155'),
    state: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2,3}$/, 'A state code — NSW, VIC, QLD'),
    /** Checked against the zones that exist, in the service. Mongo will not. */
    zoneId: ZoneSchema,
    /*
     * ── OPTIONAL, because an administrator does not know a coordinate ──────
     * The pin is still REQUIRED on the stored row — it is what puts a job on
     * the dispatch map and what a geocoded street address is sanity-checked
     * against. It is simply not something a human should be typing: omit both
     * and the service geocodes the suburb and fills them in (I3).
     *
     * They stay accepted because geocoding can answer "no" — Google has never
     * heard of a brand-new estate, or the key is not configured — and a suburb
     * that cannot be added at all is a worse outcome than one typed by hand.
     *
     * ⚠️ Bounded to Australia, not to the globe.
     *
     * `latitude: 33.7118` instead of `-33.7118` is one keystroke and it is a
     * valid coordinate — in Lebanon. The dispatch map would draw the day's run
     * across the Mediterranean and the only symptom would be an allocator
     * saying the board looked strange. Generous enough for every state, tight
     * enough to catch a dropped minus sign.
     */
    latitude: z
      .number()
      .min(-44, 'That latitude is not in Australia — check the sign')
      .max(-9, 'That latitude is not in Australia — check the sign')
      .optional(),
    longitude: z
      .number()
      .min(112, 'That longitude is not in Australia')
      .max(154, 'That longitude is not in Australia')
      .optional(),
  })
  /*
   * Both or neither. Half a pin is not a location, and the half that arrived
   * would otherwise be silently dropped in favour of a geocode — leaving
   * somebody who corrected one number wondering why nothing moved.
   */
  .refine((place) => (place.latitude === undefined) === (place.longitude === undefined), {
    path: ['longitude'],
    message: 'Give both the latitude and the longitude, or neither',
  })
  .meta({ id: 'PlaceWrite' });

export type PlaceWrite = z.infer<typeof PlaceWriteSchema>;

/**
 * A suburb whose pin has been resolved — what actually reaches the database.
 *
 * The service turns a `PlaceWrite` into one of these by geocoding when the
 * coordinates were left out, so nothing below it has to consider the absent
 * case. See `place.service.ts`.
 */
export type LocatedPlaceWrite = PlaceWrite & { latitude: number; longitude: number };

/**
 * M2.3 / M4.3 — per-account capture configuration.
 *
 * m² and kg are two different quantities, not two units: m² is the board
 * installed (and what gets priced), kg is the waste actually recovered. Some
 * accounts record only the first.
 */
export const CAPTURE_MODES = ['area-only', 'area-and-weight'] as const;
export const CaptureModeSchema = z.enum(CAPTURE_MODES).meta({ id: 'CaptureMode' });
export type CaptureMode = z.infer<typeof CaptureModeSchema>;

export const CAPTURE_MODE_LABELS: Record<CaptureMode, string> = {
  'area-only': 'm² only',
  'area-and-weight': 'm² and kg',
};

/** M2.10 — PO enforcement is per account. */
export const PO_POLICIES = ['not-required', 'required-before-invoice'] as const;
export const PoPolicySchema = z.enum(PO_POLICIES).meta({ id: 'PoPolicy' });
export type PoPolicy = z.infer<typeof PoPolicySchema>;

export const PO_POLICY_LABELS: Record<PoPolicy, string> = {
  'not-required': 'Not required',
  'required-before-invoice': 'Required before invoicing',
};

/**
 * M6.1 — resolution order is named card → tier → default.
 *
 * ── Why this is a slug and not an enum ────────────────────────────────────
 * It WAS an enum of seven, which meant the seven were fixed at compile time:
 * an administrator could not add an eighth card for a new builder without a
 * deploy, and `accounts.rateCardId` carried the same enum so Mongo would have
 * rejected the value even if the UI had offered it.
 *
 * Rate cards are business data — one per negotiated agreement — so they live in
 * the `ratecards` collection and this validates the SHAPE of an id rather than
 * enumerating which ones exist. Lowercase, digits and hyphens only, because the
 * id appears in URLs and in Xero exports.
 *
 * ⚠️ Consequence: a card's human name is no longer derivable from its id. Read
 * `label` off the record — `RateCardSummary.label`, `AccountListItem`'s
 * `rateCardLabel` — never a lookup table. `SEEDED_RATE_CARD_LABELS` below is
 * for the seed script only.
 */
export const RateCardIdSchema = z
  .string()
  .trim()
  .min(1, 'A rate card needs an id')
  .max(40, 'Keep the id short — it appears in URLs')
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Lowercase letters, digits and hyphens only')
  .meta({ id: 'RateCardId' });
export type RateCardId = z.infer<typeof RateCardIdSchema>;

/**
 * The card every account falls back to, and the one card that may never be
 * deleted: `settingsRepository.resolveRate` uses it when a named card has no
 * entry for a zone, so removing it would turn a priced job into a failed one.
 */
export const DEFAULT_RATE_CARD_ID = 'default';

/**
 * The cards the seed installs. NOT the set of cards that exist — an
 * administrator adds more at runtime, and nothing may assume this list is
 * complete. It exists so `seed-settings` has something to write.
 */
export const SEEDED_RATE_CARDS = [
  'clarendon-domaine',
  'wisdom',
  'tier-1',
  'tier-2',
  'tier-3',
  'tier-4',
  DEFAULT_RATE_CARD_ID,
] as const;

export const SEEDED_RATE_CARD_LABELS: Record<(typeof SEEDED_RATE_CARDS)[number], string> = {
  'clarendon-domaine': 'Clarendon & Domaine',
  wisdom: 'Wisdom Properties Group',
  'tier-1': 'Tier 1',
  'tier-2': 'Tier 2',
  'tier-3': 'Tier 3',
  'tier-4': 'Tier 4',
  default: 'Default Customer Rates',
};

export const ACCOUNT_STATUSES = ['active', 'inactive'] as const;
export const AccountStatusSchema = z.enum(ACCOUNT_STATUSES).meta({ id: 'AccountStatus' });
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

/*
 * ── Terms and conditions: REMOVED, deliberately ───────────────────────────
 *
 * `OnboardingState`, `ONBOARDING_STATE_LABELS` and `TermsAcceptance` used to
 * live here. An account sat in `awaiting-terms` until its administrator ticked
 * a terms box in the portal, and the portal refused them every screen until
 * they did.
 *
 * It was removed on the client's instruction. The feature never appeared in the
 * written scope (`08-MVP-20-DAY-SCOPE.md` §A.4 lists the account, rate card, PO
 * policy, capture configuration, payment terms, brand, contacts and the
 * invitation — and no terms), and it was costing more than it earned: a
 * conversion sent without an invitation left the customer locked out of a screen
 * nobody had told them about.
 *
 * ⚠️ What SURVIVED is the part that was doing real work — the customer still
 * completes their own company details (address, ABN, certificate email), because
 * they are the authority on those and the office is not. See
 * `AccountOnboardingSchema` in `portal.ts`. What is gone is the tick, the named
 * signatory, and the gate.
 *
 * Do not re-add without the client asking for it.
 */

/**
 * The two kinds of customer, which behave differently at almost every step.
 *
 * Matt, 21:55: *"the builders would have site supervisors… we receive the POs
 * which lists the site supervisor. But plasterer contractors, **it should be a
 * second journey**. They probably don't need it at all. They could just have one
 * login where they could create pickups."*
 *
 * ── What actually differs ─────────────────────────────────────────────────
 *
 *   | | `builder` (Domain, Clarendon) | `contractor` (iPlast, Southgate) |
 *   |—|—|—|
 *   | Purchase orders | Always, months ahead | Never (22:53) |
 *   | Site supervisors | Yes — named on the PO | Hidden (20:09) |
 *   | Booking form | Short: area and bags come off the PO (25:19) | Full: they type everything |
 *   | Sites | Pre-loaded from POs | Typed at booking (22:44) |
 *
 * This is one field rather than a set of independent toggles because the two
 * journeys move together. A contractor with site supervisors switched on but no
 * PO flow is not a customer PlastaGo has; it is a half-configured account that
 * would take a support call to explain.
 */
export const ACCOUNT_TYPES = ['builder', 'contractor'] as const;
export const AccountTypeSchema = z.enum(ACCOUNT_TYPES).meta({ id: 'AccountType' });
export type AccountType = z.infer<typeof AccountTypeSchema>;

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  builder: 'Builder',
  contractor: 'Contractor',
};

/**
 * What each type means, in the office's own words. Shown next to the choice —
 * the labels alone do not tell a new starter which one to pick.
 */
export const ACCOUNT_TYPE_DESCRIPTIONS: Record<AccountType, string> = {
  builder: 'Sends purchase orders and call-ups. Has site supervisors who book their own pickups.',
  contractor: 'No purchase orders. One login, books pickups by filling in the form.',
};

/** Site supervisors are a builder-only concept — see `AccountTypeSchema`. */
export function hasSiteSupervisors(type: AccountType): boolean {
  return type === 'builder';
}

/**
 * True when this customer sends purchase orders.
 *
 * Drives whether the booking form asks for area and bags at all: for a builder
 * those figures come off the PO and asking would invite a contradiction
 * (Matt, 25:19). For a contractor the form IS the authorisation (22:53).
 */
export function sendsPurchaseOrders(type: AccountType): boolean {
  return type === 'builder';
}

/** M8.4 — one contact per role, each with its own channel preferences. */
export const CONTACT_ROLES = ['site', 'accounts', 'sustainability'] as const;
export const ContactRoleSchema = z.enum(CONTACT_ROLES).meta({ id: 'ContactRole' });
export type ContactRole = z.infer<typeof ContactRoleSchema>;

export const CONTACT_ROLE_LABELS: Record<ContactRole, string> = {
  site: 'Site',
  accounts: 'Accounts',
  sustainability: 'Sustainability',
};

export const ContactSchema = z
  .object({
    id: ObjectIdSchema,
    name: NonEmptyStringSchema,
    role: ContactRoleSchema,
    email: z.email().nullable(),
    mobile: z.string().nullable(),
    /** M8.4 — per-contact, per-channel preferences. */
    notifyBySms: z.boolean(),
    notifyByEmail: z.boolean(),
  })
  .meta({ id: 'Contact' });

/** Row shape for the accounts grid — enough to filter and scan, no more. */
export const AccountListItemSchema = z
  .object({
    id: ObjectIdSchema,
    code: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    brandId: BrandIdSchema,
    rateCardId: RateCardIdSchema,
    /** Builder or contractor — see `AccountTypeSchema`. Drives both journeys. */
    accountType: AccountTypeSchema,
    poPolicy: PoPolicySchema,
    captureMode: CaptureModeSchema,
    status: AccountStatusSchema,
    openJobCount: z.number().int().nonnegative(),
    lastJobAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'AccountListItem' });

/**
 * Creating an account directly, with no lead behind it.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Matt, 6:10: *"we also need the ability to create customer accounts manually
 * without going through the lead and invite process. For the larger builders
 * like Clarendon Homes, they won't go through… we'll just create the account for
 * them and give them the details."*
 *
 * The lead queue exists to stop enquiries being typed straight in as jobs. It
 * was never meant to be the only door into the customer list — and for the
 * builders that matter most it is the wrong door entirely: the relationship was
 * negotiated in a meeting, not captured on a web form, and inventing a lead to
 * close it immediately is paperwork nobody reads.
 *
 * ── Same fields as a conversion, minus the lead ───────────────────────────
 * Deliberately identical to `LeadConversionSchema` in everything an account
 * needs, so the two paths cannot produce different-shaped accounts. If a field
 * belongs on one, it belongs on both.
 */
export const AccountDraftSchema = z
  .object({
    customerCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}[0-9]{3}$/, 'Three letters then three digits, e.g. NEW001'),
    legalName: z
      .string()
      .trim()
      .min(1, 'Enter the registered company name')
      .max(120, 'Keep the registered name under 120 characters'),
    abn: AbnSchema,
    accountType: AccountTypeSchema,
    brandId: BrandIdSchema,
    rateCardId: RateCardIdSchema,
    poPolicy: PoPolicySchema,
    captureMode: CaptureModeSchema,
    paymentTermsDays: z
      .number()
      .int()
      .min(0, 'Payment terms cannot be negative')
      .max(90, 'Payment terms are at most 90 days'),
    /** Which zone most of their work is in. Each job is still zoned by its own address. */
    primaryZoneId: ZoneSchema,
    /** Where their invoices go. The one contact an account cannot trade without. */
    accountsContactName: z.string().trim().max(80, 'Keep the contact name under 80 characters'),
    accountsContactEmail: z
      .string()
      .trim()
      .max(160, 'Keep the email under 160 characters')
      .refine(
        (value) => value === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
        'Enter a valid email address, or leave it blank',
      ),
    /**
     * Whether to email them the self-serve onboarding link.
     *
     * Off by default here, and that is the point of this form. Matt's large
     * builders *"won't go through create your own account — we'll just create the
     * account for them"* (6:36), so the office fills it in and the terms are
     * handled by whatever contract already exists.
     */
    sendInvitation: z.boolean(),
    notes: z.string().trim().max(500),
  })
  .meta({ id: 'AccountDraft' });

export type AccountDraft = z.infer<typeof AccountDraftSchema>;

export const AccountSchema = AccountListItemSchema.extend({
  /**
   * M7.5 — which invoice template this account's invoices print on.
   *
   * Null means "follow the brand", resolved when the PDF is rendered rather
   * than stamped here: a new account should look right without anybody
   * choosing, and changing the brand's default should carry those accounts
   * with it.
   *
   * ⚠️ Resolved at render time, then FROZEN onto the invoice. Reassigning an
   * account changes the next invoice, never one already sent.
   */
  invoiceTemplateId: z.string().nullable(),
  /**
   * M4.8b — this builder requires a Site Risk Assessment before a driver starts.
   *
   * Lives on the ACCOUNT because it is a contractual term of theirs, not
   * something PlastaGo decides per job. Individual sites can still differ —
   * see `riskAssessmentOverride` on `Site`.
   *
   * ⚠️ Scope §Q36 is still open on whether this is ultimately per-account or
   * per-site. Modelling it as "account default + site override" answers both
   * readings without forcing the decision now, and without a migration later.
   */
  riskAssessmentRequired: z.boolean(),
  /**
   * Where this customer's diversion certificates are emailed.
   *
   * ── Three documents, three departments ────────────────────────────────
   * Matt, 31:04: *"invoices get sent off to the accounts department. Site photos
   * and site issues get sent to the site supervisor. And I need a section in
   * customers where we could say that **certificates are sent to this specific
   * email address**"* — which for most of his builders is a compliance or ESG
   * team that has nothing to do with either of the other two.
   *
   * A field rather than a fourth `Contact` row because it is a destination, not
   * a person: it is routinely a shared mailbox (esg@builder.com.au), and it must
   * survive whoever currently reads it moving on.
   *
   * Null falls back to the sustainability contact, then to accounts — a
   * certificate that goes to the wrong internal team is recoverable, one that
   * goes nowhere is not.
   */
  certificateEmail: z.string().nullable(),
  abn: z.string(),
  /**
   * The registered details the CUSTOMER supplies about themselves.
   *
   * ⚠️ These were written by the portal onboarding form and then returned by no
   * endpoint at all — stored, and invisible to the office that needed them. A
   * customer's own address being unreadable by the people who invoice them is
   * not a display preference; it is the record being kept somewhere nobody can
   * look. They are on the detail, not the list: a grid row is scanned, and an
   * address is read once.
   *
   * Null where the customer has not completed their details and the office has
   * not typed them in.
   */
  tradingName: z.string().nullable(),
  addressLine: z.string().nullable(),
  suburb: z.string().nullable(),
  postcode: z.string().nullable(),
  /**
   * When the customer last completed their own details, if ever.
   *
   * Replaces the onboarding state flag. It says the same useful thing — "have
   * they filled this in?" — without the legal meaning the terms gate carried,
   * and it is a date rather than a state because "when" is the question the
   * office actually asks about a detail that looks stale.
   */
  detailsCompletedAt: IsoDateTimeSchema.nullable(),
  paymentTermsDays: z.number().int().positive(),
  primaryZoneId: ZoneSchema,
  /** Resolved server-side — a screen showing an account must not have to hold a zone map. */
  primaryZoneLabel: NonEmptyStringSchema,
  contacts: z.array(ContactSchema),
  /** M5.6 / F46 — preferred windows and blackout times per account. */
  preferredPickupWindow: z.string().nullable(),
  notes: z.string(),
  createdAt: IsoDateTimeSchema,
}).meta({ id: 'Account' });

/**
 * What the office may correct on an existing account.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Until now an account could be CREATED and then never edited. The only two
 * things the API would change afterwards were the risk-assessment switch and
 * builder ↔ contractor — so a misspelt company name, a wrong ABN, a changed
 * registered address or a mistyped accounts email were permanent. Worse, half
 * of those fields could only ever be set by the customer, on a portal form the
 * office could not see, which left the people who raise the invoices unable to
 * fix the details the invoice is printed from.
 *
 * ⚠️ Nothing here is a COMMERCIAL term. The rate card, the payment terms, the
 * PO policy and the capture mode are absent on purpose: those are a negotiated
 * position, they re-price every invoice on the account, and they belong to a
 * deliberate act with its own endpoint — not to a general "edit details" form
 * somebody opens to fix a typo in a suburb.
 */
export const AccountUpdateSchema = z
  .object({
    legalName: z
      .string()
      .trim()
      .min(1, 'Enter the registered company name')
      .max(120, 'Keep the registered name under 120 characters'),
    /** Blank is a real answer — most builders trade under their legal name. */
    tradingName: z.string().trim().max(120, 'Keep the trading name under 120 characters'),
    abn: AbnSchema,
    /*
     * The registered address, optional as a whole.
     *
     * An account opened by the office for a builder whose terms were signed in a
     * meeting frequently has no address on file for weeks, and refusing to save
     * a corrected COMPANY NAME because the suburb is blank would make this form
     * unusable for the case it was built for.
     */
    addressLine: z.string().trim().max(160, 'Keep the address under 160 characters'),
    suburb: z.string().trim().max(80, 'Keep the suburb under 80 characters'),
    postcode: z
      .string()
      .trim()
      .refine((value) => value === '' || /^\d{4}$/.test(value), 'Four digits, or leave it blank'),
    /** Where their invoices go. See `AccountDraftSchema` for the pairing rule. */
    accountsContactName: z.string().trim().max(80, 'Keep the contact name under 80 characters'),
    accountsContactEmail: z
      .string()
      .trim()
      .max(160, 'Keep the email under 160 characters')
      .refine(
        (value) => value === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
        'Enter a valid email address, or leave it blank',
      ),
    /**
     * Where diversion certificates go — often a different team from accounts.
     *
     * Matt, 31:04: *"invoices get sent off to the accounts department… and I
     * need a section in customers where we could say that certificates are sent
     * to this specific email address."* Blank falls back to the sustainability
     * contact, then to accounts.
     */
    certificateEmail: z
      .string()
      .trim()
      .max(160, 'Keep the email under 160 characters')
      .refine(
        (value) => value === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
        'Enter a valid email address, or leave it blank',
      ),
    notes: z.string().trim().max(500),
  })
  .meta({ id: 'AccountUpdate' });

export type AccountUpdate = z.infer<typeof AccountUpdateSchema>;

/**
 * M7.5 — which invoice template this account's invoices are drawn with.
 *
 * ── Why null is a first-class value, not "unset" ──────────────────────────
 * Null means *follow the brand*, and it is the right answer for almost every
 * account: a new customer should look correct without anybody choosing, and
 * changing the brand's template should carry those accounts with it. Only a
 * customer who needs something different from the rest gets an explicit one.
 *
 * ⚠️ Resolved when the PDF is rendered and then FROZEN onto the invoice, so
 * reassigning an account changes its next invoice and never one already sent.
 */
export const AccountInvoiceTemplateBodySchema = z
  .object({ invoiceTemplateId: z.string().trim().min(1).max(60).nullable() })
  .meta({ id: 'AccountInvoiceTemplateBody' });

export type AccountInvoiceTemplateBody = z.infer<typeof AccountInvoiceTemplateBodySchema>;

export type Contact = z.infer<typeof ContactSchema>;
export type AccountListItem = z.infer<typeof AccountListItemSchema>;
export type Account = z.infer<typeof AccountSchema>;
