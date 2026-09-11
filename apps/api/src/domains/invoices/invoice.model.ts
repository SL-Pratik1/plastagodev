import { BRAND_IDS, INVOICE_KINDS, INVOICE_STATUSES, XERO_SYNC_STATES } from '@plastago/shared';
import { Schema, model } from 'mongoose';

export const INVOICES_COLLECTION = 'invoices';
export const INVOICE_LINES_COLLECTION = 'invoicelines';

/**
 * An invoice (M7).
 *
 * ── The two-invoice workflow is the load-bearing part of this domain ───────
 * Matt, 33:56 — additional charges need their OWN purchase order, and that PO
 * can take three months to arrive. Under their current system everything has to
 * go on one invoice, so the money for a pickup that has already happened sits
 * waiting on a PO for a $90 contamination charge.
 *
 *   *"the system we have doesn't really allow us to split onto two invoices"*
 *
 * So `kind` is a first-class field, not a flag: the base invoice goes out the
 * moment the job completes against the PO that was already on it, and the
 * additional charges become a SECOND invoice that waits for its own PO without
 * holding up the first one's cash.
 *
 * Accounts with no PO requirement get everything on one invoice — the split
 * exists to unblock cash, and where nothing is blocked it would only be noise.
 */
const invoiceSchema = new Schema(
  {
    /**
     * M1.4 — continues the TransVirtual sequence from ~104,100.
     *
     * ⚠️ Unique, and it must NEVER restart at 1: three years of invoice numbers
     * are quoted in builders' AP systems and matched in Xero. Allocated by
     * `settingsRepository.takeNextNumber`, which is atomic.
     */
    invoiceNumber: { type: Number, required: true, min: 1 },
    kind: { type: String, required: true, enum: INVOICE_KINDS },
    status: { type: String, required: true, enum: INVOICE_STATUSES, default: 'draft' },

    /* ── References ──────────────────────────────────────────────────── */
    /** REFERENCE → `accounts._id`. Who pays. */
    accountId: { type: Schema.Types.ObjectId, required: true, ref: 'Account' },
    /** Frozen copy, so the grid renders without a join and history stays true. */
    accountName: { type: String, required: true, trim: true },
    /** REFERENCE → `brands._id`. Which letterhead and bank details print. */
    brandId: { type: String, required: true, enum: BRAND_IDS, ref: 'Brand' },
    /**
     * REFERENCE → `jobs._id`. Null only for an invoice not raised from a job,
     * which does not happen today but is not worth forbidding in the schema.
     */
    jobId: { type: Schema.Types.ObjectId, default: null, ref: 'Job' },
    jobNumber: { type: Number, default: null, min: 1 },

    /**
     * The customer's PO — printed on the invoice, deliberately.
     *
     * Matt, 9:56: *"it needs to be referenced as a PO number, like PO slash job
     * reference. Because if we don't list PO on the invoice, then sometimes I
     * have trouble getting paid."* The builder's AP system looks for a PO line;
     * an invoice without one does not get paid.
     *
     * ⚠️ On an `additional-charges` invoice this starts NULL even though the
     * base invoice had one. That is the whole point of the split: this invoice
     * needs a new PO of its own, and until it arrives the row sits in the
     * awaiting-PO queue (M7.3).
     */
    poNumber: { type: String, default: null, trim: true },

    /* ── Dates ───────────────────────────────────────────────────────── */
    /** Plain `YYYY-MM-DD`: an invoice date is a calendar day, not an instant. */
    issuedOn: { type: String, default: null },
    /** Issue date plus the account's terms. 7 days — no slack in their cash cycle. */
    dueOn: { type: String, default: null },
    sentAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    paymentTermsDays: { type: Number, required: true, min: 0, default: 7 },

    /* ── Money. `Decimal128`, never a float (§6A.10 #1). ─────────────── */
    subtotalExGst: { type: Schema.Types.Decimal128, required: true },
    gst: { type: Schema.Types.Decimal128, required: true },
    totalIncGst: { type: Schema.Types.Decimal128, required: true },

    /* ── Presentation (M7.4, M7.5) ───────────────────────────────────── */
    /**
     * The template's NAME as it read when this invoice was rendered.
     *
     * ⚠️ A frozen copy, not a reference. Renaming a template, recolouring it
     * or deleting it outright must not change what an invoice already sent
     * says it was printed on — the customer is holding the version that
     * disagrees.
     */
    templateName: { type: String, required: true, trim: true, default: 'Standard' },
    /** REFERENCE → `invoicetemplates._id`. Null until the PDF is rendered. */
    templateId: { type: String, default: null, ref: 'InvoiceTemplate' },

    /**
     * Storage key for the rendered PDF (M7.6). Null until one exists.
     *
     * ── Why the document is STORED and not re-rendered on demand ─────────
     * Re-rendering would read today's branding, today's template and today's
     * settings, so an invoice reprinted a year later could come back looking
     * different from the one in the builder's filing system — different bank
     * details, a different logo, a different colour. The bytes that were sent
     * are the record. A reissue writes a NEW key rather than overwriting this
     * one.
     */
    pdfKey: { type: String, default: null },
    pdfRenderedAt: { type: Date, default: null },

    notes: { type: String, required: false, default: '', trim: true },

    /**
     * I1 Xero — scoped honestly as two-way: invoices and contacts out, payment
     * status in.
     *
     * `unknown` is not laziness. Their current invoice list genuinely shows
     * "Unknown" for several customers because the existing sync only partly
     * works, and modelling the broken state is what makes fixing it visible.
     */
    xeroState: { type: String, required: true, enum: XERO_SYNC_STATES, default: 'not-synced' },
    xeroLastSyncAt: { type: Date, default: null },
    xeroMessage: { type: String, default: null },
    /** Xero's own id, so a retry updates rather than creating a duplicate. */
    xeroInvoiceId: { type: String, default: null },

    /*
     * M7.3 — chasing the purchase order that unblocks this invoice.
     *
     * The awaiting-PO queue exists to produce a phone call, so its ageing has
     * to be measured against the last CONTACT rather than against the approval
     * date. Without these, a row chased yesterday looks identical to one nobody
     * has touched in three months — and the three-month one is the money.
     */
    lastChasedAt: { type: Date, default: null },
    chaseCount: { type: Number, required: true, min: 0, default: 0 },
  },
  { collection: INVOICES_COLLECTION, timestamps: true, versionKey: false },
);

