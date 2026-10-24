import { Schema, model } from 'mongoose';

export const TERMS_DOCUMENTS_COLLECTION = 'termsdocuments';
export const TERMS_SIGNATURES_COLLECTION = 'termssignatures';

/**
 * One uploaded version of the terms and conditions (Matt, 21 Oct).
 *
 * *"I need a place where I can upload those terms."* Every upload is a new
 * version; nothing is overwritten, because a customer's signature points at
 * the exact document they read.
 */
const termsDocumentSchema = new Schema(
  {
    version: { type: Number, required: true, min: 1 },
    /** As the office named it — shown back to them and to the customer. */
    fileName: { type: String, required: true, trim: true },
    /** Where the PDF lives. The API serves a URL; it stores no bytes. */
    storageKey: { type: String, required: true },
    uploadedAt: { type: Date, required: true },
    /** REFERENCE → `users._id` — who uploaded it. */
    uploadedById: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    /** Their name at the time, frozen for display. */
    uploadedBy: { type: String, required: true, trim: true },
  },
  { collection: TERMS_DOCUMENTS_COLLECTION, timestamps: true, versionKey: false },
);

/** One row per version — two uploads racing cannot both become "version 3". */
termsDocumentSchema.index({ version: 1 }, { unique: true, name: 'version_unique' });

export const TermsDocumentModel = model('TermsDocument', termsDocumentSchema);

/**
 * A customer's signed acceptance of one version, with the director's guarantee.
 *
 * Matt, 21 Oct: *"record… their agreeance and the IP address that they used to
 * agree"*. Wendell: *"they signed it on this particular date. Here's the actual
 * signature… time stamp… IP address."* So the record is the evidence: who, the
 * drawn signatures, when, from which IP and browser, and which version.
 *
 * ⚠️ NOT the old `termsacceptances` collection, which is left untouched.
 */
const termsSignatureSchema = new Schema(
  {
    /** REFERENCE → `accounts._id`. The account is what is bound by it. */
    accountId: { type: Schema.Types.ObjectId, required: true, ref: 'Account' },
    /** REFERENCE → `users._id` — the customer administrator who signed. */
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    version: { type: Number, required: true, min: 1 },
    signedAt: { type: Date, required: true },

    /** The name they typed, and their drawn signature (a PNG in storage). */
    signerName: { type: String, required: true, trim: true },
    signatureKey: { type: String, required: true },

    /** The director's guarantee — fields to confirm against Matt's paper form. */
    directorName: { type: String, required: true, trim: true },
    directorAddress: { type: String, required: true, trim: true },
    directorSignatureKey: { type: String, required: true },

    /** Where they signed from. Null only when the request did not say. */
    ip: { type: String, default: null, trim: true },
    userAgent: { type: String, default: null, trim: true },

    /**
     * The terms with the signing page appended — what the office downloads.
     * Null if it could not be produced at signing; it is drawn on first download.
     */
    signedPdfKey: { type: String, default: null },
  },
  { collection: TERMS_SIGNATURES_COLLECTION, timestamps: true, versionKey: false },
);

/** One signing per account per version. A second admin finds it already done. */
termsSignatureSchema.index(
  { accountId: 1, version: 1 },
  { unique: true, name: 'account_version_unique' },
);

/** The customer page reads the latest. */
termsSignatureSchema.index({ accountId: 1, signedAt: -1 }, { name: 'account_signed' });

export const TermsSignatureModel = model('TermsSignature', termsSignatureSchema);
