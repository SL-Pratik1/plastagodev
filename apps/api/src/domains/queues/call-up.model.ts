import { CALL_UP_KINDS, CALL_UP_REVIEW_REASONS, CALL_UP_SOURCES, CALL_UP_STATES } from '@plastago/shared';
import { Schema, model } from 'mongoose';

export const CALL_UPS_COLLECTION = 'callups';

/**
 * The call-up — the message that actually schedules the work (M2.12b).
 *
 * ── Why this is stored at all, rather than just applied ───────────────────
 * A call-up could be a function: read the date, move the job, forget the
 * message. It is a record instead for three reasons, and all three come from
 * how Matt actually receives them.
 *
 *  1. **They arrive twice.** The vendor retries a webhook on any non-2xx, and
 *     the builder's system resends. Without a stored row keyed on the external
 *     id, one email schedules a job, then reschedules it to the same day, then
 *     does it again — and the audit trail says three people booked it.
 *
 *  2. **They arrive wrong.** A call-up naming a PO nobody has on file is still
 *     a real email about real work. Dropping it means the job never happens and
 *     nothing anywhere says why. Stored unmatched, it becomes a queue item with
 *     a reason on it.
 *
 *  3. **They contradict each other.** Matt, 24:07: a green reschedule follows a
 *     blue booking days later, and the *order they were received in* is what
 *     decides which date is current. That question cannot be answered from the
 *     job alone.
 *
 * ── Why it is not part of the purchase order ──────────────────────────────
 * One order can be called up, rescheduled twice and cancelled. Those are four
 * events, and folding them into the order would keep only the last one.
 */
const callUpSchema = new Schema(
  {
    /**
     * REFERENCE → `purchaseorders._id`, once matched.
     *
     * ⚠️ Null on an unmatched call-up, which is a normal queue state and not a
     * failure — see reason 2 above.
     */
    purchaseOrderId: { type: Schema.Types.ObjectId, default: null, ref: 'PurchaseOrder' },
    /**
     * The number exactly as it arrived.
     *
     * The only handle on an unmatched call-up, so it is required even where the
     * order is not found. Indexed, because matching by it is the hot path.
     */
    poNumber: { type: String, required: true, trim: true },
    accountId: { type: Schema.Types.ObjectId, default: null, ref: 'Account' },
    accountName: { type: String, default: null, trim: true },

    receivedAt: { type: Date, required: true },
    source: { type: String, required: true, enum: CALL_UP_SOURCES },
    kind: { type: String, required: true, enum: CALL_UP_KINDS },

    /**
     * The date the work is ready. Null on a cancellation, which names none.
     *
     * A plain `YYYY-MM-DD` string, like every other date the board plans
     * against: a ready date is a calendar day, and giving it a timezone is how
     * it drifts by one (see `lib/business-day.ts`).
     */
    readyDate: { type: String, default: null },
    /** What it moved from, on a reschedule. Context, not a key. */
    previousReadyDate: { type: String, default: null },

    state: { type: String, required: true, enum: CALL_UP_STATES, default: 'needs-review' },
    reason: { type: String, default: null, enum: [...CALL_UP_REVIEW_REASONS, null] },

    /** The job this produced or changed. Null while it is unapplied. */
    jobId: { type: Schema.Types.ObjectId, default: null, ref: 'Job' },
    jobNumber: { type: Number, default: null },
    note: { type: String, default: '', trim: true },

    /**
     * REFERENCE → the vendor's extraction id, where this came from an email.
     *
     * ⚠️ The idempotency key. Unique where present, so a retried webhook cannot
     * produce a second call-up for one email — see reason 1 above. Null for one
     * raised in the portal or over the phone, and a sparse index is what lets
     * many of those coexist.
     */
    /**

    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: String, default: null, trim: true },
    /** Who raised it, for a portal or phone call-up. */
    raisedBy: { type: String, default: null, trim: true },
  },
  { collection: CALL_UPS_COLLECTION, timestamps: true, versionKey: false },
);

/**
 * ⚠️ One call-up per extraction, enforced by the database.
 *
 * ── Why PARTIAL and not `sparse` ──────────────────────────────────────────
 * This was `sparse`, with a comment saying it had to be so that the many
 * call-ups with no external id could coexist. `sparse` does not do that: it
 * skips documents where the field is ABSENT, and an explicitly stored `null`
 * is a value it indexes like any other. The service writes `externalId: null`
 * for anything keyed in by hand or raised from the portal, so the first one
 * took the slot and every one after it failed with a raw E11000 — which the
 * office saw as "Something went wrong" on the second booking they ever made.
 *
 * A partial index says what was actually meant: uniqueness applies only where
 * there IS a vendor id. `default: null` is also gone from the field above, so
 * nothing writes one by accident.
 *
 * ⚙️ Mongoose never alters an index that already exists, so an environment
 * created before this needs `migrate-call-up-index` run once.
 */
callUpSchema.index(
  { externalId: 1 },
  {
    unique: true,
    partialFilterExpression: { externalId: { $type: 'string' } },
    name: 'call_up_external_unique',
  },
);

/** Matching an arriving call-up to an order. The hot path. */
callUpSchema.index({ poNumber: 1, receivedAt: -1 }, { name: 'call_up_po_number' });

/** The office queue: what is waiting for a human, oldest first. */
callUpSchema.index({ state: 1, receivedAt: 1 }, { name: 'call_up_queue' });

/** Everything that has happened to one order, in order. */
callUpSchema.index({ purchaseOrderId: 1, receivedAt: -1 }, { name: 'call_up_history' });

export const CallUpModel = model('CallUp', callUpSchema);
