import {
  BRAND_IDS,
  CHARGE_APPROVAL_STATES,
  CHARGE_CODES,
  CHARGE_SOURCES,
  COMMENT_VISIBILITIES,
  EXCEPTION_REASONS,
  FREIGHT_ITEMS,
  JOB_STATUSES,
  SERVICE_LEVELS,
  SRA_STEP_STATES,
  WEIGHT_BASES,
  ZONES,
} from '@plastago/shared';
import { Schema, model } from 'mongoose';

export const JOBS_COLLECTION = 'jobs';
export const JOB_CHARGES_COLLECTION = 'jobcharges';
export const JOB_EVENTS_COLLECTION = 'jobevents';
export const JOB_PHOTOS_COLLECTION = 'jobphotos';
export const JOB_DOCUMENTS_COLLECTION = 'jobdocuments';
export const JOB_COMMENTS_COLLECTION = 'jobcomments';
export const JOB_PRE_STARTS_COLLECTION = 'jobprestarts';
export const JOB_RISK_ASSESSMENTS_COLLECTION = 'jobriskassessments';

/**
 * A job — one pickup at one address.
 *
 * ── Two kinds of "denormalised", and only one of them is a shortcut ───────
 * Every RELATIONSHIP here is an id into its own collection: `accountId`,
 * `driverId`, `bookedByUserId`, `brandId`. Charges, events, photos, documents,
 * comments and the two compliance records are their own collections keyed by
 * `jobId`, never arrays on this document. A job accumulates events and charges
 * for its whole life, and an array that grows without bound is a document that
 * eventually stops fitting — and one that has to be rewritten in full to append
 * a single row.
 *
 * The ADDRESS is different, and its copying is deliberate. There is no Site
 * record behind it at all:
 *
 *   Matt, 0:29: *"sites is its own section and then jobs seem to be assigned to
 *   a site. I don't really think that's necessary — the job should just have the
 *   site on it as part of the details for the job."*
 *
 *   And on why (3:28): *"we don't ever really visit a site more than once… they
 *   build them, we go there, we collect the stuff, we move on and someone moves
 *   into that."*
 *
 * He is describing greenfield housing: a site is a house being built, and once
 * somebody lives in it there is never another pickup. A reusable Site record
 * models a permanence this business does not have. So the address is not a copy
 * of a row that exists elsewhere — it is the only record of where the truck
 * went, frozen on the day.
 *
 * `accountName` and `driverName` ARE copies, and they are here for the same
 * freezing reason plus one practical one: the jobs grid is the screen the office
 * lives in, and a list must not need a join to render a row.
 *
 * ⚠️ A string that may legitimately be EMPTY is `required: false` with
 * `default: ''`, never `required: true`. Mongoose's `required` validator counts
 * `''` as missing, so a required-with-empty-default field rejects the exact
 * value it defaults to — and a booking with no access notes, which is most of
 * them, fails with a 500. Found in QA doing precisely that.
 */
