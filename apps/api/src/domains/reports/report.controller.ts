import type { Response } from 'express';
import { AppError } from '../../lib/app-error.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { reportService, type Caller } from './report.service.js';
import type {
  CertificateIdParamsSchema,
  ListCertificatesQuerySchema,
  PrepareCertificateSchema,
  ReportFiltersQuerySchema,
} from './report.schemas.js';

/** Controller layer — HTTP in, HTTP out. No business rules, no Mongoose. */

function callerFrom(req: { auth?: Express.Request['auth'] }): Caller {
  if (!req.auth) throw AppError.unauthenticated('Sign in to continue');

  return {
    userId: req.auth.userId,
    name: req.auth.name,
    roles: req.auth.roles as Caller['roles'],
    accountId: req.auth.accountId,
  };
}

export const reportController = {
  monthlyVolume: async (
    req: ValidatedRequest<{ query: typeof ReportFiltersQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await reportService.monthlyVolume(req.validated.query, callerFrom(req)));
  },

  zoneVolume: async (
    req: ValidatedRequest<{ query: typeof ReportFiltersQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await reportService.zoneVolume(req.validated.query, callerFrom(req)));
  },

  financial: async (
    req: ValidatedRequest<{ query: typeof ReportFiltersQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await reportService.financial(req.validated.query, callerFrom(req)));
  },

  certificates: async (
    req: ValidatedRequest<{ query: typeof ListCertificatesQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await reportService.certificates(req.validated.query, callerFrom(req)));
  },

  /** 201 with the DRAFT. Issuing is a separate, deliberate act. */
  prepareCertificate: async (
    req: ValidatedRequest<{ body: typeof PrepareCertificateSchema }>,
    res: Response,
  ): Promise<void> => {
    res.status(201).json(await reportService.prepareCertificate(req.validated.body, callerFrom(req)));
  },

  issueCertificate: async (
    req: ValidatedRequest<{ params: typeof CertificateIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await reportService.issueCertificate(req.validated.params.id, callerFrom(req)));
  },

  /** `{ url }` — a short-lived link, never the storage key. */
  certificatePdf: async (
    req: ValidatedRequest<{ params: typeof CertificateIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await reportService.certificatePdfUrl(req.validated.params.id, callerFrom(req)));
  },

  resendCertificate: async (
    req: ValidatedRequest<{ params: typeof CertificateIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await reportService.resendCertificate(req.validated.params.id, callerFrom(req)));
  },
};
