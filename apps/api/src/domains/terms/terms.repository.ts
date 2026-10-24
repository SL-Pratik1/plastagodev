import mongoose from 'mongoose';
import { AccountModel } from '../accounts/account.model.js';
import { TermsDocumentModel, TermsSignatureModel } from './terms.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 */

export interface TermsDocumentRow {
  version: number;
  fileName: string;
  storageKey: string;
  uploadedAt: Date;
  uploadedBy: string;
}

export interface TermsSignatureRow {
  id: string;
  accountId: string;
  version: number;
  signedAt: Date;
  signerName: string;
  signatureKey: string;
  directorName: string;
  directorAddress: string;
  directorSignatureKey: string;
  ip: string | null;
  userAgent: string | null;
  signedPdfKey: string | null;
}

interface RawSignature extends Omit<TermsSignatureRow, 'id' | 'accountId'> {
  _id: mongoose.Types.ObjectId;
  accountId: mongoose.Types.ObjectId;
}

export const termsRepository = {
  /** The version customers sign today, or null before any upload. */
  async currentDocument(): Promise<TermsDocumentRow | null> {
    return TermsDocumentModel.findOne().sort({ version: -1 }).lean<TermsDocumentRow>();
  },

  async findDocument(version: number): Promise<TermsDocumentRow | null> {
    return TermsDocumentModel.findOne({ version }).lean<TermsDocumentRow>();
  },

  /** Every version, newest first. */
  async listDocuments(): Promise<TermsDocumentRow[]> {
    return TermsDocumentModel.find().sort({ version: -1 }).lean<TermsDocumentRow[]>();
  },

  /**
   * Adds the next version.
   *
   * Returns null when another upload took that number in the same moment — the
   * unique index decides, and the caller says so rather than overwriting.
   */
  async createDocument(input: {
    fileName: string;
    storageKey: string;
    uploadedById: string;
    uploadedBy: string;
  }): Promise<TermsDocumentRow | null> {
    const latest = await TermsDocumentModel.findOne().sort({ version: -1 }).select({ version: 1 }).lean<{ version: number }>();

    try {
      const created = await TermsDocumentModel.create({
        version: (latest?.version ?? 0) + 1,
        fileName: input.fileName,
        storageKey: input.storageKey,
        uploadedAt: new Date(),
        uploadedById: new mongoose.Types.ObjectId(input.uploadedById),
        uploadedBy: input.uploadedBy,
      });
      return created.toObject<TermsDocumentRow>();
    } catch (error) {
      if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) return null;
      throw error;
    }
  },

  /** What the account was set up to do, and the first step of signing. */
  async accountTerms(accountId: string): Promise<{
    name: string;
    code: string;
    termsRequired: boolean;
    detailsCompleted: boolean;
  } | null> {
    if (!mongoose.isValidObjectId(accountId)) return null;

    const row = await AccountModel.findById(accountId)
      .select({ name: 1, code: 1, termsRequired: 1, detailsCompletedAt: 1 })
      .lean<{ name: string; code: string; termsRequired?: boolean; detailsCompletedAt?: Date | null }>();

    return row
      ? {
          name: row.name,
          code: row.code,
          // Absent on accounts opened before 21 Oct: they were never asked.
          termsRequired: row.termsRequired ?? false,
          detailsCompleted: Boolean(row.detailsCompletedAt),
        }
      : null;
  },

  async latestSignature(accountId: string): Promise<TermsSignatureRow | null> {
    if (!mongoose.isValidObjectId(accountId)) return null;

    const row = await TermsSignatureModel.findOne({ accountId: new mongoose.Types.ObjectId(accountId) })
      .sort({ signedAt: -1 })
      .lean<RawSignature>();

    return row ? toRow(row) : null;
  },

  async hasSigned(accountId: string, version: number): Promise<boolean> {
    if (!mongoose.isValidObjectId(accountId)) return false;
    const count = await TermsSignatureModel.countDocuments({
      accountId: new mongoose.Types.ObjectId(accountId),
      version,
    });
    return count > 0;
  },

  /** Records a signing. Null when this account has already signed this version. */
  async createSignature(input: Omit<TermsSignatureRow, 'id' | 'signedPdfKey'> & { userId: string }): Promise<string | null> {
    try {
      const created = await TermsSignatureModel.create({
        ...input,
        accountId: new mongoose.Types.ObjectId(input.accountId),
        userId: new mongoose.Types.ObjectId(input.userId),
        signedPdfKey: null,
      });
      return created._id.toHexString();
    } catch (error) {
      if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) return null;
      throw error;
    }
  },

  async setSignedPdfKey(id: string, key: string): Promise<void> {
    await TermsSignatureModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { signedPdfKey: key } },
    );
  },
};

function toRow(row: RawSignature): TermsSignatureRow {
  return {
    id: row._id.toHexString(),
    accountId: row.accountId.toHexString(),
    version: row.version,
    signedAt: row.signedAt,
    signerName: row.signerName,
    signatureKey: row.signatureKey,
    directorName: row.directorName,
    directorAddress: row.directorAddress,
    directorSignatureKey: row.directorSignatureKey,
    ip: row.ip ?? null,
    userAgent: row.userAgent ?? null,
    signedPdfKey: row.signedPdfKey ?? null,
  };
}