const jobSchema = new Schema(
  {
    /**
     * M1.4 — continues the TransVirtual sequence from ~61,300.
     *
     * Unique, because the number is quoted in builders' AP systems and two jobs
     * answering to one is a reconciliation nobody can unpick. Allocated by
     * `settingsRepository.takeNextNumber`, which is atomic.
     */
    jobNumber: { type: Number, required: true, min: 1 },
    status: { type: String, required: true, enum: JOB_STATUSES, default: 'booked' },

    /* ── References ──────────────────────────────────────────────────── */
    /** REFERENCE → `accounts._id`. Who gets invoiced. */
    accountId: { type: Schema.Types.ObjectId, required: true, ref: 'Account' },
    /** Frozen copy, so the grid renders without a join and history stays true. */
    accountName: { type: String, required: true, trim: true },
    /** REFERENCE → `brands._id`. Which letterhead the invoice carries. */
    brandId: { type: String, required: true, enum: BRAND_IDS, ref: 'Brand' },

    /**
     * The builder on site, as a NAME (M1.2).
     *
     * Not a reference: iPlasta is invoiced while GJ Gardner is the builder on
     * the ground, and the builder is a property of the work rather than of the
     * account. There is no builder register to point at — the name is what is
     * known, and it is what the driver needs at the gate.
     */
    builderName: { type: String, required: false, trim: true, default: '' },

    /* ── The address, frozen on the job. See the note above. ─────────── */
    siteName: { type: String, required: true, trim: true },
    /**
     * Load-bearing in a half-built estate: the street number does not exist yet
     * and the lot is how the site is identified on the ground.
     */
    lotNumber: { type: String, default: null, trim: true },
    addressLine: { type: String, required: true, trim: true },
    suburb: { type: String, required: true, trim: true },
    postcode: { type: String, required: true, trim: true },
    /**
     * Decides the rate (M6.3) — resolved from the chosen place, NEVER typed.
     *
     * Frozen here so a job priced in March keeps March's zone even if the
     * suburb is later re-zoned.
     */
    zone: { type: String, required: true, enum: ZONES },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },

    /**
     * Where the pin above came from (I3).
     *
     * ── Why the provenance is stored and not inferred ─────────────────────
     * A latitude is a latitude: nothing about the number says whether it is the
     * house or the middle of the suburb, and the two are kilometres apart. The
     * run optimiser must not order stops that are all pinned to suburb centres
     * — it would return a confident ordering of points nobody is driving to —
     * and this is the only field that can tell it.
     *
     * `suburb` is the honest default and what every job booked before the
     * geocoder existed carries. Jobs are never back-filled in place: a job's
     * address is frozen at booking on purpose (see the note at the top of this
     * model), so a backfill is a deliberate, separate act.
     */
    locationSource: {
      type: String,
      required: true,
      enum: ['suburb', 'geocoded'],
      default: 'suburb',
    },

    /* ── Getting a truck in ──────────────────────────────────────────── */
    accessNotes: { type: String, required: false, default: '', trim: true },
    gateHours: { type: String, default: null, trim: true },
    inductionRequired: { type: Boolean, required: true, default: false },
    craneAvailable: { type: Boolean, required: true, default: false },
    siteContactName: { type: String, default: null, trim: true },
    siteContactMobile: { type: String, default: null, trim: true },
    /**
     * Where this job's completion photos go, on top of the account's contacts.
     * Matt, 14:16 — often the builder's supervisor, who has no login here.
     */
    siteContactEmail: { type: String, default: null, trim: true },

    /**
     * The customer's own reference — PO number, job number, whatever they use.
     *
     * ── One field, not two ──────────────────────────────────────────────
     * Matt, 9:08: *"customer reference and purchase order number… they're really
     * interchangeable… **They are one and the same, we don't need both of
     * them.**"*
     *
     * Named `poNumber` and printed as the PO deliberately — 9:56: *"if we don't
     * list PO on the invoice, then sometimes I have trouble getting paid."*
     */
    poNumber: { type: String, default: null, trim: true },

    /**
     * REFERENCE → `purchaseorders._id` (M2.12). Null on a job with no order.
     *
     * ── Why the job points at the order and not the reverse ───────────────
     * A purchase order exists for months before any job does (Matt, 28:40), and
     * it is the job that is created knowing which order it fulfils. Pointing
     * from the child keeps both "which order is this job against" and "has this
     * order been used" a single indexed query.
     *
     * ⚠️ The order's FIGURES are not read back through this reference at
     * invoice time. `expectedAreaM2`, `bagCount` and `poNumber` are copied onto
     * the job at creation and frozen there, like the zone and the rate — an
     * order corrected next year must not silently re-price a job that has
     * already been collected and invoiced. This reference is the audit trail,
     * not a live lookup.
     */
    purchaseOrderId: { type: Schema.Types.ObjectId, default: null, ref: 'PurchaseOrder' },

    /* ── Who raised it ───────────────────────────────────────────────── */
    /**
     * A NAME, denormalised, because it has to survive the person leaving: a job
     * booked in 2026 by a supervisor who is off the account by 2027 must still
     * say who booked it.
     */
    bookedByName: { type: String, default: null, trim: true },
    /**
     * REFERENCE → `users._id`. This is an AUTHORISATION field, not a display one.
     *
     * ⚠️ Until sites were removed, a site supervisor was scoped by the sites
     * assigned to them (M1.5) — that is what stopped Clarendon's supervisor
     * seeing Domaine's work. With no site records there is nothing left to scope
     * on, so the boundary moves to "the jobs this person raised".
     *
     * Null on office-keyed jobs, and a null is invisible to every supervisor —
     * which is the safe direction.
     */
    bookedByUserId: { type: Schema.Types.ObjectId, default: null, ref: 'User' },
    bookedBySource: { type: String, enum: ['portal', 'office', 'call-up'], default: null },

    /* ── Dates ───────────────────────────────────────────────────────── */
    /** Stored as a plain `YYYY-MM-DD` string: a ready date is a calendar day,
     *  not an instant, and giving it a timezone is how it drifts by one. */
    readyDate: { type: String, required: true },
    /** M2.4a — ready date plus the SLA in BUSINESS days. */
    targetDate: { type: String, required: true },
    serviceLevel: { type: String, required: true, enum: SERVICE_LEVELS, default: 'standard' },

    /* ── Allocation (M3) ─────────────────────────────────────────────── */
    /**
     * REFERENCE → `runs._id`. The run this job is a stop on.
     *
     * The reference points from the child to the parent, which is what keeps
     * both "which jobs are on this run" and "which run is this job on" a single
     * indexed query. An array of stop ids on the run would have to be rewritten
     * in full to move one stop, and could disagree with the jobs themselves.
     */
    runId: { type: Schema.Types.ObjectId, default: null, ref: 'Run' },
    /** Position within the run. Rewritten wholesale when the route is optimised. */
    runSequence: { type: Number, default: null, min: 1 },
    /**
     * REFERENCE → `users._id`.
     *
     * Propagated from the run when it is staffed, not set directly: a driver
     * takes whole runs (Matt, 40:03). It is copied onto the stop so the driver
     * app can ask "my jobs today" without joining through runs.
     */
    driverId: { type: Schema.Types.ObjectId, default: null, ref: 'User' },
    driverName: { type: String, default: null, trim: true },

    /* ── Quantities ──────────────────────────────────────────────────── */
    /**
     * ⚠️ Null is not zero, and the difference is money.
     *
     * Matt, 31:04, on the Wisdom PO: *"we're on a fixed price with them. So they
     * don't actually give us square metres… they just give us a line item."* A
     * builder's supervisor booking a pickup does not know it either (29:21).
     *
     * Zero would price the job at the call-out fee alone AND silently drop the
     * stop out of the m²-weighted tip-off split — handing its share of recovered
     * tonnage to everyone else on the run, on a figure that ends up on a
     * diversion certificate.
     */
    expectedAreaM2: { type: Number, default: null, min: 0 },
    recoveredWeightKg: { type: Number, default: null, min: 0 },
    /**
     * M4.3, Matt 56:11 — whether that weight was measured or worked out.
     * Carried as a field rather than inferred, and null where there is no weight.
     */
    recoveredWeightBasis: { type: String, enum: WEIGHT_BASES, default: null },
    bagCount: { type: Number, required: true, min: 0, default: 0 },
    /**
     * M4.3, Matt 07:37 — how many bags the driver actually found on site.
     *
     * ⚠️ Separate from `bagCount`, which is the allowance the purchase order
     * authorised and which the base invoice is priced on. The driver's figure
     * used to be written over the top of it, which destroyed the only record of
     * what was ordered — and with it any way to tell that a job with two bags
     * on its PO came back with four. Matt, 08:28: *"anything over that original
     * PO needs to get sent off for approval."*
     *
     * Null until the weights screen is saved. Null is not zero: zero is a
     * bagged job the driver found nothing on.
     */
    collectedBagCount: { type: Number, default: null, min: 0 },
    /**
     * M4.3, Matt 06:34 — the crane reading for each bag, in lift order.
     *
     * `recoveredWeightKg` above stays the authoritative TOTAL, because that is
     * what gets priced, invoiced and printed on a diversion certificate. This is
     * the breakdown behind it, kept so a disputed docket can be answered bag by
     * bag instead of with one aggregate figure.
     *
     * ⚠️ Empty on a hand load (nothing was lifted) and empty on any job weighed
     * before per-bag capture shipped. An empty array therefore does NOT mean
     * "zero kilograms" — read `recoveredWeightKg` for the weight.
     */
    bagWeights: { type: [Number], default: [] },
    freightItem: { type: String, required: true, enum: FREIGHT_ITEMS },

    /* ── Money. `Decimal128`, never a float (§6A.10 #1). ─────────────── */
    totalExGst: { type: Schema.Types.Decimal128, required: true },
    gst: { type: Schema.Types.Decimal128, required: true },
    totalIncGst: { type: Schema.Types.Decimal128, required: true },

    /**
     * ⚠️ M6.2 — the rates AS APPLIED, frozen at the moment this job was priced.
     *
     * ── Why the totals above are not enough ───────────────────────────────
     * They say what the job came to; they do not say how. "Why is this $416?"
     * needs the call-out fee and the per-m² rate that produced it, and once
     * rates are effective-dated the only honest source for those is a copy
     * taken when the job was priced. Recomputing from the rate tables would
     * hand back today's schedule for a job raised last March, and re-deriving
     * a credit note that way is how a customer gets refunded at the wrong rate.
     *
     * So this is deliberately DENORMALISED and deliberately never updated. It
     * survives the schedule that produced it being superseded, and it survives
     * the whole rate card being deleted — which is what lets an administrator
     * retire a card without rewriting history.
     *
     * `null` on jobs created before snapshots existed. Readers must treat that
     * as "unknown", never fall back to a live lookup: a silent live lookup is
     * exactly the reprice this field exists to prevent.
     */
    appliedRate: {
      type: new Schema(
        {
          rateCardId: { type: String, required: true },
          /** The card's name as it read then, so a reprint is not a slug. */
          rateCardLabel: { type: String, required: true },
          zone: { type: String, required: true, enum: ZONES },
          /** Which dated schedule priced it. Traces a figure to a decision. */
          scheduleFrom: { type: String, required: true },
          serviceCharge: { type: Schema.Types.Decimal128, required: true },
          ratePerM2: { type: Schema.Types.Decimal128, required: true },
        },
        { _id: false },
      ),
      default: null,
    },

    /* ── Invoicing (M7) ──────────────────────────────────────────────── */
    invoiceStatus: {
      type: String,
      required: true,
      enum: ['not-invoiced', 'awaiting-po', 'invoiced', 'paid'],
      default: 'not-invoiced',
    },
    invoiceNumber: { type: Number, default: null, min: 1 },
    invoicedAt: { type: Date, default: null },

    /* ── Outcome ─────────────────────────────────────────────────────── */
    notes: { type: String, required: false, default: '', trim: true },
    /** M2.4 — cancel and futile carry a STRUCTURED reason, never free text. */
    exceptionReason: { type: String, enum: EXCEPTION_REASONS, default: null },
    exceptionNote: { type: String, default: null, trim: true },
    /** M4.2 — Arrived → Complete is the logged on-site duration. */
    arrivedAt: { type: Date, default: null },
    onSiteMinutes: { type: Number, default: null, min: 0 },
    completedAt: { type: Date, default: null },

    /**
     * M4.8b — the account's rule, RESOLVED AT CREATION and then frozen.
     *
     * ⚠️ Not read live from the account later. A job booked today under today's
     * rule must still show today's rule when it is audited next year; re-deriving
     * it would let a settings change rewrite the past and make a compliant job
     * look like a gap.
     *
     * The records themselves live in their own collections — this is only the
     * obligation, which is a scalar and belongs with the job it binds.
     */
    riskAssessmentRequired: { type: Boolean, required: true, default: false },
  },
  { collection: JOBS_COLLECTION, timestamps: true, versionKey: false },
);

