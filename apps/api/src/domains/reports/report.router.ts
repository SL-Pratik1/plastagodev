import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { reportController } from './report.controller.js';
import {
  CertificateIdParamsSchema,
  ListCertificatesQuerySchema,
  PrepareCertificateSchema,
  ReportFiltersQuerySchema,
} from './report.schemas.js';

/**
 * Router layer — paths and middleware only. No logic.
 *
 * ── Why there is no generic report endpoint ───────────────────────────────
 * Three named routes and nothing else. F31's custom report builder is v1.1 and
 * Risk 5 names the WYSIWYG designer as the biggest single scope trap in the
 * project — a `POST /reports/run` taking a query object is exactly how that
 * starts, and it is far easier not to add one than to remove it later.
 */
export const reportRouter = Router();

reportRouter.use(requireAuth);
reportRouter.use(requireRole('super-admin', 'operations', 'office-staff'));

/**
 * M9.1 — the monthly pickup volume report.
 *
 * PARITY, not an improvement: PlastaGo produces this today and at least one
 * customer requires it.
 */
reportRouter.get(
  '/volume',
  validate({ query: ReportFiltersQuerySchema }),
  asyncHandler(reportController.monthlyVolume),
);

/** M9.3 — the Sydney / Wollongong / Newcastle split. */
reportRouter.get(
  '/zones',
  validate({ query: ReportFiltersQuerySchema }),
  asyncHandler(reportController.zoneVolume),
);

/**
 * M9.6 — the financial summary.
 *
 * Narrower than the others in the service: margin is for operations and
 * super-admins, not for everybody who can read a volume report.
 */
reportRouter.get(
  '/financial',
  validate({ query: ReportFiltersQuerySchema }),
  asyncHandler(reportController.financial),
);

/* ── M9.5 · F52 · diversion certificates ─────────────────────────────────── */

reportRouter.get(
  '/certificates',
  validate({ query: ListCertificatesQuerySchema }),
  asyncHandler(reportController.certificates),
);

/**
 * Prepares a DRAFT.
 *
 * Never issues directly: the figures freeze at issue, and going straight there
 * gives nobody the chance to notice an unreconciled tip-off.
 */
reportRouter.post(
  '/certificates',
  validate({ body: PrepareCertificateSchema }),
  asyncHandler(reportController.prepareCertificate),
);

/**
 * Freezes it, renders the PDF and emails the customer.
 *
 * Once issued it cannot be re-issued — see the service.
 */
reportRouter.post(
  '/certificates/:id/issue',
  validate({ params: CertificateIdParamsSchema }),
  asyncHandler(reportController.issueCertificate),
);

/**
 * A short-lived link to the stored PDF, for the office's own preview.
 *
 * ⚠️ POST rather than GET although it reads. It mints a credential — a signed
 * URL — and a GET would end up in browser history, in a referrer header and in
 * any proxy log between here and the office.
 */
reportRouter.post(
  '/certificates/:id/pdf',
  validate({ params: CertificateIdParamsSchema }),
  asyncHandler(reportController.certificatePdf),
);

/** Sends the STORED document again — never a fresh rendering of it. */
reportRouter.post(
  '/certificates/:id/resend',
  validate({ params: CertificateIdParamsSchema }),
  asyncHandler(reportController.resendCertificate),
);
