import * as z from 'zod';
import { IsoDateTimeSchema, NonEmptyStringSchema } from './primitives.js';

/**
 * Terms and conditions, and the customer's signed acceptance (Matt, 21 Oct).
 *
 * *"I need a place where I can upload those terms, and them having to sign it,
 * and record… their agreeance and the IP address that they used to agree."*
 *
 * ── Two halves ────────────────────────────────────────────────────────────
 * The office uploads the terms as a PDF; every upload is a new VERSION, and the
 * newest is the one customers sign. A customer administrator whose account was
 * opened with the onboarding tick on signs the current version on first sign-in
 * — and again whenever a newer version is uploaded.
 *
 * ⚠️ Not the `termsacceptances` collection removed on 15 Sep. Those rows are
 * left untouched; this is a new record with the signature itself in it.
 */

/** One uploaded version of the terms. */
export const TermsDocumentSchema = z
  .object({
    version: z.number().int().positive(),
    fileName: NonEmptyStringSchema,
    uploadedAt: IsoDateTimeSchema,
    uploadedBy: NonEmptyStringSchema,
  })
  .meta({ id: 'TermsDocument' });

/** Every version, newest first; `current` is the one customers sign. */
export const TermsLibrarySchema = z
  .object({
    current: TermsDocumentSchema.nullable(),
    versions: z.array(TermsDocumentSchema),
  })
  .meta({ id: 'TermsLibrary' });

/** Somewhere to PUT a new version of the terms. PDF only. */
export const TermsUploadRequestSchema = z
  .object({
    contentType: z.literal('application/pdf', { error: 'Upload the terms as a PDF' }),
    contentLength: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024, 'Keep the terms under 10 MB'),
  })
  .meta({ id: 'TermsUploadRequest' });

/** The bytes have landed — make them the new version. */
export const TermsConfirmSchema = z
  .object({
    key: z.string().trim().min(1).max(300),
    fileName: z
      .string()
      .trim()
      .min(1, 'Name the file')
      .max(120, 'Keep the file name under 120 characters'),
  })
  .meta({ id: 'TermsConfirm' });

/**
 * A drawn signature, exactly as the browser's canvas exports it.
 *
 * A PNG data URL and nothing else, capped well above a real signature's size —
 * this is stored, embedded in the signed copy, and shown to the office.
 */
export const SignatureImageSchema = z
  .string({ error: 'Draw your signature' })
  .max(400_000, 'That signature is too large — clear it and sign again')
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, 'Draw your signature');

/**
 * Signing the current terms, with the director's guarantee.
 *
 * Decided 21 Oct: the guarantee asks for the director's full name, residential
 * address and signature — to be confirmed against Matt's paper form.
 */
export const TermsSigningSchema = z
  .object({
    /** The version the customer read. Refused if a newer one was uploaded meanwhile. */
    version: z.number().int().positive(),
    directorName: z
      .string()
      .trim()
      .min(2, 'Enter the director’s full name')
      .max(120, 'Keep the name under 120 characters'),
    directorAddress: z
      .string()
      .trim()
      .min(5, 'Enter the director’s residential address')
      .max(200, 'Keep the address under 200 characters'),
    directorSignature: SignatureImageSchema,
    signerName: z
      .string()
      .trim()
      .min(2, 'Type your full name')
      .max(120, 'Keep the name under 120 characters'),
    signature: SignatureImageSchema,
    hasReadTerms: z.literal(true, { error: 'Open and read the terms first' }),
  })
  .meta({ id: 'TermsSigning' });

/** Where a customer administrator is with signing — the portal's first-login steps. */
export const PortalTermsStatusSchema = z
  .object({
    /** True while they must finish before using the portal. */
    required: z.boolean(),
    /** Step 1: their company details are on file. */
    detailsCompleted: z.boolean(),
    current: TermsDocumentSchema.nullable(),
    /** The version their account last signed, if any. */
    signedVersion: z.number().int().positive().nullable(),
    /** The director from the last signing, so a new version does not start blank. */
    lastDirector: z.object({ name: z.string(), address: z.string() }).nullable(),
    /** Their account's last signing, shown on their Account page (23 Oct). */
    signed: z
      .object({
        version: z.number().int().positive(),
        signedAt: IsoDateTimeSchema,
        signerName: NonEmptyStringSchema,
      })
      .nullable()
      .default(null),
  })
  .meta({ id: 'PortalTermsStatus' });

/** What the office sees on the customer: who signed, when, from where. */
export const TermsSignatureSummarySchema = z
  .object({
    version: z.number().int().positive(),
    signedAt: IsoDateTimeSchema,
    signerName: NonEmptyStringSchema,
    directorName: NonEmptyStringSchema,
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
  })
  .meta({ id: 'TermsSignatureSummary' });

export type TermsDocument = z.infer<typeof TermsDocumentSchema>;
export type TermsLibrary = z.infer<typeof TermsLibrarySchema>;
export type TermsUploadRequest = z.infer<typeof TermsUploadRequestSchema>;
export type TermsConfirm = z.infer<typeof TermsConfirmSchema>;
export type TermsSigning = z.infer<typeof TermsSigningSchema>;
export type PortalTermsStatus = z.infer<typeof PortalTermsStatusSchema>;
export type TermsSignatureSummary = z.infer<typeof TermsSignatureSummarySchema>;