/** The number builders quote. A duplicate is a reconciliation nobody can unpick. */
jobSchema.index({ jobNumber: 1 }, { unique: true, name: 'job_number_unique' });

/*
 * The office's working set: the board filters by status and sorts by the date
 * the job is due. This is the index that keeps the main grid a single seek.
 */
jobSchema.index({ status: 1, targetDate: 1 }, { name: 'status_target' });

/** A customer's own jobs, newest first — the portal's only query. */
jobSchema.index({ accountId: 1, createdAt: -1 }, { name: 'account_recent' });

/** A site supervisor's scope. See the warning on `bookedByUserId`. */
jobSchema.index({ bookedByUserId: 1, createdAt: -1 }, { name: 'booked_by_recent' });

/** The driver's run for a day, and the dispatch board's allocation column. */
jobSchema.index({ driverId: 1, readyDate: 1 }, { name: 'driver_ready' });

/** A run's stops, already in the order the driver will work them. */
jobSchema.index({ runId: 1, runSequence: 1 }, { name: 'run_sequence' });

/**
 * The allocation board's left-hand column: what is waiting to go on a run.
 *
 * `runId: null` is the whole question the allocator asks every morning, so it
 * is the leading key rather than a filter applied after the fact.
 */
jobSchema.index({ runId: 1, readyDate: 1, status: 1 }, { name: 'unallocated_ready' });

