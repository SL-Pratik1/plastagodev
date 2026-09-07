import {
  CREDENTIAL_TYPES,
  INTEGRATION_IDS,
  INTEGRATION_STATES,
  NOTIFICATION_EVENTS,
  RATE_CARDS,
  ZONES,
} from '@plastago/shared';
import { Schema, model } from 'mongoose';

export const SETTINGS_COLLECTION = 'settings';
export const RATE_CARDS_COLLECTION = 'ratecards';
export const ZONE_RATES_COLLECTION = 'zonerates';
export const ADDITIONAL_SERVICES_COLLECTION = 'additionalservices';
export const NOTIFICATION_RULES_COLLECTION = 'notificationrules';
export const INTEGRATIONS_COLLECTION = 'integrations';
export const CREDENTIAL_TYPES_COLLECTION = 'credentialtypesettings';
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
    nextJobNumber: { type: Number, required: true, min: 1, default: 61_300 },
    nextInvoiceNumber: { type: Number, required: true, min: 1, default: 104_100 },
    /**
     * M3 — the number dispatch quotes down the phone ("run 41").
     *
     * Starts at 1 rather than continuing anything: runs are new in PlastaGo, so
     * unlike the two sequences above there is no TransVirtual history to carry
     * forward. Not on the `Settings` contract because no screen sets it — it is
     * an internal allocator, and `takeNextNumber` is its only reader.
     */
    nextRunNumber: { type: Number, required: true, min: 1, default: 1 },

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

    footerText: { type: String, required: false, default: '' },
    bankBsb: { type: String, required: false, default: '' },
    bankAccount: { type: String, required: false, default: '' },
    showGbcaBadge: { type: Boolean, required: true, default: false },

    /* ── Notifications (M8) ──────────────────────────────────────────── */
    reminderLeadDays: { type: Number, required: true, min: 1, max: 7, default: 2 },
    reminderIncludeRescheduleLink: { type: Boolean, required: true, default: true },
    queueDigestEnabled: { type: Boolean, required: true, default: true },
    queueDigestHour: { type: Number, required: true, min: 0, max: 23, default: 7 },

    /**
     * M6.8 — the flat per-job cost the margin figure assumes today.
     *
     * `Decimal128` like every other amount. A placeholder until real cost data
     * exists, which is exactly why it is a setting rather than a constant: the
     * office can correct it without a deploy.
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
    /** The slug the contract uses — `clarendon-domaine`, `tier-1`. */
    _id: { type: String, enum: RATE_CARDS },
    label: { type: String, required: true, trim: true },

    /**
     * M6.2 — rates are versioned: a job is priced by the date it RAN, not by
     * today's card. Re-pricing history when a rate changes would rewrite
     * invoices that have already been paid.
     */
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date, default: null },
  },
  { collection: RATE_CARDS_COLLECTION, timestamps: true, versionKey: false, _id: false },
);

export const RateCardModel = model('RateCard', rateCardSchema);

/**
 * What one rate card charges in one zone (M6.3).
 *
 * ⚠️ Both amounts are `Decimal128`, never `Number` (§6A.10 #1). Sydney is
 * $220 + $0.16/m²; Wollongong $250 + $0.18; Newcastle $250 + $0.20. These
 * figures must match TransVirtual to the cent (Risk 1), which a double cannot
 * guarantee.
 */
const zoneRateSchema = new Schema(
  {
    /** REFERENCE → `ratecards._id`. */
    rateCardId: { type: String, required: true, ref: 'RateCard', enum: RATE_CARDS },
    zone: { type: String, required: true, enum: ZONES },
    /** The call-out fee, charged once per job regardless of size. */
    serviceCharge: { type: Schema.Types.Decimal128, required: true },
    /**
     * Per square metre. Stored at four decimal places because it is a RATE —
     * rounding it to cents before multiplying by 823.41 m² loses real money.
     */
    ratePerM2: { type: Schema.Types.Decimal128, required: true },
  },
  { collection: ZONE_RATES_COLLECTION, timestamps: true, versionKey: false },
);

/** One rate per card per zone. A duplicate would make pricing ambiguous. */
zoneRateSchema.index({ rateCardId: 1, zone: 1 }, { unique: true, name: 'card_zone_unique' });

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

/** M8 — one rule per notifiable event. Its own collection so a rule is a row. */
const notificationRuleSchema = new Schema(
  {
    _id: { type: String, enum: NOTIFICATION_EVENTS },
    sms: { type: Boolean, required: true, default: false },
    email: { type: Boolean, required: true, default: true },
    includePhotos: { type: Boolean, required: true, default: false },
  },
  {
    collection: NOTIFICATION_RULES_COLLECTION,
    timestamps: true,
    versionKey: false,
    _id: false,
  },
);

export const NotificationRuleModel = model('NotificationRule', notificationRuleSchema);

/**
 * W7 — connection state for each external service.
 *
 * ⚠️ NO CREDENTIALS. This records whether a connection works and when it last
 * did; secrets stay in the environment. A settings screen that could read a
 * Twilio token is one XSS away from leaking it.
 */
const integrationSchema = new Schema(
  {
    _id: { type: String, enum: INTEGRATION_IDS },
    name: { type: String, required: true, trim: true },
    purpose: { type: String, required: true, trim: true },
    state: { type: String, required: true, enum: INTEGRATION_STATES, default: 'not-configured' },
    lastSuccessAt: { type: Date, default: null },
    detail: { type: String, default: null },
    /** Known limitation worth saying out loud — e.g. M365 needs IP whitelisting. */
    caveat: { type: String, default: null },
  },
  { collection: INTEGRATIONS_COLLECTION, timestamps: true, versionKey: false, _id: false },
);

export const IntegrationModel = model('Integration', integrationSchema);

/** F53 — driver licences and tickets, and how far ahead to warn (M9.8). */
const credentialTypeSchema = new Schema(
  {
    _id: { type: String, enum: CREDENTIAL_TYPES },
    label: { type: String, required: true, trim: true },
    reminderLeadDays: { type: Number, required: true, min: 1, max: 180, default: 30 },
    requiredForDrivers: { type: Boolean, required: true, default: false },
  },
  { collection: CREDENTIAL_TYPES_COLLECTION, timestamps: true, versionKey: false, _id: false },
);

export const CredentialTypeModel = model('CredentialTypeSetting', credentialTypeSchema);

/** M7.5 — the invoice layouts, and which brand each belongs to. */
const invoiceTemplateSchema = new Schema(
  {
    _id: { type: String },
    name: { type: String, required: true, trim: true },
    brandId: { type: String, required: true, ref: 'Brand' },
    /** Whether it prints kg alongside m² — depends on the account's capture mode. */
    showsWeight: { type: Boolean, required: true, default: false },
  },
  {
    collection: INVOICE_TEMPLATES_COLLECTION,
    timestamps: true,
    versionKey: false,
    _id: false,
  },
);

export const InvoiceTemplateModel = model('InvoiceTemplate', invoiceTemplateSchema);
