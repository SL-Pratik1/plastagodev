import { PO_REVIEW_REASONS, PO_REVIEW_STATES } from '@plastago/shared';
import { Schema, model } from 'mongoose';

export const PO_EXTRACTIONS_COLLECTION = 'poextractions';
export const PURCHASE_ORDERS_COLLECTION = 'purchaseorders';

/**
 * M2.12 · I6 — a purchase order read off an email attachment, awaiting review.
 *
 * ── The design rule this whole collection exists to enforce ───────────────
 * Risk 9: **never silently guess.** An extraction does not become a purchase
 * order because a model was confident; it becomes one because a human confirmed
 * it. So the extraction and the purchase order are two records, and this one is
 * a proposal that somebody either accepts or throws away.
 *
 * ⚠️ A wrong PO number that lands silently on an invoice is worse than no
 * extraction at all: the invoice is rejected by the builder's accounts system
 * weeks later, and nobody knows why. That is the failure this queue prevents.
 *
 * ── Where the extraction comes from ───────────────────────────────────────
 * An external extractor posts the fields here. This API does not read email and
 * does not run a model — it owns the QUEUE, the confirmation and the audit
 * trail, which are the parts that must not be re-implemented per vendor.
 */
const extractedFieldSchema = new Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    value: { type: String, default: null },
    /**
     * Per FIELD, not just per document.
     *
     * They fail independently: a Domain PO's number is printed large at the top
     * and its supervisor's mobile is in eight-point type at the bottom, and one
     * being unreadable should not send the other back to a human.
     */
    confidence: { type: Number, required: true, min: 0, max: 1 },
  },
  { _id: false },
);

const matchCandidateSchema = new Schema(
  {
    id: { type: String, required: true },
    label: { type: String, required: true },
    detail: { type: String, required: false, default: '' },
    confidence: { type: Number, required: true, min: 0, max: 1 },
  },
  { _id: false },
);

const poExtractionSchema = new Schema(
  {
    /**
     * The extractor's own id for this document (I6).
     *
     * ⚠️ The idempotency key for the whole pipeline. The vendor retries a
     * callback that did not return 2xx and can fire more than once for one
     * document; without this a single purchase order lands in the queue twice,
     * two reviewers confirm it, and the unique index on
     * `(accountId, poNumber)` fails whichever of them was second — with a
     * database error rather than an explanation.
     *
     * Null on a row posted by hand, which is why the index below is partial.
     */
    externalId: { type: String, default: null, trim: true },

    /* ── Where it came from (I6) ─────────────────────────────────────── */
    fromAddress: { type: String, required: true, trim: true },
    subject: { type: String, required: true, trim: true },
    receivedAt: { type: Date, required: true },
    attachmentName: { type: String, required: true, trim: true },
    pageCount: { type: Number, required: true, min: 1, default: 1 },
    /** The stored original. The office reads figures off it during review. */
    storageKey: { type: String, default: null },
    /** Plain-text rendering, shown beside the fields so both can be compared. */
    documentText: { type: String, required: false, default: '' },

    /* ── What was read off it ────────────────────────────────────────── */
    poNumber: { type: String, default: null, trim: true },
    amountExGst: { type: Schema.Types.Decimal128, default: null },

    /*
     * The job spec. These are what make the extraction worth doing at all —
     * without them the office still retypes the area, the bag allowance and the
     * supervisor from a PDF that already had them machine-readable.
     *
     * Matt, 25:40: *"it should pull out of the purchase order"*.
     */
    extractedAreaM2: { type: Number, default: null, min: 0 },
    extractedBagAllowance: { type: Number, default: null, min: 0 },
    extractedSiteAddress: { type: String, default: null, trim: true },
    extractedLotNumber: { type: String, default: null, trim: true },
    extractedSupervisorName: { type: String, default: null, trim: true },
    extractedSupervisorMobile: { type: String, default: null, trim: true },

    fields: { type: [extractedFieldSchema], default: [] },

    /* ── What it was matched against ─────────────────────────────────── */
    /** REFERENCE → `accounts._id`. Null when nothing matched. */
    suggestedAccountId: { type: Schema.Types.ObjectId, default: null, ref: 'Account' },
    suggestedAccountName: { type: String, default: null, trim: true },
    /** REFERENCE → `jobs._id`. Usually null: the PO predates the job by months. */
    suggestedJobId: { type: Schema.Types.ObjectId, default: null, ref: 'Job' },
    suggestedJobNumber: { type: Number, default: null, min: 1 },
    accountCandidates: { type: [matchCandidateSchema], default: [] },
    jobCandidates: { type: [matchCandidateSchema], default: [] },

    overallConfidence: { type: Number, required: true, min: 0, max: 1, default: 0 },

    /**
     * WHY this is in a human queue, as a first-class field.
     *
     * "Below threshold" and "no account match" are different problems needing
     * different corrections, and lumping them into one "needs review" state
     * hides that from the person who has to fix it.
     */
    reason: { type: String, required: true, enum: PO_REVIEW_REASONS },
    state: { type: String, required: true, enum: PO_REVIEW_STATES, default: 'needs-review' },

    /* ── The review ──────────────────────────────────────────────────── */
    reviewedAt: { type: Date, default: null },
    reviewedByUserId: { type: Schema.Types.ObjectId, default: null, ref: 'User' },
    reviewedBy: { type: String, default: null, trim: true },
    rejectionNote: { type: String, default: null, trim: true },
    /** REFERENCE → `purchaseorders._id`, set when a review confirms one. */
    purchaseOrderId: { type: Schema.Types.ObjectId, default: null, ref: 'PurchaseOrder' },

    /**
     * ⚠️ M2.12: *"log confidence and correction rate from day one, so accuracy
     * is a measured number."*
     *
     * Which fields the human actually changed. Without this the accuracy of the
     * extractor is an opinion — and the decision to raise or lower the
     * auto-accept threshold has nothing behind it.
     */
    correctedFields: { type: [String], default: [] },
  },
  { collection: PO_EXTRACTIONS_COLLECTION, timestamps: true, versionKey: false },
);

