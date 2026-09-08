import {
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  BRAND_IDS,
  CAPTURE_MODES,
  CONTACT_ROLES,
  PO_POLICIES,
  RATE_CARDS,
  ZONES,
} from '@plastago/shared';
import { Schema, model } from 'mongoose';

export const ACCOUNTS_COLLECTION = 'accounts';
export const CONTACTS_COLLECTION = 'contacts';
export const TERMS_ACCEPTANCES_COLLECTION = 'termsacceptances';

/**
 * The account — the party that gets invoiced (M1.2).
 *
 * ⚠️ Account ≠ Builder. *iPlasta Pty Ltd* is the account; *GJ Gardner* is the
 * builder whose site is serviced. There is deliberately no `Customer` model —
 * the word means different things to different people in this business, and the
 * party model exists to keep them apart.
 *
 * ── References, never embedding ───────────────────────────────────────────
 * Contacts and the terms acceptance live in their own collections keyed by
 * `accountId`. Both look "owned" and both are still references: a contact's
 * notification preferences are edited far more often than the account, and
 * rewriting a whole account document to flip one SMS toggle is how two writers
 * lose each other's changes.
 */
const accountSchema = new Schema(
  {
    /**
     * The customer code — CLA001.
     *
     * Quoted on every invoice and said aloud on the phone. Unique, and upper-cased
     * on write so `cla001` and `CLA001` cannot both exist.
     */
    code: { type: String, required: true, trim: true, uppercase: true },
    name: { type: String, required: true, trim: true },

    /**
     * Builder or contractor — the field that decides two whole journeys.
     *
     * Matt, 21:55: a builder has purchase orders and site supervisors; a
     * contractor has neither and books straight off the form.
     */
    accountType: { type: String, required: true, enum: ACCOUNT_TYPES },

    /** REFERENCE → `brands._id`. Slug keys, matching the auth domain. */
    brandId: { type: String, required: true, ref: 'Brand', enum: BRAND_IDS },

    /**
     * ⚠️ Decides every invoice on this account (M6.1).
     *
     * Not a preference — a wrong rate card is a pricing incident that nobody
     * notices until the customer does. Required, never defaulted.
     */
    rateCardId: { type: String, required: true, enum: RATE_CARDS },

    poPolicy: { type: String, required: true, enum: PO_POLICIES },
    captureMode: { type: String, required: true, enum: CAPTURE_MODES },
    status: { type: String, required: true, enum: ACCOUNT_STATUSES, default: 'active' },

    abn: { type: String, required: true, trim: true },
    paymentTermsDays: { type: Number, required: true, min: 0, max: 90 },
    primaryZone: { type: String, required: true, enum: ZONES },

    /**
     * M4.8b — this builder contractually requires a Site Risk Assessment.
     *
     * Account-level only. The per-site exception went with the Sites module
     * (Matt, 0:29): a job is created once and never revisited, so a standing
     * per-site override has nowhere to live.
     */
    riskAssessmentRequired: { type: Boolean, required: true, default: false },

    /**
     * Where diversion certificates are emailed (Matt, 31:04).
     *
     * A separate destination from invoices on purpose — for most builders it is
     * a compliance or ESG mailbox with no connection to accounts payable. Null
     * falls back to the sustainability contact, then to accounts.
     */
    certificateEmail: { type: String, default: null, lowercase: true, trim: true },

    preferredPickupWindow: { type: String, default: null, trim: true },

    /**
     * B.2 — whether a supervisor joining by customer code needs approving.
     * Off by default: most builders want their people working immediately, and
     * an approval step nobody expects is a supervisor locked out on day one.
     */
    approveNewSupervisors: { type: Boolean, required: true, default: false },

    /*
     * ── The registered business details the CUSTOMER supplies (Journey A.4) ─
     *
     * Separate from `name`, which is what the office typed at conversion. The
     * customer is the authority on their own registered name and address, and
     * these are the fields the paper account application collected — the form
     * Matt chases a director's guarantee on today (7:49).
     */
    tradingName: { type: String, default: null, trim: true },
    addressLine: { type: String, default: null, trim: true },
    suburb: { type: String, default: null, trim: true },
    postcode: { type: String, default: null, trim: true },
    notes: { type: String, default: '', trim: true },
  },
  { collection: ACCOUNTS_COLLECTION, timestamps: true, versionKey: false },
);