/** Invoicing sweeps by state (M7.2), including the awaiting-PO backlog. */
jobSchema.index({ invoiceStatus: 1, completedAt: -1 }, { name: 'invoice_state' });

/**
 * M6.2 — "has this rate card already priced something that was invoiced?"
 *
 * Asked before a schedule is back-dated, and before a card is deleted. Sparse
 * because jobs raised before rate snapshots existed carry no `appliedRate`, and
 * indexing thousands of nulls buys nothing.
 */
jobSchema.index(
  { 'appliedRate.rateCardId': 1, readyDate: 1 },
  { name: 'applied_card_ready', sparse: true },
);

/**
 * ⚠️ One job per purchase order.
 *
 * Wisdom's order states it in capitals: *"ONE PURCHASE ORDER NUMBER ONLY PER TAX
 * INVOICE."* An invoice is raised per job, so a second job against one order
 * produces a second invoice quoting a number the builder's accounts system has
 * already matched and closed — which is rejected weeks later with no
 * explanation.
 *
 * Partial on the field being an ObjectId, because most jobs carry no order and
 * Mongo would otherwise treat every one of those nulls as a collision.
 */
jobSchema.index(
  { purchaseOrderId: 1 },
  {
    unique: true,
    name: 'purchase_order_unique',
    partialFilterExpression: { purchaseOrderId: { $type: 'objectId' } },
  },
);

