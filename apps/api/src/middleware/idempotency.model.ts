import { Schema, model } from 'mongoose';

export const IDEMPOTENCY_KEYS_COLLECTION = 'idempotencykeys';

/**
 * One replayable write (§6A.4, `docs/offline-sync-protocol.md` §3).
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * The driver app queues every mutation and drains the queue when signal comes
 * back. A drain that times out mid-flight cannot know whether the server saw
 * the request, so it retries — and a retried `POST /driver/jobs/:id/futile`
 * would raise a SECOND $120 charge against a customer who was only failed once.
 * The client sends a stable `idempotency-key` per queued operation; this
 * collection is what makes honouring it possible.
 *
 * ── Why the response is stored, not just the key ──────────────────────────
 * Answering a replay with 200-and-nothing would be a lie the client cannot
 * detect: it would take an empty body as the truth and overwrite good local
 * state. So the first response is captured verbatim and replayed byte for byte,
 * which is what makes a retry genuinely indistinguishable from the original.
 *
 * ── Why the request is fingerprinted ──────────────────────────────────────
 * A key reused with a DIFFERENT body is a client bug, and the dangerous kind:
 * silently replaying the first response would discard the second write and
 * report success. `requestHash` catches it so it can be refused loudly.
 */
const idempotencyKeySchema = new Schema(
  {
    /** Client-generated UUID v4. Unique per user, not globally — see the index. */
    key: { type: String, required: true, trim: true },
    /**
     * REFERENCE → `users._id`, as a string.
     *
     * Scoping to the user is what stops one driver's key colliding with
     * another's, and stops a guessed key from replaying somebody else's write
     * back to them — the stored response can contain their data.
     */
    userId: { type: String, required: true },
    method: { type: String, required: true },
    path: { type: String, required: true },
    /** SHA-256 of the request body. See the note above. */
    requestHash: { type: String, required: true },
    /**
     * `in-flight` while the first request is still running.
     *
     * A concurrent retry that finds this must NOT be served a half-written
     * answer, and must not be allowed to run the handler a second time either.
     * It gets a 409 and retries later, by which point this row is `complete`.
     */
    status: { type: String, required: true, enum: ['in-flight', 'complete'] },
    responseStatus: { type: Number, default: null },
    /** The captured body. Null for a 204, which is most driver writes. */
    responseBody: { type: Schema.Types.Mixed, default: null },
    completedAt: { type: Date, default: null },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  { collection: IDEMPOTENCY_KEYS_COLLECTION, versionKey: false },
);

/**
 * The claim. Unique so an insert is an atomic "I got here first" — two racing
 * retries cannot both proceed, whatever the database is doing underneath.
 */
idempotencyKeySchema.index({ userId: 1, key: 1 }, { unique: true, name: 'user_key' });

/**
 * Expiry.
 *
 * Seven days, not the usual 24 hours: this queue lives on a phone that can be
 * out of coverage for a weekend, and a key that expires before its retry
 * arrives protects nothing. The rows are tiny and Mongo reaps them itself.
 */
idempotencyKeySchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60, name: 'ttl' });

export const IdempotencyKeyModel = model('IdempotencyKey', idempotencyKeySchema);