/*
 * ── Indexes ───────────────────────────────────────────────────────────────
 * Designed, not guessed. The grid's default view is "active accounts, newest
 * work first", and the search box matches name or code.
 */

/** The code is the account's public identity. Two accounts cannot share one. */
accountSchema.index({ code: 1 }, { unique: true, name: 'code_unique' });

/** The grid's standing filters. Compound because they are always used together. */
accountSchema.index({ status: 1, brandId: 1, name: 1 }, { name: 'status_brand_name' });

/** "Show me the contractors" — Matt asked for this split to be sliceable. */
accountSchema.index({ accountType: 1, status: 1 }, { name: 'type_status' });

/**
 * Free-text search over the two things anyone actually types.
 *
 * A text index rather than a regex scan: `name` is the search box's primary
 * target and a leading-wildcard regex cannot use an index at all.
 */
accountSchema.index({ name: 'text', code: 'text' }, { name: 'account_search' });

export const AccountModel = model('Account', accountSchema);

/**
 * A contact on an account (M8.4) — its own collection, by reference.
 *
 * One row per role per account: who gets invoices, who is on site, who reads
 * the sustainability reports. Each carries its own channel preferences, which
 * is why they are rows rather than fields: the office edits one person's SMS
 * setting without touching the other two.
 */
const contactSchema = new Schema(
  {
    /** REFERENCE → `accounts._id`. */
    accountId: { type: Schema.Types.ObjectId, required: true, ref: 'Account' },
    name: { type: String, required: true, trim: true },
    role: { type: String, required: true, enum: CONTACT_ROLES },

    /**
     * Both nullable, and at least one is enforced in the service.
     *
     * A site contact often has only a mobile and an accounts contact often has
     * only an email — requiring both would block the majority of real contacts.
     */
    email: { type: String, default: null, lowercase: true, trim: true },
    mobile: { type: String, default: null, trim: true },

    notifyBySms: { type: Boolean, required: true, default: false },
    notifyByEmail: { type: Boolean, required: true, default: false },
  },
  { collection: CONTACTS_COLLECTION, timestamps: true, versionKey: false },
);

/** Every read of a contact is "the contacts for this account". */
contactSchema.index({ accountId: 1, role: 1 }, { name: 'account_role' });

export const ContactModel = model('Contact', contactSchema);

/**
 * The signed terms — Journey A.4, and the record Matt chases on paper today.
 *
 * ── Why its own collection, and why append-only ───────────────────────────
 * Matt, 7:49: *"some customers require them to give a **director's
 * guarantee**… it's more of a legal precedent that they have to sign off on."*
 *
 * That makes this evidence, not a field. It is written once and never updated:
 * a guarantee that can be silently edited is not evidence of anything. Storing
 * it separately also means the account document carries no legal state that
 * could be overwritten by an unrelated save.
 *
 * The account's `onboardingState` is DERIVED from whether a row exists here.
 * There is deliberately no second flag that could disagree with the record it
 * describes.
 */
const termsAcceptanceSchema = new Schema(
  {
    /** REFERENCE → `accounts._id`. */
    accountId: { type: Schema.Types.ObjectId, required: true, ref: 'Account' },
    acceptedAt: { type: Date, required: true },

    /**
     * Typed by the person accepting, not taken from the session.
     *
     * A guarantee is given by a named individual, and whoever is signed in may
     * be an accounts clerk acting for a director.
     */
    acceptedByName: { type: String, required: true, trim: true },
    acceptedByRole: { type: String, required: true, trim: true },

    /** The wording accepted, so a later change to the terms is provable. */
    termsVersion: { type: String, required: true, trim: true },
  },
  { collection: TERMS_ACCEPTANCES_COLLECTION, timestamps: true, versionKey: false },
);

/**
 * One acceptance per account.
 *
 * Unique rather than a plain index: accepting twice is not an error, but it
 * must not create a second row — the date and the person on the first one are
 * the evidence, and a duplicate makes "when did they sign?" ambiguous.
 */
termsAcceptanceSchema.index({ accountId: 1 }, { unique: true, name: 'account_unique' });

export const TermsAcceptanceModel = model('TermsAcceptance', termsAcceptanceSchema);
