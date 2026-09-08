import { Schema, model } from 'mongoose';

export const READINESS_CERTIFICATIONS_COLLECTION = 'readinesscertifications';
export const CHANGE_REQUESTS_COLLECTION = 'changerequests';

/**
 * M5.2 — the customer's certification that a job is ready.
 *
 * ── Why this is its own record, and why three booleans ────────────────────
 * Because the futile charge stands or falls on it. Today the equivalent is a
 * typed name in a text box; this is a named authenticated user promising three
 * specific things at a recorded moment:
 *
 *   *"David Chen, GJ Gardner, certified on 12 Aug at 14:32 that this job would
 *   be ready"*
 *
 * That is only defensible if what he certified is recorded SEPARATELY from what
 * he did not. One checkbox would collapse three different promises into one,
 * and the driver arrives to find the board stacked but the gate padlocked —
 * which of the three was broken decides whether the charge sticks.
 *
 * ⚠️ Append-only. A re-certification writes a NEW row rather than updating the
 * old one: the question an invoice dispute asks is "what did they promise, and
 * when", and an editable record cannot answer it.
 */
const readinessCertificationSchema = new Schema(
  {
    /** REFERENCE → `jobs._id`. */
    jobId: { type: Schema.Types.ObjectId, required: true, ref: 'Job' },

    /**
     * The three promises, each stored separately.
     *
     * All three must be true to book — that is the point of asking.
     */
    jobReady: { type: Boolean, required: true },
    truckAccessible: { type: Boolean, required: true },
    freeOfContaminants: { type: Boolean, required: true },

    certifiedAt: { type: Date, required: true, default: Date.now },
    /**
     * REFERENCE → `users._id`, plus the name and company frozen alongside.
     *
     * Frozen because the record has to survive the person leaving the builder.
     * A certification that reads "user 6a9f…" two years later is not evidence.
     */
    certifiedByUserId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    certifiedByName: { type: String, required: true, trim: true },
    certifiedByCompany: { type: String, required: true, trim: true },
  },
  {
    collection: READINESS_CERTIFICATIONS_COLLECTION,
    timestamps: true,
    versionKey: false,
  },
);

/** Newest first — the current promise is the one that counts. */
readinessCertificationSchema.index({ jobId: 1, certifiedAt: -1 }, { name: 'job_certified' });

export const ReadinessCertificationModel = model(
  'ReadinessCertification',
  readinessCertificationSchema,
);

/**
 * M5.4 — a change the customer wants on a job that is already allocated.
 *
 * ── Why an allocated job cannot just be edited ────────────────────────────
 * The client's own rule: a job is freely editable until it is on a run sheet.
 * After that the driver has it, the day is planned around it, and a silent edit
 * would change the work under somebody already holding it — the same reasoning
 * that freezes a run's stops once it is assigned.
 *
 * So the change becomes a REQUEST. The office sees it, decides, and acts. That
 * is slower for the customer and correct for the operation.
 */
const changeRequestSchema = new Schema(
  {
    /** REFERENCE → `jobs._id`. */
    jobId: { type: Schema.Types.ObjectId, required: true, ref: 'Job' },
    /** REFERENCE → `accounts._id`, so the office can filter by customer. */
    accountId: { type: Schema.Types.ObjectId, required: true, ref: 'Account' },

    kind: { type: String, required: true, enum: ['reschedule', 'cancel', 'other'] },
    /** Only meaningful on a reschedule. Null otherwise. */
    requestedDate: { type: String, default: null },
    note: { type: String, required: true, trim: true },

    /** REFERENCE → `users._id`, plus the name frozen for the record. */
    requestedByUserId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    requestedByName: { type: String, required: true, trim: true },
    requestedAt: { type: Date, required: true, default: Date.now },

    /**
     * `open` IS the queue. The office resolving it is what closes it.
     *
     * Not auto-applied: a reschedule the customer asked for may collide with a
     * run that is already staffed, and only the allocator can see that.
     */
    state: { type: String, required: true, enum: ['open', 'actioned', 'declined'], default: 'open' },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: String, default: null, trim: true },
    resolutionNote: { type: String, default: null, trim: true },
  },
  { collection: CHANGE_REQUESTS_COLLECTION, timestamps: true, versionKey: false },
);

/** The office's worklist: everything open, oldest first. Partial, so it stays small. */
changeRequestSchema.index(
  { requestedAt: 1 },
  { name: 'open_requests', partialFilterExpression: { state: 'open' } },
);

changeRequestSchema.index({ jobId: 1, requestedAt: -1 }, { name: 'job_requested' });
changeRequestSchema.index({ accountId: 1, state: 1 }, { name: 'account_state' });

export const ChangeRequestModel = model('ChangeRequest', changeRequestSchema);
