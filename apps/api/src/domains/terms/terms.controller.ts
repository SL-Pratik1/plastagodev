import type { TermsConfirmSchema, TermsSigningSchema, TermsUploadRequestSchema } from '@plastago/shared';
import type { Response } from 'express';
import { AppError } from '../../lib/app-error.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import type { TermsAccountParamsSchema, TermsVersionParamsSchema } from './terms.schemas.js';
import { termsService, type Caller } from './terms.service.js';

/** Controller layer — HTTP in, HTTP out. No business rules, no Mongoose. */

export function termsCallerFrom(req: { auth?: Express.Request['auth'] }): Caller {
  if (!req.auth) throw AppError.unauthenticated('Sign in to continue');

  return {
    userId: req.auth.userId,
    name: req.auth.name,
    roles: req.auth.roles as Caller['roles'],
    accountId: req.auth.accountId,
  };
}

export const termsController = {
  /* ── The office ──────────────────────────────────────────────────────── */

  library: async (req: ValidatedRequest<object>, res: Response): Promise<void> => {
    res.json(await termsService.library(termsCallerFrom(req)));
  },

  presignUpload: async (
    req: ValidatedRequest<{ body: typeof TermsUploadRequestSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await termsService.presignUpload(req.validated.body, termsCallerFrom(req)));
  },

  /** 200 with the library, so the screen shows the new version at once. */
  confirmUpload: async (
    req: ValidatedRequest<{ body: typeof TermsConfirmSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await termsService.confirmUpload(req.validated.body, termsCallerFrom(req)));
  },

  documentUrl: async (
    req: ValidatedRequest<{ params: typeof TermsVersionParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await termsService.documentUrl(req.validated.params.version, termsCallerFrom(req)));
  },

  signedCopyUrl: async (
    req: ValidatedRequest<{ params: typeof TermsAccountParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await termsService.signedCopyUrl(req.validated.params.accountId, termsCallerFrom(req)));
  },

  /* ── The portal ─────────────────────────────────────────────────────── */

  status: async (req: ValidatedRequest<object>, res: Response): Promise<void> => {
    res.json(await termsService.status(termsCallerFrom(req)));
  },

  currentDocument: async (req: ValidatedRequest<object>, res: Response): Promise<void> => {
    res.json(await termsService.currentDocumentUrl(termsCallerFrom(req)));
  },

  mySignedCopy: async (req: ValidatedRequest<object>, res: Response): Promise<void> => {
    res.json(await termsService.mySignedCopyUrl(termsCallerFrom(req)));
  },

  /**
   * The IP is Express's, behind the one proxy `trust proxy` allows — the same
   * address the sign-in rate limit keys on.
   */
  sign: async (
    req: ValidatedRequest<{ body: typeof TermsSigningSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(
      await termsService.sign(req.validated.body, termsCallerFrom(req), {
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }),
    );
  },
};
