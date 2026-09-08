import { Schema, model } from 'mongoose';

export const USER_DEVICES_COLLECTION = 'userdevices';
export const USER_SIGN_INS_COLLECTION = 'usersignins';

/**
 * §9 — a device a driver has signed in on.
 *
 * ── Why the office needs to see this at all ───────────────────────────────
 * Two reasons, and neither is device management for its own sake.
 *
 * A lost phone must be revocable. A driver's device holds their run sheet, the
 * customer addresses on it and their photo queue — and it is the least
 * controlled surface in the product.
 *
 * §6A.8: *a stuck offline queue must be visible in the product.* There is no
 * error tracking, so if a driver's phone has been holding fourteen unsent
 * actions since Tuesday, the only way anybody finds out is by looking here.
 * That is why `pendingSyncActions` is on the record rather than inferred.
 */
const userDeviceSchema = new Schema(
  {
    /** REFERENCE → `users._id`. */
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },

    /** What the driver would recognise — "Troy's iPhone". */
    label: { type: String, required: true, trim: true },
    platform: { type: String, required: true, enum: ['ios', 'android', 'web'] },

    /**
     * The device's own identifier, from the app.
     *
     * Used to recognise a phone across sign-ins so one driver with one handset
     * does not accumulate a row per login — which would bury the actual second
     * device in a list of duplicates.
     */
    deviceKey: { type: String, required: true, trim: true },

    lastSeenAt: { type: Date, required: true, default: Date.now },
    lastSyncAt: { type: Date, default: null },
    /** ⚠️ The stuck-queue signal. See the note above. */
    pendingSyncActions: { type: Number, required: true, min: 0, default: 0 },

    /**
     * Revoking is a flag, not a delete.
     *
     * The record of which device held a run sheet on a given day is part of the
     * audit trail — deleting it removes the evidence along with the access.
     */
    revokedAt: { type: Date, default: null },
    revokedBy: { type: String, default: null, trim: true },
  },
  { collection: USER_DEVICES_COLLECTION, timestamps: true, versionKey: false },
);

/** One row per device per user, however many times they sign in on it. */
userDeviceSchema.index({ userId: 1, deviceKey: 1 }, { unique: true, name: 'user_device_unique' });

/** The user's device list, most recently used first. */
userDeviceSchema.index({ userId: 1, lastSeenAt: -1 }, { name: 'user_last_seen' });

/**
 * ⚠️ The sweep that finds stuck queues across the fleet.
 *
 * Partial, so it holds only devices that actually have something waiting —
 * which is normally none of them.
 */
userDeviceSchema.index(
  { pendingSyncActions: -1, lastSyncAt: 1 },
  { name: 'stuck_queues', partialFilterExpression: { pendingSyncActions: { $gt: 0 } } },
);

export const UserDeviceModel = model('UserDevice', userDeviceSchema);

/**
 * §9 — an audit of every sign-in attempt.
 *
 * ── Why failures are recorded, not just successes ─────────────────────────
 * Because the interesting rows are the failures. Six `failed-code` entries
 * against one address in two minutes is somebody guessing; a `locked-out` on a
 * driver at 5am is somebody who cannot start work and will ring the office. A
 * log of successes only answers "who got in", which is the question nobody
 * needs to ask.
 *
 * ⚠️ Append-only. Nothing in the API updates or deletes a row here — an audit
 * record that can be edited is not an audit record.
 */
const userSignInSchema = new Schema(
  {
    /**
     * REFERENCE → `users._id`.
     *
     * Nullable: an attempt against an address that matches nobody is exactly
     * the attempt worth recording, and it has no user to point at.
     */
    userId: { type: Schema.Types.ObjectId, default: null, ref: 'User' },

    /**
     * The identifier that was tried, REDACTED.
     *
     * `a••••••••@example.com` rather than the address itself. This collection
     * exists to show a pattern of attempts, not to become a second copy of every
     * email and mobile in the system for an attacker to read.
     */
    identifierMasked: { type: String, required: true, trim: true },

    at: { type: Date, required: true, default: Date.now },
    channel: { type: String, required: true, enum: ['email', 'sms'] },
    outcome: {
      type: String,
      required: true,
      enum: ['success', 'failed-code', 'expired-code', 'locked-out'],
    },
    /** What the request said it was. Untrusted, but useful beside a pattern. */
    device: { type: String, required: false, default: '', trim: true },
    /**
     * ⚠️ Never the full address. Only enough to tell one attempt from another
     * in a list — a full IP log is a different retention conversation.
     */
    ipPrefix: { type: String, default: null, trim: true },
  },
  { collection: USER_SIGN_INS_COLLECTION, timestamps: true, versionKey: false },
);

/** One user's recent history — what the detail screen shows. */
userSignInSchema.index({ userId: 1, at: -1 }, { name: 'user_recent' });

/**
 * The failure sweep. Partial, because successes are the overwhelming majority
 * and are not what anybody is looking for here.
 */
userSignInSchema.index(
  { at: -1 },
  { name: 'recent_failures', partialFilterExpression: { outcome: { $ne: 'success' } } },
);

export const UserSignInModel = model('UserSignIn', userSignInSchema);
