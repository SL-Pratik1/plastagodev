import { INVOICE_LAYOUTS } from '@plastago/shared';
import { Schema, model } from 'mongoose';

export const SETTINGS_COLLECTION = 'settings';

/**
 * Where each sequence starts, in ONE place.
 *
 * ⚠️ M1.4 — jobs and invoices continue from TransVirtual and must never restart
 * at 1: three years of numbers are quoted in builders' AP systems, and a
 * collision means two records answer to one number.
 *
 * Single-sourced because these are used twice — as the schema default when the
 * settings document is first created, and by `takeNextNumber` when a sequence
 * is added to a document that already exists. Two copies would be two chances
 * to restart invoicing at 1.
 */
export const SEQUENCE_STARTS = {
  nextJobNumber: 61_300,
  nextInvoiceNumber: 104_100,
  /** Runs are internal and nobody quotes them, so this one genuinely starts at 1. */
  nextRunNumber: 1,
} as const;

export type SequenceField = keyof typeof SEQUENCE_STARTS;
export const RATE_CARDS_COLLECTION = 'ratecards';
export const ZONE_RATES_COLLECTION = 'zonerates';
export const ADDITIONAL_SERVICES_COLLECTION = 'additionalservices';
export const INVOICE_TEMPLATES_COLLECTION = 'invoicetemplates';

/**
 * Platform settings — the scalars only.
 *
 * ── Why this is a singleton, and why the lists are not in it ──────────────
 * There is exactly one PlastaGo, so the settings that are single values live in
 * one document keyed by `SETTINGS_SINGLETON_ID`. Everything that is a LIST —
 * rate cards, zone rates, notification rules, integrations — is its own
 * collection referenced from here, because a list inside a document cannot be
 * queried, indexed or updated independently.
 *
 * That matters most for the sequences below: `nextJobNumber` and
 * `nextInvoiceNumber` are incremented under contention by every job and every
 * invoice, and `$inc` on a small document is the only safe way to do it. If
 * they lived beside a 200-entry rate card array, every allocation would rewrite
 * the whole thing.
 */
const settingsSchema = new Schema(
  {
    /** Fixed, so there can only ever be one settings document. */
    _id: { type: String, default: 'singleton' },

    /* ── General (M2.4a) ─────────────────────────────────────────────── */
    /** Target date is the customer's ready date plus this many business days. */
    slaBusinessDays: { type: Number, required: true, min: 1, max: 30, default: 5 },

    /**
     * ⚠️ Sequences, not counters.
     *
     * M1.4: these continue from TransVirtual — jobs from ~61,300, invoices from
     * ~104,100 — and must NEVER restart at 1. Three years of consignment
     * numbers are quoted in builders' AP systems, and a collision means two
     * different jobs answer to one number.
     *
     * Allocated with `findOneAndUpdate($inc)`, which is atomic. Reading then
     * writing would hand the same number to two simultaneous bookings.
     */
    nextJobNumber: { type: Number, required: true, min: 1, default: SEQUENCE_STARTS.nextJobNumber },
    nextInvoiceNumber: {
      type: Number,
      required: true,
      min: 1,
      default: SEQUENCE_STARTS.nextInvoiceNumber,
    },
    /**
     * M3 — the number dispatch quotes down the phone ("run 41").
     *
     * Starts at 1 rather than continuing anything: runs are new in PlastaGo, so
     * unlike the two sequences above there is no TransVirtual history to carry
     * forward. Not on the `Settings` contract because no screen sets it — it is
     * an internal allocator, and `takeNextNumber` is its only reader.
     */
    nextRunNumber: { type: Number, required: true, min: 1, default: SEQUENCE_STARTS.nextRunNumber },

    /* ── Invoicing (M7) ──────────────────────────────────────────────── */
    /**
     * M7.2 — the base invoice goes out on completion against the original PO;
     * additional charges follow once their own PO arrives.
     *
     * Matt, 33:56: *"the system we have doesn't really allow us to split onto
     * two invoices"* — which is why cash for the pickup is currently held up by
     * a second PO that may take three months.
     */
    splitAdditionalCharges: { type: Boolean, required: true, default: true },
    defaultPaymentTermsDays: { type: Number, required: true, min: 0, max: 90, default: 7 },

    /**
     * Printed in front of every invoice number — "PGA-104312" (Matt, 7:07).
     *
     * ⚠️ Presentation only. The stored number is a bare sequence that Xero
     * matches on, so changing this must renumber nothing.
     */
    invoiceNumberPrefix: { type: String, required: false, default: '', trim: true },

    /*
     * ── What the invoice PDF prints besides the invoice (M7.5) ───────────
     *
     * All optional, all defaulting to empty. The renderer omits an empty field
     * rather than substituting a placeholder: a document that went to a
     * builder saying "Company Name Here" is worse than one with a gap.
     *
     * ⚠️ `logoKey` is a STORAGE KEY, not a URL. The renderer reads the bytes
     * through `StorageProvider.get`, so producing an invoice never depends on
     * a public bucket or on a signed URL that may have expired.
     */
    logoKey: { type: String, required: false, default: '', trim: true },
    companyName: { type: String, required: false, default: '', trim: true },
    /** Absent means the document is not a valid tax invoice over $82.50. */
    companyAbn: { type: String, required: false, default: '', trim: true },
    companyAddress: { type: String, required: false, default: '', trim: true },
    companyPhone: { type: String, required: false, default: '', trim: true },
    companyEmail: { type: String, required: false, default: '', trim: true },

    termsText: { type: String, required: false, default: '' },
    footerText: { type: String, required: false, default: '' },
    bankBsb: { type: String, required: false, default: '' },
    bankAccount: { type: String, required: false, default: '' },
    /** A BSB and number with no account name is a payment that bounces back. */
    bankAccountName: { type: String, required: false, default: '', trim: true },
    showGbcaBadge: { type: Boolean, required: true, default: false },

    /*
     * ── The certificate signature block (M9.5 · F52) ────────────────────
     *
     * Here rather than in a section of its own because it is the same kind of
     * decision as the logo and the ABN above — the company as it appears on a
     * document it puts its name to. The Settings screen presents these under
     * "Invoicing & certificates" for that reason.
     *
     * ⚠️ `certificateSignatureKey` is a STORAGE KEY, not a URL, exactly like
     * `logoKey` and for the same reason.
     */
    certificateSignatureName: { type: String, required: false, default: '', trim: true },
    certificateSignatureTitle: { type: String, required: false, default: '', trim: true },
    certificateSignatureKey: { type: String, required: false, default: '', trim: true },

    /**
     * M6.8 — the flat per-job cost the margin figure assumes today.
     *
     * `Decimal128` like every other amount. No longer on the settings screen —
     * the margin card was removed — but still load-bearing: every figure on the
     * financial summary report (M9.6) is computed from it. A seed-time value
     * now, like the SLA above.
     */
    assumedCostPerJob: { type: Schema.Types.Decimal128, required: true },
  },
  { collection: SETTINGS_COLLECTION, timestamps: true, versionKey: false, _id: false },
);

