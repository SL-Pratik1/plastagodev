import { EXCEPTION_REASONS, FUTILE_OUTCOMES } from '@plastago/shared';
import { Schema, model } from 'mongoose';

export const FUTILE_REVIEWS_COLLECTION = 'futilereviews';

/**
 * M2.6 — the office's decision about a futile pickup.
 *
 * ── Why the decision is a record and not a field on the job ────────────────
 * Because it answers a different question from the job's own status. The job
 * says "this was futile"; this says "and here is what we did about it, who
 * decided, and when". The queue ages against `createdAt`, and an auditor asking
 * "how long did futile jobs sit unreviewed last quarter" needs the decision to
 * have its own timestamp rather than being inferred from a status that has since
 * moved on.
 *
 * ⚠️ The decision is about the JOB, never about the money. Matt was explicit
 * that *either way the futile fee applies* — the $120 was earned the moment the
 * truck arrived to a site that was not ready. So there is no "waive" outcome
 * here, and the UI must not imply one exists.
 */
const futileReviewSchema = new Schema(
  {
    /** REFERENCE → `jobs._id`. */
    jobId: { type: Schema.Types.ObjectId, required: true, ref: 'Job' },

    /** Why the driver could not collect. Structured, never free text (M2.4). */
    reason: { type: String, required: true, enum: EXCEPTION_REASONS },
    /** What the driver typed at the fence, if anything. */
    note: { type: String, default: null, trim: true },

    /**
     * When the DRIVER marked it — the clock this queue ages against.
     *
     * Not `createdAt`: on a phone that synced hours later those differ, and the
     * age that matters to a customer waiting for a call is the one from when it
     * actually happened.
     */
    markedAt: { type: Date, required: true },

    /** `pending` IS the queue. Everything else has left it. */
    outcome: { type: String, required: true, enum: FUTILE_OUTCOMES, default: 'pending' },

    /* ── The decision, once somebody makes it ────────────────────────── */
    /** Free-text context the office added. Never the reason itself. */
    decisionNote: { type: String, default: null, trim: true },
    decidedAt: { type: Date, default: null },
    /** REFERENCE → `users._id`, plus the name frozen for the audit record. */
    decidedByUserId: { type: Schema.Types.ObjectId, default: null, ref: 'User' },
    decidedBy: { type: String, default: null, trim: true },
    /** Set when the outcome was `rescheduled`. */
    newReadyDate: { type: String, default: null },
  },
  { collection: FUTILE_REVIEWS_COLLECTION, timestamps: true, versionKey: false },
);

/**
 * One review per job. A driver replaying a queued futile report must not open a
 * second review, and the office deciding twice is a contradiction rather than an
 * update.
 */
futileReviewSchema.index({ jobId: 1 }, { unique: true, name: 'job_unique' });

/**
 * The queue itself: everything pending, oldest first.
 *
 * Partial, so the index holds only the rows still in the queue rather than every
 * futile job PlastaGo has ever had.
 */
futileReviewSchema.index(
  { markedAt: 1 },
  { name: 'pending_by_age', partialFilterExpression: { outcome: 'pending' } },
);

export const FutileReviewModel = model('FutileReview', futileReviewSchema);