jobSchema.index({ zone: 1, readyDate: 1 }, { name: 'zone_ready' });

/**
 * Free-text search across the fields the office actually types into the box:
 * the site, the account, the builder, the suburb and the customer's own PO.
 */
jobSchema.index(
  { siteName: 'text', accountName: 'text', builderName: 'text', suburb: 'text', poNumber: 'text' },
  { name: 'job_search' },
);

export const JobModel = model('Job', jobSchema);

/**
 * One invoice line (M6.5–M6.7).
 *
 * Its own collection, not an array on the job: a charge is approved, rejected
 * and reported on independently, and "every pending charge across all jobs" is
 * the queue the office works from (M2.7). That is a query here and a full
 * collection scan if these were embedded.
 */
const jobChargeSchema = new Schema(
  {
    /** REFERENCE → `jobs._id`. */
    jobId: { type: Schema.Types.ObjectId, required: true, ref: 'Job' },
    code: { type: String, required: true, enum: CHARGE_CODES },
    description: { type: String, required: true, trim: true },
    /** `quantity × unitRate = amount` — a gain over TransVirtual, which cannot
     *  render quantities. Matt wants "2 bags at $30 each, equalling $60". */
    quantity: { type: Number, required: true },
    unitRate: { type: Schema.Types.Decimal128, required: true },
    amount: { type: Schema.Types.Decimal128, required: true },
    source: { type: String, required: true, enum: CHARGE_SOURCES },
    /**
     * M2.7 — a driver reports contamination from the fence; the office approves
     * before it can reach an invoice.
     */
    approvalState: {
      type: String,
      required: true,
      enum: CHARGE_APPROVAL_STATES,
      default: 'not-required',
    },
    raisedBy: { type: String, default: null, trim: true },
    raisedAt: { type: Date, required: true, default: Date.now },
    photoCount: { type: Number, required: true, min: 0, default: 0 },
    /**
     * What the DRIVER said they saw. Never overwritten by the office.
     *
     * The approval path used to `$set` the office’s reason straight over this
     * field, destroying the only first-hand account of the contamination the
     * charge is for — and the customer disputes the charge, not the decision.
     */
    note: { type: String, default: null, trim: true },
    /**
     * Who approved or rejected it, when, and why (M2.7).
     *
     * A charge becoming billable is a money decision, and until now it left no
     * trace of who made it: `decideCharges` took a `decidedBy` argument and
     * never wrote it anywhere. `decisionNote` is the office’s reason, kept
     * apart from the driver’s note above so neither voice overwrites the other.
     */
    decidedBy: { type: String, default: null, trim: true },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: null, trim: true },
  },
  { collection: JOB_CHARGES_COLLECTION, timestamps: true, versionKey: false },
);

jobChargeSchema.index({ jobId: 1, raisedAt: 1 }, { name: 'job_raised' });
/** The approvals queue (M2.7) — every pending charge, across every job. */
jobChargeSchema.index({ approvalState: 1, raisedAt: 1 }, { name: 'approval_queue' });