export const SETTINGS_SINGLETON_ID = 'singleton';

export const SettingsModel = model('Settings', settingsSchema);

/**
 * A rate card (M6.1) — its own collection, referenced by `accounts.rateCardId`.
 *
 * Resolution order is named card → tier → default, and an account names exactly
 * one. Held as documents rather than an array on settings so an account can
 * reference one by id and so the accounts-per-card count is a query, not a scan.
 */
const rateCardSchema = new Schema(
  {
    /**
     * The slug the contract uses — `clarendon-domaine`, `tier-1`.
     *
     * ⚠️ No `enum`. Rate cards are business data an administrator adds; a
     * compile-time list here is what previously made "add a card for a new
     * builder" impossible even once the UI offered it. `RateCardIdSchema`
     * validates the shape on the way in.
     */
    _id: { type: String },
    label: { type: String, required: true, trim: true },

    /**
     * When the card itself came into use, and when the relationship ended.
     *
     * ⚠️ Distinct from a SCHEDULE's dates below. The card is the commercial
     * relationship and does not end when its prices change; the schedule is the
     * prices. Conflating the two is what made rates un-editable — every price
     * change looked like a new customer.
     */
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date, default: null },
  },
  { collection: RATE_CARDS_COLLECTION, timestamps: true, versionKey: false, _id: false },
);

export const RateCardModel = model('RateCard', rateCardSchema);

export const ZONES_COLLECTION = 'zones';

/**
 * A service area (M6.3) — its own collection, referenced by `places.zoneId`,
 * `accounts.primaryZoneId`, `leads.zoneId`, `jobs.zoneId` and every row in
 * `zonerates`.
 *
 * ── Why this is a collection and not an enum ──────────────────────────────
 * It was three literals in `@plastago/shared`, which made "open the Central
 * Coast" a deploy across six Mongoose models, seven rate cards and a schema
 * whose completeness check counted to three. Where the business goes is a
 * commercial decision, so it is data.
 *
 * ── Why an ObjectId key, when a rate card uses a slug ─────────────────────
 * A rate card id is named in code (`DEFAULT_RATE_CARD_ID`) and picked by hand,
 * so it earns a readable key. A zone is pure relational data — five collections
 * point at it and nothing names one in code — so it takes the ordinary Mongo
 * key. Two conventions on purpose; do not "tidy" one to match the other.
 *
 * ⚠️ A job's charge-line text bakes the LABEL in at quote time
 * (`pricing.service.ts`), so renaming a zone never moves a description on an
 * invoice already raised. That is intended, and is why renaming is safe at all.
 */
