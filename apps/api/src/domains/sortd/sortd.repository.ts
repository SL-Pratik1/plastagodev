import type { Surface } from '@plastago/shared';
import mongoose from 'mongoose';
import type { SortdRole } from '../../integrations/sortd.js';
import { AccountModel } from '../accounts/account.model.js';
import { UserModel } from '../auth/auth.model.js';
import {
  SortdSessionModel,
  SortdWebhookEventModel,
  type SortdSessionDocument,
} from './sortd.model.js';

/**
 * Repository layer — Mongoose lives here and nowhere else (§6A.3).
 */

export interface CachedSortdSession {
  surface: Surface;
  sessionId: string;
  expiresAt: Date;
  sortdRole: SortdRole;
  appTenantId: string | null;
}

/** Who Sortd should believe is asking. */
export interface SortdIdentity {
  email: string | null;
  name: string;
}

function toObjectId(id: string): mongoose.Types.ObjectId | null {
  return mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : null;
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof mongoose.mongo.MongoServerError && error.code === 11000;
}

function toCached(row: SortdSessionDocument): CachedSortdSession {
  return {
    surface: row.surface,
    sessionId: row.sessionId,
    expiresAt: row.expiresAt,
    sortdRole: row.sortdRole,
    appTenantId: row.appTenantId ?? null,
  };
}

export const sortdRepository = {
  /* ── The session cache ─────────────────────────────────────────────────── */

  async findSession(userId: string, surface: Surface): Promise<CachedSortdSession | null> {
    const id = toObjectId(userId);
    if (!id) return null;

    const row = await SortdSessionModel.findOne({ userId: id, surface }).lean<SortdSessionDocument>();
    return row ? toCached(row) : null;
  },

  async saveSession(input: {
    userId: string;
    surface: Surface;
    sessionId: string;
    expiresAt: Date;
    sortdRole: SortdRole;
    appTenantId: string | null;
  }): Promise<void> {
    const { userId, surface, ...rest } = input;
    const id = toObjectId(userId);
    if (!id) return;

    await SortdSessionModel.updateOne(
      { userId: id, surface },
      { $set: rest },
      { upsert: true },
    ).exec();
  },

  /**
   * Deletes every session this user holds, on every surface, and returns what
   * was deleted so the caller can revoke each one at Sortd.
   *
   * Read and delete are two statements, so a session minted between them would
   * survive. That window is one sign-out wide, and the survivor is a session
   * belonging to the same person, minted by a tab of theirs that was still
   * loading — not a disclosure.
   */
  async takeAllSessions(userId: string): Promise<CachedSortdSession[]> {
    const id = toObjectId(userId);
    if (!id) return [];

    const rows = await SortdSessionModel.find({ userId: id }).lean<
      Array<SortdSessionDocument & { _id: mongoose.Types.ObjectId }>
    >();
    if (rows.length === 0) return [];

    await SortdSessionModel.deleteMany({ _id: { $in: rows.map((row) => row._id) } }).exec();

    return rows.map(toCached);
  },

  /* ── Who is asking ─────────────────────────────────────────────────────── */

  /**
   * The signed-in user's email and name.
   *
   * A separate read rather than `req.auth`, which carries no email because
   * nothing that authorises an action needs one. Lean on purpose — the user
   * detail read joins devices and sign-in history, none of which a support
   * bubble wants.
   */
  async findIdentity(userId: string): Promise<SortdIdentity | null> {
    const id = toObjectId(userId);
    if (!id) return null;

    const row = await UserModel.findById(id).select({ email: 1, name: 1 }).lean();
    if (!row) return null;

    return { email: row.email ?? null, name: row.name };
  },

  /** The customer account's name, as the tenant's label in the Sortd portal. */
  async findAccountName(accountId: string): Promise<string | null> {
    const id = toObjectId(accountId);
    if (!id) return null;

    const row = await AccountModel.findById(id).select({ name: 1 }).lean();
    return row?.name ?? null;
  },

  /* ── Webhook dedupe ────────────────────────────────────────────────────── */

  /**
   * Claims a delivery. True the first time this key is seen, false for a
   * retry of one already handled.
   *
   * ⚠️ Only a duplicate-key error means "seen". Anything else — the database
   * being unreachable — is thrown, so the webhook answers 5xx and Sortd tries
   * again, rather than the ticket being silently treated as announced.
   */
  async claimWebhookEvent(eventKey: string): Promise<boolean> {
    try {
      await SortdWebhookEventModel.create({ eventKey, receivedAt: new Date() });
      return true;
    } catch (error) {
      if (isDuplicateKey(error)) return false;
      throw error;
    }
  },

  /**
   * Gives a claim back, when the work it guarded could not even start. Without
   * this a failed first attempt would turn every retry into a "duplicate".
   */
  async releaseWebhookEvent(eventKey: string): Promise<void> {
    await SortdWebhookEventModel.deleteOne({ eventKey }).exec();
  },
};
