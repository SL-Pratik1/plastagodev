import { BRAND_IDS, ROLES, USER_STATUSES } from '@plastago/shared';
import { Schema, model, type InferSchemaType } from 'mongoose';
import { BRANDS_COLLECTION } from '../brands/brand.model.js';

/**
 * ⚠️ This name is shared with Better Auth (`user.modelName`). Changing it means
 * changing both, or the platform grows a second user directory overnight.
 */
export const USERS_COLLECTION = 'users';

export const CHALLENGES_COLLECTION = 'authchallenges';

/**
 * The user document — ONE collection, two writers (M1.5).
 *
 * Better Auth writes the identity fields; this codebase writes the domain
 * fields. Both halves are declared here so the document is readable in one
 * place and so `$jsonSchema` can guard the whole of it.
 *
 * ⚠️ Never `save()` a whole user document from the Mongoose side. Mongoose only
 * knows the paths below; a full-document write would drop anything Better Auth
 * has added since (a new `phoneNumberVerified`, say). Every write in the
 * repository is a targeted `$set` for that reason.
 */
const userSchema = new Schema(
  {
    // ── Better Auth's fields ────────────────────────────────────────────────
    name: { type: String, required: true, trim: true },
    /**
     * Sparse because a site supervisor may have only a mobile, and a driver
     * may have only a phone — requiring both would block the majority of the
     * people this system is for (§9 A2).
     */
    email: { type: String, default: null, lowercase: true, trim: true },
    emailVerified: { type: Boolean, default: false },
    image: { type: String, default: null },
    /**
     * Stored under Better Auth's name, exposed on the wire as `mobile`.
     *
     * The `phoneNumber` plugin owns this field and its `phoneNumberVerified`
     * companion, so renaming the column would mean patching the plugin. The
     * contract says `mobile`, so the repository maps one to the other on the
     * way out — a rename at the boundary, not a second copy of the number.
     */
    phoneNumber: { type: String, default: null, trim: true },
    phoneNumberVerified: { type: Boolean, default: false },

    // ── Our fields ──────────────────────────────────────────────────────────
    /** Acting role. Always a member of `roles`. */
    role: { type: String, required: true, enum: ROLES },
    roles: {
      type: [{ type: String, enum: ROLES }],
      required: true,
      validate: {
        validator: (value: string[]) => value.length > 0,
        message: 'A user must hold at least one role',
      },
    },
    status: { type: String, required: true, enum: USER_STATUSES, default: 'active' },
    jobTitle: { type: String, default: null, trim: true },

    /**
     * Who invited them, as a NAME.
     *
     * Frozen rather than a reference: the point of the field is the audit trail,
     * and an id that resolves to a deleted user answers nothing. `Seeded` for
     * the accounts that existed before anybody was inviting anybody.
     */
    invitedBy: { type: String, default: null, trim: true },

    /** Free text the office keeps about a person. Never shown to them. */
    notes: { type: String, required: false, default: '', trim: true },
    /** REFERENCE → `accounts._id`. Only ever set for the two customer roles. */
    accountId: { type: Schema.Types.ObjectId, ref: 'Account', default: null },
    /** REFERENCES → `brands._id`. Slug keys — see `brand.model.ts`. */
    brandIds: {
      type: [{ type: String, ref: 'Brand', enum: BRAND_IDS }],
      required: true,
      default: [],
    },
    lastSignedInAt: { type: Date, default: null },

    /**
     * B.2 — a site supervisor who joined by customer code and needs approving.
     *
     * Only meaningful on an account whose `approveNewSupervisors` is on. False
     * everywhere else, including for supervisors the customer invited directly —
     * inviting somebody IS the approval.
     */
    awaitingApproval: { type: Boolean, required: true, default: false },
  },
  {
    collection: USERS_COLLECTION,
    timestamps: true,
    versionKey: false,
    // Better Auth may add fields this schema has not been taught yet (a plugin
    // upgrade, say). Strict mode would silently discard them on our own writes.
    strict: false,
  },
);

/**
 * One identifier resolves one person — the sign-in path depends on it, because
 * two users sharing a mobile makes "who is signing in" unanswerable.
 *
 * ⚠️ PARTIAL, not `sparse`. A sparse unique index only skips documents where the
 * field is ABSENT; a document with an explicit `null` still occupies the index,
 * so the second office user without a mobile would collide with the first on
 * `{ phoneNumber: null }`. Most of the office has no mobile on file and most
 * drivers have no email, so that is the common case, not an edge one.
 *
 * `$type: 'string'` indexes only the documents that actually have a value, and
 * leaves any number of nulls alone.
 */
userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);
userSchema.index(
  { phoneNumber: 1 },
  { unique: true, partialFilterExpression: { phoneNumber: { $type: 'string' } } },
);
// The users grid filters by role and status; the portal scopes by account.
userSchema.index({ role: 1, status: 1 });
userSchema.index({ accountId: 1 });

export type UserDocument = InferSchemaType<typeof userSchema>;
export const UserModel = model('User', userSchema);

