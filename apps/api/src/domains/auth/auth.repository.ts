import type {
  AuthChannel,
  AuthenticatedUser,
  BrandId,
  Role,
  UserStatus,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { getMongoDb } from '../../db/mongo.js';
import { logger } from '../../lib/logger.js';
import { BrandModel, brandSeedData } from '../brands/brand.model.js';
import {
  AuthChallengeModel,
  COLLECTION_VALIDATORS,
  UserModel,
  type AuthChallengeDocument,
} from './auth.model.js';

const log = logger.child({ module: 'auth-repository' });

/**
 * A user as the service consumes it: the session's `AuthenticatedUser` plus the
 * one field the service needs but the browser must not be handed on the sign-in
 * path — `status`, which decides whether they get in at all.
 */
export interface UserRecord extends AuthenticatedUser {
  status: UserStatus;
}

/**
 * Better Auth's own session collection — its default model name, which this
 * app does not override (only `user.modelName` is set, in `better-auth.ts`).
 */
const SESSIONS_COLLECTION = 'session';

/** The challenge state the service reasons about. No Mongo types escape. */
export interface ChallengeRecord {
  challengeId: string;
  channel: AuthChannel;
  identifier: string;
  userId: string | null;
  sentTo: string;
  expiresAt: Date;
  resendAvailableAt: Date;
  attemptsRemaining: number;
  consumedAt: Date | null;
  decoy: boolean;
}

export interface CreateChallengeInput {
  channel: AuthChannel;
  identifier: string;
  userId: string | null;
  sentTo: string;
  expiresAt: Date;
  resendAvailableAt: Date;
  attemptsRemaining: number;
  decoy: boolean;
  requestIp: string | null;
  purgeAt: Date;
}

/** Shape of a `.lean()` user document. `strict: false` means there may be more. */
interface RawUser {
  _id: mongoose.Types.ObjectId;
  name: string;
  email: string | null;
  phoneNumber: string | null;
  role: Role;
  roles: Role[];
  status: UserStatus;
  jobTitle: string | null;
  brandIds: string[];
  accountId: mongoose.Types.ObjectId | null;
  lastSignedInAt: Date | null;
}

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 *
 * It also owns the translation between storage names and contract names, so the
 * service never sees a Mongo document: `_id` becomes `id`, `phoneNumber`
 * becomes `mobile`, and `Date` becomes an ISO string. A service that had to
 * know about `phoneNumber` would be a service coupled to a plugin's schema.
 */
export const authRepository = {
  // ── Identity resolution ───────────────────────────────────────────────────

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const raw = await UserModel.findOne({ email: email.toLowerCase() }).lean<RawUser>().exec();
    return raw ? toUserRecord(raw) : null;
  },

  async findUserByMobile(mobile: string): Promise<UserRecord | null> {
    const raw = await UserModel.findOne({ phoneNumber: mobile }).lean<RawUser>().exec();
    return raw ? toUserRecord(raw) : null;
  },

  async findUserById(id: string): Promise<UserRecord | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const raw = await UserModel.findById(id).lean<RawUser>().exec();
    return raw ? toUserRecord(raw) : null;
  },

  /**
   * The role this SESSION is working as, or `null` for the person's usual one.
   *
   * ── Why the session and not the user ──────────────────────────────────────
   * Matt, 27:01 — the driver manager covers a sick driver's shift, so he moves
   * between the console and the run sheet. The choice has to survive a reload
   * and the jump to the driver app's origin (§6A.5), a full page load that
   * discards anything held in a tab — so it lives on the server. It was stored
   * on the USER, and that was wrong twice over: a switch on his phone sent the
   * console on his office PC to the driver app too, and a session that simply
   * expired on Friday left Monday's fresh sign-in landing on an empty run
   * sheet. On the session, each device keeps its own choice, and a new sign-in
   * starts clean because it is a new session.
   *
   * All three surfaces talk to one API, so one browser holds one session
   * across the console and the driver app — which is what the jump needs.
   *
   * ⚠️ NOT a permission. Every server-side gate reads `roles`; this only
   * decides where they land and what the shell shows. No validation here —
   * whether the role is one they hold is a rule, and rules live in the service.
   */
  async findSessionActiveRole(sessionId: string): Promise<Role | null> {
    if (!mongoose.isValidObjectId(sessionId)) return null;

    const row = await getMongoDb()
      .collection(SESSIONS_COLLECTION)
      .findOne(
        { _id: new mongoose.Types.ObjectId(sessionId) },
        { projection: { activeRole: 1 } },
      );

    return (row?.activeRole as Role | null | undefined) ?? null;
  },

  /** Records the role this session is working as, or clears it with `null`. */
  async setSessionActiveRole(sessionId: string, role: Role | null): Promise<void> {
    if (!mongoose.isValidObjectId(sessionId)) return;

    // A targeted `$set` on one field Better Auth does not know about. Its own
    // writes to the session (the rolling expiry) are `$set`s too, so neither
    // side overwrites the other.
    await getMongoDb()
      .collection(SESSIONS_COLLECTION)
      .updateOne({ _id: new mongoose.Types.ObjectId(sessionId) }, { $set: { activeRole: role } });
  },

  /**
   * Records a successful sign-in.
   *
   * A targeted `$set`, never a document save — see the warning in
   * `auth.model.ts`. `timestamps: false` because `updatedAt` should mean "this
   * person's record was edited", not "this person signed in"; otherwise the
   * users grid shows every driver as freshly modified each morning.
   */
  async markSignedIn(userId: string, at: Date): Promise<void> {
    await UserModel.updateOne(
      { _id: new mongoose.Types.ObjectId(userId) },
      { $set: { lastSignedInAt: at } },
      { timestamps: false },
    ).exec();

    /*
     * First sign-in ends the invitation (M1.5).
     *
     * ── Why this is a second, filtered update ──────────────────────────────
     * `invited` means "we have sent them access and do not yet know it reached
     * them". Signing in is the proof, so leaving the status alone made the grid
     * read "Never — invitation pending" for people who had been working in the
     * product for weeks, and made the Resend button offer to chase them.
     *
     * The filter carries `status: 'invited'` so this can only ever close an
     * invitation. An unconditional `$set` would quietly reactivate a suspended
     * account — a privilege change performed by a sign-in, which is exactly the
     * kind of thing that must never be a side effect.
     */
    await UserModel.updateOne(
      { _id: new mongoose.Types.ObjectId(userId), status: 'invited' },
      { $set: { status: 'active' } },
      { timestamps: false },
    ).exec();
  },

  // ── Challenges ────────────────────────────────────────────────────────────

  async createChallenge(input: CreateChallengeInput): Promise<ChallengeRecord> {
    const created = await AuthChallengeModel.create({
      channel: input.channel,
      identifier: input.identifier,
      userId: input.userId ? new mongoose.Types.ObjectId(input.userId) : null,
      sentTo: input.sentTo,
      expiresAt: input.expiresAt,
      resendAvailableAt: input.resendAvailableAt,
      attemptsRemaining: input.attemptsRemaining,
      decoy: input.decoy,
      requestIp: input.requestIp,
      purgeAt: input.purgeAt,
    });

    return toChallengeRecord(created.toObject<AuthChallengeDocument & { _id: mongoose.Types.ObjectId }>());
  },

  async findChallenge(challengeId: string): Promise<ChallengeRecord | null> {
    // An id from an untrusted body. Without this guard Mongoose raises a
    // CastError, which would surface as a 500 for what is really "not found".
    if (!mongoose.isValidObjectId(challengeId)) return null;

    const raw = await AuthChallengeModel.findById(challengeId)
      .lean<AuthChallengeDocument & { _id: mongoose.Types.ObjectId }>()
      .exec();

    return raw ? toChallengeRecord(raw) : null;
  },

  /**
   * Spends one attempt and reports what is left.
   *
   * `findOneAndUpdate` with `$inc` so the decrement is atomic: two verify
   * requests racing on the same challenge must consume two attempts, not one.
   * `attemptsRemaining: { $gt: 0 }` in the filter means a burned challenge
   * cannot go negative and matches nothing instead.
   */
  async spendAttempt(challengeId: string): Promise<number | null> {
    if (!mongoose.isValidObjectId(challengeId)) return null;

    const updated = await AuthChallengeModel.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(challengeId), attemptsRemaining: { $gt: 0 } },
      { $inc: { attemptsRemaining: -1 } },
      { new: true, projection: { attemptsRemaining: 1 } },
    )
      .lean<{ attemptsRemaining: number }>()
      .exec();

    return updated ? updated.attemptsRemaining : null;
  },

  /**
   * Marks a challenge as spent, atomically.
   *
   * Returns false when it was ALREADY consumed, which is the guard against one
   * code being redeemed twice — two requests arriving together, or a replayed
   * one. Only the caller that flips it from null gets a session.
   */
  async consumeChallenge(challengeId: string, at: Date): Promise<boolean> {
    if (!mongoose.isValidObjectId(challengeId)) return false;

    const result = await AuthChallengeModel.updateOne(
      { _id: new mongoose.Types.ObjectId(challengeId), consumedAt: null },
      { $set: { consumedAt: at } },
    ).exec();

    return result.modifiedCount === 1;
  },

  /**
   * Extends a challenge after a resend, and refills its attempts.
   *
   * `requestIp` is overwritten rather than appended: the useful fact for the
   * sign-in audit (§9) is where the code was last sent from, and a full history
   * of resend addresses belongs in the audit collection (M1.6), not here.
   */
  async refreshChallenge(
    challengeId: string,
    values: {
      expiresAt: Date;
      resendAvailableAt: Date;
      attemptsRemaining: number;
      purgeAt: Date;
      requestIp: string | null;
    },
  ): Promise<void> {
    await AuthChallengeModel.updateOne(
      { _id: new mongoose.Types.ObjectId(challengeId) },
      { $set: values },
    ).exec();
  },

  /**
   * How many codes this identifier has been sent recently.
   *
   * Throttling per identifier as well as per IP is the point: an IP limit alone
   * is defeated by a handful of proxies, and the cost being protected against
   * is a real one — an SMS to a driver's phone is billed, and a flood of them
   * is both an expense and harassment of whoever owns that number.
   */
  async countRecentSends(identifier: string, since: Date): Promise<number> {
    return AuthChallengeModel.countDocuments({
      identifier,
      decoy: false,
      createdAt: { $gte: since },
    }).exec();
  },

  // ── Schema and seed ───────────────────────────────────────────────────────

  /**
   * Applies the `$jsonSchema` validators (§6A.3 #4).
   *
   * `collMod` on an existing collection, `create` when it does not exist yet.
   * Idempotent, so it runs on every boot: a validator that has to be applied by
   * hand is a validator that is missing in one environment.
   */
  async ensureSchemaValidators(): Promise<void> {
    const db = getMongoDb();
    const existing = new Set(
      await db.listCollections({}, { nameOnly: true }).toArray().then((all) => all.map((c) => c.name)),
    );

    for (const { collection, schema } of COLLECTION_VALIDATORS) {
      const options = {
        validator: { $jsonSchema: schema },
        // `warn` would let bad documents in and only mention it. If a write
        // breaks the shape, the write is the bug.
        validationLevel: 'strict',
        validationAction: 'error',
      };

      try {
        if (existing.has(collection)) {
          await db.command({ collMod: collection, ...options });
        } else {
          await db.createCollection(collection, options);
        }
        log.debug({ collection }, 'jsonSchema validator applied');
      } catch (error) {
        // Never fatal: an Atlas user without `collMod` rights should not stop
        // the API from serving. Mongoose still validates our own writes.
        log.warn({ err: error, collection }, 'could not apply jsonSchema validator');
      }
    }
  },

  /** Upserts the three brands. Labels follow the contract, so this is safe to re-run. */
  async seedBrands(): Promise<void> {
    await BrandModel.bulkWrite(
      brandSeedData().map((brand) => ({
        updateOne: {
          filter: { _id: brand._id },
          // `$setOnInsert` for `active`: the office may deactivate a brand, and
          // a boot must not undo that.
          update: { $set: { label: brand.label }, $setOnInsert: { active: brand.active } },
          upsert: true,
        },
      })),
    );
  },

  /**
   * True when every slug points at a brand that exists.
   *
   * The guard to call before writing a `brandIds` reference: Mongo will not
   * check a foreign key for us (§6A.3), so "this user belongs to a brand that
   * was never created" is a state only application code can prevent.
   */
  async brandsExist(brandIds: readonly BrandId[]): Promise<boolean> {
    if (brandIds.length === 0) return true;
    const unique = [...new Set(brandIds)];
    const found = await BrandModel.countDocuments({ _id: { $in: unique } }).exec();
    return found === unique.length;
  },

  /**
   * Creates any missing indexes (§6A.3 #6).
   *
   * Additive only. An index whose OPTIONS have changed — `sparse` becoming
   * partial, say — cannot be modified in place: Mongo answers
   * `IndexOptionsConflict`, and the existing index stays as it was. Dropping and
   * rebuilding one is a migration with a real cost on a populated collection, so
   * this reports the conflict loudly rather than doing it silently at boot.
   */
  async createIndexes(): Promise<void> {
    const models = [
      { name: 'users', model: UserModel },
      { name: 'authchallenges', model: AuthChallengeModel },
      { name: 'brands', model: BrandModel },
    ] as const;

    for (const { name, model } of models) {
      try {
        await model.createIndexes();
      } catch (error) {
        if (isIndexConflict(error)) {
          log.error(
            { collection: name, err: error },
            'an existing index conflicts with the schema and was NOT changed — ' +
              'drop it and re-create it as a migration',
          );
          continue;
        }
        throw error;
      }
    }
  },
};