const zoneSchema = new Schema(
  {
    /**
     * The human handle — `sydney`, `central-coast`. Unique, and NEVER a foreign
     * key: joins use `_id`. It exists so the seeds have something stable to
     * upsert on, so a log line reads, and so the settings screen can show
     * something permanent under the editable name.
     */
    slug: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },

    /**
     * Where this zone sits in every list that shows all of them.
     *
     * ⚠️ Replaces `ZONES.indexOf(zone)`, which returned -1 for anything outside
     * the compile-time array and so sorted a newly added zone to the TOP of
     * every rate table. Stored rather than derived from the label, because the
     * office's order is commercial (Sydney first — it is most of the work), not
     * alphabetical.
     *
     * Not unique: a reorder rewrites every row, and a unique index would make
     * the intermediate states of that rewrite unrepresentable.
     */
    displayOrder: { type: Number, required: true, default: 0 },

    /**
     * Retired, but not gone.
     *
     * ⚠️ A zone is never hard-deleted. Jobs, invoices and rate schedules all
     * reference it and are never deleted themselves, so removing the row would
     * dangle a `zoneId` on five collections and leave a financial report unable
     * to name its own rows. Archiving says the one thing the office actually
     * means — stop offering it on new work — while every historical record
     * stays readable.
     */
    archived: { type: Boolean, required: true, default: false },
  },
  { collection: ZONES_COLLECTION, timestamps: true, versionKey: false },
);

/** The slug is the handle, so it has to be unique — including against archived zones. */
zoneSchema.index({ slug: 1 }, { unique: true, name: 'zone_slug_unique' });

/** Every list of zones reads in this order. A handful of rows, but it is the sort. */
zoneSchema.index({ displayOrder: 1 }, { name: 'zone_order' });

/** The pickers and the completeness check both ask for the live ones only. */
zoneSchema.index({ archived: 1, displayOrder: 1 }, { name: 'zone_active_order' });

export const ZoneModel = model('Zone', zoneSchema);

/**
 * What one rate card charges in one zone, for one effective period (M6.2/M6.3).
 *
 * ⚠️ Both amounts are `Decimal128`, never `Number` (§6A.10 #1). These figures
 * must match TransVirtual to the cent (Risk 1), which a double cannot
 * guarantee.
 *
 * ── Why a row is a VERSION and not a rate ─────────────────────────────────
 * There used to be one row per card per zone, enforced by a unique index on
 * exactly those two fields — which meant two versions of "Sydney on Tier 1"
 * could not be stored at all, and so a rate could only ever be overwritten.
 * Overwriting reprices history: pricing a job reads the rates in force on that
 * job's date, and a March invoice reissued in June has to use March's rates.
 *
 * Now a row carries its own window. Issuing a new schedule closes the current
 * row and inserts a new one, so nothing that priced a job is ever mutated.
 */
const zoneRateSchema = new Schema(
  {
    /** REFERENCE → `ratecards._id`. */
    rateCardId: { type: String, required: true, ref: 'RateCard' },
    /**
     * REFERENCE → `zones._id`.
     *
     * ⚠️ No `enum`, for the same reason `rateCardSchema._id` has none: zones are
     * records an administrator creates. The service checks the id names a zone
     * that EXISTS, because Mongo no longer will.
     */
    zoneId: { type: Schema.Types.ObjectId, required: true, ref: 'Zone' },
    /** The call-out fee, charged once per job regardless of size. */
    serviceCharge: { type: Schema.Types.Decimal128, required: true },
    /**
     * Per square metre. Stored at four decimal places because it is a RATE —
     * rounding it to cents before multiplying by 823.41 m² loses real money.
     */
    ratePerM2: { type: Schema.Types.Decimal128, required: true },

    /**
     * The window this row prices, inclusive at both ends.
     *
     * `effectiveTo: null` means open-ended, and there must be at most one such
     * row per card per zone — enforced by the partial index below. Dates are
     * stored as the START OF THE SYDNEY DAY (see `lib/business-day.ts`), never
     * UTC midnight: a schedule starting "1 October" must not begin at 11am on
     * 30 September for a business that runs in Sydney.
     */
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date, default: null },
  },
  { collection: ZONE_RATES_COLLECTION, timestamps: true, versionKey: false },
);

