import mongoose from 'mongoose';
import { UserModel } from '../auth/auth.model.js';
import {
  EmbedTokenModel,
  ExtractorSessionModel,
  type EmbedTokenDocument,
} from './extractor.model.js';

/**
 * Repository layer — Mongoose lives here and nowhere else (§6A.3).
 */

export interface StoredEmbedToken {
  token: string;
  tokenId: string | null;
  organizationId: string | null;
  appId: string | null;
  /** The identity server-side sessions are minted as. See the model. */
  ownerEmail: string | null;
}

export interface CachedExtractorSession {
  sessionId: string;
  expiresAt: Date;
}

/** Who the extractor should believe is acting. */
export interface ExtractorIdentity {
  email: string | null;
  name: string;
}

export const extractorRepository = {
  /* ── The embed token ───────────────────────────────────────────────────── */

  async findToken(tenantId: string, appName: string): Promise<StoredEmbedToken | null> {
    const row = await EmbedTokenModel.findOne({ tenantId, appName }).lean<EmbedTokenDocument>();
    if (!row) return null;

    return {
      token: row.token,
      tokenId: row.tokenId ?? null,
      organizationId: row.organizationId ?? null,
      appId: row.appId ?? null,
      ownerEmail: row.ownerEmail ?? null,
    };
  },

  async saveToken(input: {
    tenantId: string;
    appName: string;
    token: string;
    tokenId: string | null;
    organizationId: string | null;
    appId: string | null;
    ownerEmail: string | null;
  }): Promise<void> {
    const { tenantId, appName, ...rest } = input;

    await EmbedTokenModel.updateOne(
      { tenantId, appName },
      { $set: rest },
      { upsert: true },
    ).exec();
  },

  /**
   * Drops a token the vendor no longer recognises.
   *
   * Deleted rather than flagged: a dead credential has no diagnostic value, and
   * leaving it in place means the next request reads it again and fails
   * identically.
   */
  async deleteToken(tenantId: string, appName: string): Promise<void> {
    await EmbedTokenModel.deleteOne({ tenantId, appName }).exec();
  },

  /* ── The session cache ─────────────────────────────────────────────────── */

  /**
   * A cached session with life left in it.
   *
   * `notBefore` is the caller's safety margin, not a stored value: a session
   * with thirty seconds left would be handed to an iframe that then holds it
   * for an hour.
   */
  async findSession(input: {
    tenantId: string;
    userId: string;
    notBefore: Date;
  }): Promise<CachedExtractorSession | null> {
    if (!mongoose.isValidObjectId(input.userId)) return null;

    const row = await ExtractorSessionModel.findOne({
      tenantId: input.tenantId,
      userId: new mongoose.Types.ObjectId(input.userId),
      expiresAt: { $gt: input.notBefore },
    }).lean();

    return row ? { sessionId: row.sessionId, expiresAt: row.expiresAt } : null;
  },

  async saveSession(input: {
    tenantId: string;
    userId: string;
    sessionId: string;
    expiresAt: Date;
  }): Promise<void> {
    if (!mongoose.isValidObjectId(input.userId)) return;

    await ExtractorSessionModel.updateOne(
      { tenantId: input.tenantId, userId: new mongoose.Types.ObjectId(input.userId) },
      { $set: { sessionId: input.sessionId, expiresAt: input.expiresAt } },
      { upsert: true },
    ).exec();
  },

  async deleteSession(tenantId: string, userId: string): Promise<void> {
    if (!mongoose.isValidObjectId(userId)) return;

    await ExtractorSessionModel.deleteOne({
      tenantId,
      userId: new mongoose.Types.ObjectId(userId),
    }).exec();
  },

  /* ── The caller's identity ─────────────────────────────────────────────── */

  /**
   * The signed-in user's email and name.
   *
   * ── Why this is a separate read and not taken from `req.auth` ─────────────
   * `requireAuth` carries `userId`, `name`, `roles` and `accountId` — no email,
   * because nothing else in the product needs one to authorise an action. The
   * extractor does: `POST /sessions` identifies a user by address.
   *
   * Kept lean deliberately. `userRepository.findById` joins devices and
   * sign-in history for the user detail screen, and none of that is wanted on
   * the path that renders an iframe.
   */
  async findIdentity(userId: string): Promise<ExtractorIdentity | null> {
    if (!mongoose.isValidObjectId(userId)) return null;

    const row = await UserModel.findById(userId).select({ email: 1, name: 1 }).lean();
    if (!row) return null;

    return { email: row.email ?? null, name: row.name };
  },
};