export const JobChargeModel = model('JobCharge', jobChargeSchema);

/** M2.3 — the timeline of what happened, with timestamps and actors. */
const jobEventSchema = new Schema(
  {
    /** REFERENCE → `jobs._id`. */
    jobId: { type: Schema.Types.ObjectId, required: true, ref: 'Job' },
    at: { type: Date, required: true, default: Date.now },
    label: { type: String, required: true, trim: true },
    actor: { type: String, required: false, default: '', trim: true },
    /** The status this event moved the job INTO. Null for non-status events. */
    status: { type: String, enum: JOB_STATUSES, default: null },
    detail: { type: String, default: null, trim: true },
    /** M4.2 — status changes captured on the driver app carry a position. */
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
  },
  { collection: JOB_EVENTS_COLLECTION, timestamps: true, versionKey: false },
);

jobEventSchema.index({ jobId: 1, at: 1 }, { name: 'job_at' });

export const JobEventModel = model('JobEvent', jobEventSchema);

/** Their photo protocol: front of site · pile before · pile after · site closed · cars on site. */
const jobPhotoSchema = new Schema(
  {
    /** REFERENCE → `jobs._id`. */
    jobId: { type: Schema.Types.ObjectId, required: true, ref: 'Job' },
    caption: { type: String, required: true, trim: true },
    /**
     * Which of the five required shots this is — 'front-of-site', 'pile-before'
     * and so on. Null for a free-form extra.
     *
     * Matt asked for *"a prompt of what's in the photos that are required, and a
     * space to put in any others"*, so the slot is data rather than a position
     * in an array: a photo retaken later must replace the right one.
     */
    slot: { type: String, default: null, trim: true },
    takenAt: { type: Date, required: true },
    takenBy: { type: String, required: false, default: '', trim: true },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    /** Where the bytes live. The API serves a URL; it does not store the image. */
    storageKey: { type: String, default: null },
  },
  { collection: JOB_PHOTOS_COLLECTION, timestamps: true, versionKey: false },
);

jobPhotoSchema.index({ jobId: 1, takenAt: 1 }, { name: 'job_taken' });

export const JobPhotoModel = model('JobPhoto', jobPhotoSchema);

const jobDocumentSchema = new Schema(
  {
    /** REFERENCE → `jobs._id`. */
    jobId: { type: Schema.Types.ObjectId, required: true, ref: 'Job' },
    name: { type: String, required: true, trim: true },
    kind: {
      type: String,
      required: true,
      enum: ['purchase-order', 'swms', 'risk-assessment', 'weighbridge-docket', 'other'],
    },
    uploadedAt: { type: Date, required: true, default: Date.now },
    uploadedBy: { type: String, required: false, default: '', trim: true },
    sizeKb: { type: Number, required: true, min: 1 },
    storageKey: { type: String, default: null },
  },
  { collection: JOB_DOCUMENTS_COLLECTION, timestamps: true, versionKey: false },
);

jobDocumentSchema.index({ jobId: 1, uploadedAt: 1 }, { name: 'job_uploaded' });
/** The PO backlog (M7.2) — finding the document that unblocks an invoice. */
jobDocumentSchema.index({ kind: 1, uploadedAt: -1 }, { name: 'kind_recent' });

export const JobDocumentModel = model('JobDocument', jobDocumentSchema);

/**
 * M2.11 / M8.6 — job-scoped comment threads.
 *
 * Three visibilities on one collection rather than three threads: `internal` is
 * office-only, `driver` is office ↔ the allocated driver and pushes to their
 * app, `customer` shows in the portal. Attaching the conversation to the job it
 * is about is what makes it auditable, which is the point of doing this instead
 * of a chat product (F20 is v1.1).
 */
const jobCommentSchema = new Schema(
  {
    /** REFERENCE → `jobs._id`. */
    jobId: { type: Schema.Types.ObjectId, required: true, ref: 'Job' },
    body: { type: String, required: true, trim: true },
    /** REFERENCE → `users._id`, plus the name frozen for display. */
    authorId: { type: Schema.Types.ObjectId, default: null, ref: 'User' },
    author: { type: String, required: true, trim: true },
    at: { type: Date, required: true, default: Date.now },
    visibility: { type: String, required: true, enum: COMMENT_VISIBILITIES },
    /**
     * M8.6 — "did they get it" is the first question anyone asks about a message
     * to somebody on the road. Null on internal and customer comments, which are
     * not pushed to an app.
     */
    deliveredAt: { type: Date, default: null },
    /** True when the driver wrote it, so the thread reads as a conversation. */
    fromDriver: { type: Boolean, required: true, default: false },
  },
  { collection: JOB_COMMENTS_COLLECTION, timestamps: true, versionKey: false },
);