/** The number quoted in a builder's AP system. A duplicate is unresolvable. */
invoiceSchema.index({ invoiceNumber: 1 }, { unique: true, name: 'invoice_number_unique' });

/**
 * ⚠️ At most ONE invoice of each kind per job.
 *
 * The guard against the failure that matters here: a retried completion, or two
 * office staff clicking at once, billing the customer twice for the same
 * pickup. Partial, because `jobId` is nullable and Mongo would otherwise treat
 * every null as a collision.
 */
invoiceSchema.index(
  { jobId: 1, kind: 1 },
  {
    unique: true,
    name: 'job_kind_unique',
    partialFilterExpression: { jobId: { $type: 'objectId' } },
  },
);

/** The invoice grid, and the awaiting-PO queue that money leaks through. */
invoiceSchema.index({ status: 1, issuedOn: -1 }, { name: 'status_issued' });

/** One customer's invoices — the portal's only query. */
invoiceSchema.index({ accountId: 1, issuedOn: -1 }, { name: 'account_issued' });

/** The Xero retry sweep. Partial, so it stays small. */
invoiceSchema.index(
  { xeroLastSyncAt: 1 },
  { name: 'xero_failed', partialFilterExpression: { xeroState: 'failed' } },
);

invoiceSchema.index(
  { accountName: 'text', poNumber: 'text' },
  { name: 'invoice_search' },
);

export const InvoiceModel = model('Invoice', invoiceSchema);

/**
 * One line on an invoice.
 *
 * ── Why lines are frozen copies, not references to job charges ────────────
 * A charge on a job can be edited, re-approved or removed. An invoice line
 * cannot: once the document has gone to a builder's accounts department, what
 * it said is a fact about what was billed. Pointing at a live charge would let
 * a later edit silently rewrite an invoice that has already been paid.
 *
 * `quantity × unitRate = amount` is a functional GAIN over TransVirtual, which
 * cannot render quantities — Matt wants "2 residential recycling bags at $30
 * each, equalling $60".
 */
const invoiceLineSchema = new Schema(
  {
    /** REFERENCE → `invoices._id`. */
    invoiceId: { type: Schema.Types.ObjectId, required: true, ref: 'Invoice' },
    description: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true },
    unitRate: { type: Schema.Types.Decimal128, required: true },
    amount: { type: Schema.Types.Decimal128, required: true },
    /**
     * Who raised the underlying charge — set on additional-charges lines so the
     * driver's evidence stays traceable from the invoice back to the photo.
     */
    raisedBy: { type: String, default: null, trim: true },
    /** REFERENCE → `jobcharges._id`, for that trace. Null on a computed line. */
    sourceChargeId: { type: Schema.Types.ObjectId, default: null, ref: 'JobCharge' },
    /** Keeps the printed order stable across reads. */
    position: { type: Number, required: true, min: 0, default: 0 },
  },
  { collection: INVOICE_LINES_COLLECTION, timestamps: true, versionKey: false },
);

invoiceLineSchema.index({ invoiceId: 1, position: 1 }, { name: 'invoice_position' });

export const InvoiceLineModel = model('InvoiceLine', invoiceLineSchema);
