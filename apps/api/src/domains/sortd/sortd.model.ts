import { SURFACES } from '@plastago/shared';
import { Schema, model, type InferSchemaType } from 'mongoose';

export const SORTD_SESSIONS_COLLECTION = 'sortdsessions';
export const SORTD_WEBHOOK_EVENTS_COLLECTION = 'sortdwebhookevents';

/**
 * One cached Sortd support session per user per surface.
 *
 * ⚠️ A CACHE. Sortd is the source of truth, and a row that disagrees with it
 * is wrong by definition — the service deletes or overwrites rows rather than
 * repairing them.
 *
 * ── Why cache at all ──────────────────────────────────────────────────────
 * Every shell asks for a session on load. Without a cache that is a round trip
 * to a third party on every sign-in and every reload, before the bubble can
 * appear — and a Sortd outage would remove support from people whose session
 * was perfectly good.
 *
 * ── Why per surface ───────────────────────────────────────────────────────
 * Each surface is its own Sortd app with its own key, and a session belongs to
 * the app that minted it. An allocator covering a driver's shift needs the
 * driver app's session while their console session is still alive.
 *
 * `sessionId` is a bearer credential for one person's support history. It is
 * returned only to its owner and never logged.
 */
const sortdSessionSchema = new Schema(
  {
    /** REFERENCE → `users._id`. Whose session this is. */
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },

    surface: { type: String, required: true, enum: [...SURFACES] },

    /** Sortd's opaque `ess_…` handle. Safe for that user's browser only. */
    sessionId: { type: String, required: true },

    expiresAt: { type: Date, required: true },

    /**
     * What the session was minted AS — its Sortd role and tenant.
     *
     * Stored because both change in PlastaGo without the session changing at
     * Sortd. A customer administrator demoted to site supervisor would
     * otherwise keep a session that sees their whole account's tickets until it
     * expired; comparing these on read is what makes the demotion take effect
     * on the next page load instead.
     */
    sortdRole: { type: String, required: true, enum: ['user', 'admin', 'owner'] },
    appTenantId: { type: String, default: null },
  },
  { collection: SORTD_SESSIONS_COLLECTION, timestamps: true, versionKey: false },
);

/**
 * ONE SESSION PER USER PER SURFACE, enforced by the database.
 *
 * The service upserts on this key, so two tabs opening at the same moment
 * overwrite each other instead of leaving two rows — and sign-out, which
 * deletes by user, cannot miss one.
 */
sortdSessionSchema.index(
  { userId: 1, surface: 1 },
  { unique: true, name: 'sortd_session_unique' },
);

/**
 * Expired rows delete themselves — Mongo's own TTL sweep rather than a job
 * somebody has to remember exists. A session is worthless once it has expired.
 */
sortdSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'sortd_session_ttl' });

export type SortdSessionDocument = InferSchemaType<typeof sortdSessionSchema>;

export const SortdSessionModel = model('SortdSession', sortdSessionSchema);

/**
 * One Sortd webhook delivery that has already been acted on.
 *
 * Sortd makes up to four attempts (1s, 5s, 15s apart, 10s timeout each), and
 * a retry resends the SAME event for the same ticket. A delivery that timed
 * out after the work was done is the easiest failure to hit, and without this
 * it would announce one escalation twice.
 *
 * ── Why a collection when the bell and the email already dedupe ───────────
 * They do — a notification upserts on its subject key and an email is claimed
 * once per subject — and this is the layer in front of both. It answers a
 * retry with `duplicate: true` before any work starts, and it is the one place
 * that records which deliveries arrived.
 */
const sortdWebhookEventSchema = new Schema(
  {
    /**
     * `${surface}:${event}:${ticketId}`.
     *
     * The surface is part of it because each surface is a separate Sortd app,
     * and two apps' ticket ids are two namespaces.
     */
    eventKey: { type: String, required: true },
    receivedAt: { type: Date, required: true, default: Date.now },
  },
  { collection: SORTD_WEBHOOK_EVENTS_COLLECTION, versionKey: false },
);

/**
 * The dedupe itself — an insert that fails on a duplicate key, not a
 * read-then-write. Two retries arriving together would both pass a `findOne`.
 */
sortdWebhookEventSchema.index({ eventKey: 1 }, { unique: true, name: 'sortd_event_unique' });

/**
 * Kept a day: thousands of times longer than the ~21 seconds of retries it has
 * to survive, for a delivery Sortd re-sends late after an outage of its own.
 */
sortdWebhookEventSchema.index(
  { receivedAt: 1 },
  { expireAfterSeconds: 24 * 60 * 60, name: 'sortd_event_ttl' },
);

export const SortdWebhookEventModel = model('SortdWebhookEvent', sortdWebhookEventSchema);