/**
 * ⚠️ One row per extractor document.
 *
 * Unique rather than a plain index, and PARTIAL on the field being a string:
 * rows keyed in by hand carry no `externalId`, and Mongo would otherwise treat
 * every one of those nulls as a collision with the first.
 */
poExtractionSchema.index(
  { externalId: 1 },
  {
    unique: true,
    name: 'external_id_unique',
    partialFilterExpression: { externalId: { $type: 'string' } },
  },
);

/** The queue: everything needing review, oldest first. Partial, so it stays small. */
poExtractionSchema.index(
  { receivedAt: 1 },
  { name: 'needs_review', partialFilterExpression: { state: 'needs-review' } },
);

poExtractionSchema.index({ state: 1, receivedAt: -1 }, { name: 'state_received' });

/** Duplicate detection — `duplicate-po` is one of the review reasons. */
poExtractionSchema.index({ poNumber: 1 }, { name: 'po_number' });

export const PoExtractionModel = model('PoExtraction', poExtractionSchema);

/**
 * A confirmed purchase order (M2.12).
 *
 * ── Why a PO is two documents at once ─────────────────────────────────────
 * It is **permission to invoice** — a builder's accounts system rejects any
 * invoice not quoting a valid PO number (Matt, 9:56) — and it is also the **job
 * spec**. Matt walked through a Domain order at 28:12: the order number, the
 * site address down to the lot, 823.41 square metres, a two-bag allowance, and
 * the site supervisor with his mobile.
 *
 * Storing only `poNumber` keeps the money half and throws away the spec half,
 * leaving the office to retype figures that arrived machine-readable.
 *
 * ⚠️ It does NOT schedule anything. *"We'll receive this probably three to four
 * months before we actually do the job"* (28:40). A PO that created a live job
 * would put a pickup on the board for a house that has not been framed yet —
 * what schedules the work is a separate call-up a week out.
 */
const purchaseOrderSchema = new Schema(
  {
    poNumber: { type: String, required: true, trim: true },
    /** REFERENCE → `accounts._id`. */
    accountId: { type: Schema.Types.ObjectId, required: true, ref: 'Account' },
    accountName: { type: String, required: true, trim: true },
    receivedAt: { type: Date, required: true },

    /* ── The site, as the PO gives it ────────────────────────────────── */
    /** Greenfield estates have no street number yet — the lot IS the address. */
    lotNumber: { type: String, default: null, trim: true },
    addressLine: { type: String, default: null, trim: true },
    suburb: { type: String, default: null, trim: true },
    postcode: { type: String, default: null, trim: true },

    /* ── The job, as the PO specifies it ─────────────────────────────── */
    /**
     * ⚠️ Null on a fixed-price account, and that is NOT a failed extraction.
     *
     * Matt, 31:04, on the Wisdom PO: *"we're on a fixed price with them. So they
     * don't actually give us square metres… they just give us a line item."*
     * Treating the absence as a low-confidence read would send every Wisdom
     * order to the review queue for a human to confirm a number that is
     * genuinely not on the page.
     */
    expectedAreaM2: { type: Number, default: null, min: 0 },
    /** Roughly one per 500 m², and the builder states the allowance (28:12). */
    bagAllowance: { type: Number, default: null, min: 0 },

    siteSupervisorName: { type: String, default: null, trim: true },
    siteSupervisorMobile: { type: String, default: null, trim: true },

    amountExGst: { type: Schema.Types.Decimal128, default: null },
    /** REFERENCE → the stored original in object storage. */
    storageKey: { type: String, default: null },

    /** REFERENCE → `poextractions._id`, where this came from. Null if keyed in. */
    extractionId: { type: Schema.Types.ObjectId, default: null, ref: 'PoExtraction' },
    createdByName: { type: String, required: true, trim: true },
  },
  { collection: PURCHASE_ORDERS_COLLECTION, timestamps: true, versionKey: false },
);

/**
 * ⚠️ One PO number per account.
 *
 * `duplicate-po` is a review reason precisely because the same number arriving
 * twice means either a resend or a mistake, and both need a human. The database
 * makes the second one impossible rather than merely flagged.
 */
purchaseOrderSchema.index(
  { accountId: 1, poNumber: 1 },
  { unique: true, name: 'account_po_unique' },
);

/** Finding the order a call-up or a booking refers to. */
purchaseOrderSchema.index({ poNumber: 1 }, { name: 'po_number' });
purchaseOrderSchema.index({ accountId: 1, receivedAt: -1 }, { name: 'account_received' });

export const PurchaseOrderModel = model('PurchaseOrder', purchaseOrderSchema);