jobCommentSchema.index({ jobId: 1, at: 1 }, { name: 'job_at' });
jobCommentSchema.index({ jobId: 1, visibility: 1 }, { name: 'job_visibility' });

export const JobCommentModel = model('JobComment', jobCommentSchema);

/**
 * M4.8 — the pre-start checklist, as its own record.
 *
 * One per job, so it could have been a field. It is a collection because it is
 * produced by a different actor at a different time from everything else on the
 * job, and because a Chain of Responsibility record is the kind of thing that
 * gets queried on its own ("show me every pre-start with a failed item").
 */
const jobPreStartSchema = new Schema(
  {
    /** REFERENCE → `jobs._id`. */
    jobId: { type: Schema.Types.ObjectId, required: true, ref: 'Job' },
    completedAt: { type: Date, required: true },
    /** REFERENCE → `users._id`, plus the name frozen for the audit record. */
    driverId: { type: Schema.Types.ObjectId, default: null, ref: 'User' },
    driverName: { type: String, required: true, trim: true },
    vehicleRego: { type: String, required: false, default: '', trim: true },
    odometerKm: { type: Number, required: true, min: 0 },
    /**
     * Only the items marked FAIL, with their note.
     *
     * A wall of green ticks is noise; the office is looking for the one line
     * that says the brakes felt soft. `itemsChecked` carries the denominator.
     *
     * Embedded rather than referenced, and deliberately: this is a fixed-size
     * snapshot of one form at one moment, not a growing relationship. It is
     * never queried alone and never updated after the fact.
     */
    failedItems: [
      {
        _id: false,
        key: { type: String, required: true },
        label: { type: String, required: true },
        note: { type: String, required: false, default: '' },
      },
    ],
    itemsChecked: { type: Number, required: true, min: 0 },
  },
  { collection: JOB_PRE_STARTS_COLLECTION, timestamps: true, versionKey: false },
);

/** One per job. A second would make "was the obligation met" ambiguous. */
jobPreStartSchema.index({ jobId: 1 }, { unique: true, name: 'job_unique' });

export const JobPreStartModel = model('JobPreStart', jobPreStartSchema);

/** M4.8b — the Site Risk Assessment, and where its five-step upload has got to. */
const jobRiskAssessmentSchema = new Schema(
  {
    /** REFERENCE → `jobs._id`. */
    jobId: { type: Schema.Types.ObjectId, required: true, ref: 'Job' },
    completedAt: { type: Date, required: true },
    driverId: { type: Schema.Types.ObjectId, default: null, ref: 'User' },
    driverName: { type: String, required: true, trim: true },
    /** Resolved to labels on write — the office should not need the key table. */
    hazards: [{ type: String }],
    controls: [{ type: String }],
    note: { type: String, required: false, default: '', trim: true },
    /** False means the driver judged the site unsafe and stopped. */
    safeToProceed: { type: Boolean, required: true, default: true },
    swmsVersion: { type: String, required: true, trim: true },
    /** Scanned off the site fence. Null where the site has no QR sign. */
    builderPortalCode: { type: String, default: null, trim: true },
    /** Step 5 — the handoff to the builder's own portal. */
    uploadState: { type: String, required: true, enum: SRA_STEP_STATES, default: 'pending' },
    /** The generated PDF, filed against this job. Null while it is being made. */
    documentId: { type: Schema.Types.ObjectId, default: null, ref: 'JobDocument' },
  },
  { collection: JOB_RISK_ASSESSMENTS_COLLECTION, timestamps: true, versionKey: false },
);

jobRiskAssessmentSchema.index({ jobId: 1 }, { unique: true, name: 'job_unique' });
/** The retry sweep for step 5 — everything still queued or failed. */
jobRiskAssessmentSchema.index({ uploadState: 1, completedAt: 1 }, { name: 'upload_state' });

export const JobRiskAssessmentModel = model('JobRiskAssessment', jobRiskAssessmentSchema);