/**
 * One row per card, per zone, per start date.
 *
 * ⚠️ Replaces `card_zone_unique`, which forbade versioning outright. Dropping
 * the old index is part of the migration — Mongo will not remove it just
 * because this file stopped declaring it, and leaving it in place would reject
 * every new schedule with a duplicate-key error.
 */
zoneRateSchema.index(
  { rateCardId: 1, zoneId: 1, effectiveFrom: 1 },
  { unique: true, name: 'card_zone_from_unique' },
);

/**
 * At most one OPEN schedule per card per zone.
 *
 * Without this, a bug that forgot to close the previous row would leave two
 * rows both claiming to price today, and `resolveRate` would pick whichever
 * sorted first — a silent mispricing rather than a loud failure. A partial
 * unique index makes that state unrepresentable.
 */
zoneRateSchema.index(
  { rateCardId: 1, zoneId: 1 },
  {
    unique: true,
    name: 'card_zone_open_unique',
    partialFilterExpression: { effectiveTo: null },
  },
);

/** The hot path: the row pricing one card + zone on one date. */
zoneRateSchema.index(
  { rateCardId: 1, zoneId: 1, effectiveFrom: -1 },
  { name: 'card_zone_resolve' },
);

export const ZoneRateModel = model('ZoneRate', zoneRateSchema);

/**
 * The chargeable extras (M6.5–M6.7) — contamination, futile, extra load time.
 *
 * `driverRaisable` and `requiresApproval` are the two that matter operationally:
 * a driver reports contamination from a fence, and the office approves the
 * charge before it reaches an invoice (M2.7).
 */
const additionalServiceSchema = new Schema(
  {
    _id: { type: String },
    label: { type: String, required: true, trim: true },
    kind: { type: String, required: true, enum: ['fixed', 'percentage'] },
    /**
     * `Decimal128` for both kinds: a fixed amount is money, and a percentage is
     * a rate that must survive at its own precision.
     */
    value: { type: Schema.Types.Decimal128, required: true },
    requiresApproval: { type: Boolean, required: true, default: true },
    driverRaisable: { type: Boolean, required: true, default: false },
    /** Extra Load Time is system-generated — hence *Created By: System*. */
    systemGenerated: { type: Boolean, required: true, default: false },
  },
  {
    collection: ADDITIONAL_SERVICES_COLLECTION,
    timestamps: true,
    versionKey: false,
    _id: false,
  },
);

export const AdditionalServiceModel = model('AdditionalService', additionalServiceSchema);

/*
 * ── Three collections used to live here ───────────────────────────────────
 *
 * `notificationrules`, `integrations` and `credentialtypesettings` are gone.
 * Each was a settings surface nothing downstream read: the per-event SMS/email
 * matrix was never consulted by `outboundService` (it picks a channel from the
 * recipient's own M8.4 preferences), the integrations board could not configure
 * anything, and the credential-type register's lead times reached no reminder.
 *
 * ⚠️ Their DOCUMENTS are not dropped by this change — removing the models only
 * stops the app reading and writing them. Dropping the three collections is a
 * separate, deliberate migration step.
 *
 * ⚠️ Unrelated and still live: `notifications` and `outboundmessages` in the
 * notifications domain. Those are the bell and the delivery log, not this.
 */

/**
 * M7.5 — one invoice template: a named, branded configuration of a layout.
 *
 * ── What an administrator controls, and what they do not ─────────────────
 * They control what the document SAYS — its name, brand, accent colour and
 * whether kilograms print beside square metres. They do not control where the
 * logo sits or how the table is ruled: `layout` names one of the shipped
 * drawings, and the renderer owns those. Adding a sixth layout is a deploy;
 * adding a sixth template is a click.
 *
 * That split is the whole defence against the layout-authoring scope trap.
 */
const invoiceTemplateSchema = new Schema(
  {
    _id: { type: String },
    name: { type: String, required: true, trim: true },
    brandId: { type: String, required: true, ref: 'Brand' },
    /** Whether it prints kg alongside m² — depends on the account's capture mode. */
    showsWeight: { type: Boolean, required: true, default: false },
    /** Which shipped drawing renders it. See `INVOICE_LAYOUTS`. */
    layout: { type: String, required: true, enum: INVOICE_LAYOUTS, default: 'standard' },
    /** `#rrggbb` for the heading rule and table accent. */
    accentColour: { type: String, required: true, default: '#1a4d3a', trim: true },
  },
  {
    collection: INVOICE_TEMPLATES_COLLECTION,
    timestamps: true,
    versionKey: false,
    _id: false,
  },
);

export const InvoiceTemplateModel = model('InvoiceTemplate', invoiceTemplateSchema);