/** `IndexOptionsConflict` (85) and `IndexKeySpecsConflict` (86). */
function isIndexConflict(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 85 || code === 86;
}

function toUserRecord(raw: RawUser): UserRecord {
  return {
    id: raw._id.toHexString(),
    name: raw.name,
    email: raw.email ?? null,
    // The rename happens here and nowhere else.
    mobile: raw.phoneNumber ?? null,
    role: raw.role,
    roles: raw.roles,
    status: raw.status,
    jobTitle: raw.jobTitle ?? null,
    brandIds: raw.brandIds ?? [],
    accountId: raw.accountId ? raw.accountId.toHexString() : null,
    lastSignedInAt: raw.lastSignedInAt ? raw.lastSignedInAt.toISOString() : null,
  };
}

function toChallengeRecord(
  raw: AuthChallengeDocument & { _id: mongoose.Types.ObjectId },
): ChallengeRecord {
  return {
    challengeId: raw._id.toHexString(),
    channel: raw.channel,
    identifier: raw.identifier,
    userId: raw.userId ? raw.userId.toHexString() : null,
    sentTo: raw.sentTo,
    expiresAt: raw.expiresAt,
    resendAvailableAt: raw.resendAvailableAt,
    attemptsRemaining: raw.attemptsRemaining,
    consumedAt: raw.consumedAt ?? null,
    decoy: raw.decoy,
  };
}