/**
 * A sign-in challenge — the bridge between the screen and Better Auth.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The sign-in screens are built against a challenge-based contract: the server
 * answers `requestCode` with an opaque `challengeId`, and `verifyCode` sends
 * back `{ challengeId, code }` and nothing else. Better Auth instead expects
 * the email or phone number again on verification.
 *
 * Rebuilding the screens to Better Auth's shape was not an option — the
 * contract is frozen and two other consumers depend on it — and it would be the
 * worse design anyway: re-sending the identifier from the browser means it sits
 * in the page, in history state and in any error report, and it lets someone
 * verify a code against an identifier they never requested one for.
 *
 * So the identifier is held here, server-side, keyed by an id that means
 * nothing on its own.
 *
 * ⚠️ THE CODE IS NEVER STORED HERE. Better Auth's `verification` collection
 * holds it and is the only thing that can check it. This document tracks the
 * presentation state the screen needs: what it was masked as, when it expires,
 * when a resend is allowed, and how many guesses are left.
 *
 * (Email codes are stored as a digest — `storeOTP: 'hashed'` in
 * `better-auth.ts`. SMS codes are stored in plain text because the
 * `phoneNumber` plugin offers no equivalent option; the gap and its
 * compensating controls are documented at that call site.)
 */
const authChallengeSchema = new Schema(
  {
    channel: { type: String, required: true, enum: ['email', 'sms'] },
    /**
     * The resolved identifier, in the form Better Auth expects it back:
     * a lowercased email, or a normalised mobile.
     */
    identifier: { type: String, required: true },
    /** REFERENCE → `users._id`. Null on a decoy (see `decoy`). */
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** Masked for display, e.g. `m•••@iplasta.com.au`. Never the full value. */
    sentTo: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    resendAvailableAt: { type: Date, required: true },
    attemptsRemaining: { type: Number, required: true, min: 0 },
    /** Set once verified, so a challenge cannot mint two sessions. */
    consumedAt: { type: Date, default: null },
    /**
     * A challenge issued for an identifier that does not exist.
     *
     * It looks and behaves exactly like a real one and no message is sent, so
     * an unauthenticated caller cannot tell from the response whether an
     * account exists (see `revealUnknownIdentifier`). Verification always fails.
     */
    decoy: { type: Boolean, required: true, default: false },
    /** For the audit trail of sign-in attempts (§9). */
    requestIp: { type: String, default: null },
    /**
     * When to delete the row — deliberately LATER than `expiresAt`.
     *
     * If the TTL fired at expiry, an expired challenge and one that never
     * existed would be indistinguishable, and the screen would say "start
     * again" where it should say "that code expired, send a new one". The row
     * outliving the code by an hour is what lets those be different sentences.
     */
    purgeAt: { type: Date, required: true },
  },
  {
    collection: CHALLENGES_COLLECTION,
    timestamps: true,
    versionKey: false,
  },
);

authChallengeSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
// Reads the recent send history for one identifier, for the per-identifier throttle.
authChallengeSchema.index({ identifier: 1, createdAt: -1 });

export type AuthChallengeDocument = InferSchemaType<typeof authChallengeSchema>;
export const AuthChallengeModel = model('AuthChallenge', authChallengeSchema);

/**
 * Collection-level `$jsonSchema` validators (§6A.3 #4).
 *
 * Deliberately duplicated effort: Mongoose validates writes that go through
 * Mongoose, and Better Auth's writes do not. MongoDB enforces no referential
 * integrity for us, so the one guard that applies to EVERY writer — including a
 * migration script, a mongosh session at 2am, and a library we do not control —
 * has to live on the collection itself.
 *
 * `additionalProperties` stays open: Better Auth adds fields of its own and a
 * plugin upgrade must not start rejecting every sign-in.
 */
export const USER_JSON_SCHEMA = {
  bsonType: 'object',
  required: ['name', 'role', 'roles', 'status'],
  properties: {
    name: { bsonType: 'string', minLength: 1 },
    email: { bsonType: ['string', 'null'] },
    phoneNumber: { bsonType: ['string', 'null'] },
    role: { enum: [...ROLES] },
    roles: {
      bsonType: 'array',
      minItems: 1,
      items: { enum: [...ROLES] },
    },
    status: { enum: [...USER_STATUSES] },
    brandIds: {
      bsonType: 'array',
      items: { enum: [...BRAND_IDS] },
    },
    // Reference, so the type is the one thing worth pinning here.
    accountId: { bsonType: ['objectId', 'null'] },
  },
} as const;

export const BRAND_JSON_SCHEMA = {
  bsonType: 'object',
  required: ['_id', 'label', 'active'],
  properties: {
    _id: { enum: [...BRAND_IDS] },
    label: { bsonType: 'string', minLength: 1 },
    active: { bsonType: 'bool' },
  },
} as const;

/** Named so `ensureSchemaValidators` can iterate rather than repeat itself. */
export const COLLECTION_VALIDATORS = [
  { collection: USERS_COLLECTION, schema: USER_JSON_SCHEMA },
  { collection: BRANDS_COLLECTION, schema: BRAND_JSON_SCHEMA },
] as const;
