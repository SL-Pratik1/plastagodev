import {
  CompletionSchema,
  ContaminationReportSchema,
  DefectReportSchema,
  FutileReportSchema,
  PreStartSubmissionSchema,
  SiteRiskAssessmentSchema,
  StatusUpdateSchema,
  TipOffEntrySchema,
  WeightCaptureSchema,
} from '@plastago/shared';
import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { driverController } from './driver.controller.js';
import {
  DateQuerySchema,
  JobIdParamsSchema,
  PhotoParamsSchema,
  PresignPhotoSchema,
  PreviewTipOffSchema,
  RunIdParamsSchema,
  SendMessageSchema,
} from './driver.schemas.js';

/**
 * Router layer — paths and middleware only. No logic.
 *
 * ── Why the `driver` role is the whole gate ───────────────────────────────
 * Every route here answers "what am I, the signed-in driver, doing today". There
 * is no id in any path that identifies a driver, and no query that selects one:
 * the caller's own session IS the scope, and the repository folds it into every
 * filter. So a driver cannot read another driver's run sheet by changing a
 * parameter, because there is no parameter to change.
 *
 * Matt, 27:01 — an allocator who covers a shift holds both roles, so this admits
 * anybody WITH the driver role rather than anybody whose only role is driver.
 */
export const driverRouter = Router();

driverRouter.use(requireAuth);
driverRouter.use(requireRole('driver'));

/* ── Reads ───────────────────────────────────────────────────────────────── */

/**
 * M4.1 — the day. Takes a date rather than a cursor because a driver needs
 * *today*, and yesterday for the tip-off they forgot to record.
 */
driverRouter.get(
  '/run-sheet',
  validate({ query: DateQuerySchema }),
  asyncHandler(driverController.runSheet),
);

driverRouter.get(
  '/jobs/:jobId',
  validate({ params: JobIdParamsSchema }),
  asyncHandler(driverController.job),
);

/* ── M4.2 · status, with the driver's own timestamp and position ─────────── */

driverRouter.post(
  '/jobs/:jobId/status',
  validate({ params: JobIdParamsSchema, body: StatusUpdateSchema }),
  asyncHandler(driverController.updateStatus),
);

driverRouter.post(
  '/jobs/:jobId/complete',
  validate({ params: JobIdParamsSchema, body: CompletionSchema }),
  asyncHandler(driverController.complete),
);

/* ── M4.3 · weights ──────────────────────────────────────────────────────── */

driverRouter.post(
  '/jobs/:jobId/weights',
  validate({ params: JobIdParamsSchema, body: WeightCaptureSchema }),
  asyncHandler(driverController.captureWeights),
);

/* ── M4.5 · photos ───────────────────────────────────────────────────────── */

/**
 * Registers a photo and returns somewhere to PUT the bytes.
 *
 * The bytes do not come through this API — the phone uploads them straight to
 * object storage with the presigned URL in the response (§6A.10 #9).
 */
driverRouter.post(
  '/jobs/:jobId/photos',
  validate({ params: JobIdParamsSchema, body: PresignPhotoSchema }),
  asyncHandler(driverController.presignPhoto),
);

driverRouter.delete(
  '/jobs/:jobId/photos/:photoId',
  validate({ params: PhotoParamsSchema }),
  asyncHandler(driverController.removePhoto),
);

/* ── M4.6, M4.7 · the exception branches that carry charges ──────────────── */

driverRouter.post(
  '/jobs/:jobId/futile',
  validate({ params: JobIdParamsSchema, body: FutileReportSchema }),
  asyncHandler(driverController.markFutile),
);

driverRouter.post(
  '/jobs/:jobId/contamination',
  validate({ params: JobIdParamsSchema, body: ContaminationReportSchema }),
  asyncHandler(driverController.markContaminated),
);

/* ── M4.8 · pre-start and site risk ──────────────────────────────────────── */

driverRouter.post(
  '/pre-start',
  validate({ body: PreStartSubmissionSchema }),
  asyncHandler(driverController.submitPreStart),
);

driverRouter.post(
  '/risk-assessment',
  validate({ body: SiteRiskAssessmentSchema }),
  asyncHandler(driverController.submitRiskAssessment),
);

/* ── M4.4 · tip-off reconciliation ───────────────────────────────────────── */

/**
 * A READ, served over POST.
 *
 * The weighbridge figure is an input to a calculation, not a filter — and
 * putting a number the driver is about to commit into a query string would land
 * it in access logs and browser history on a device we do not control. Nothing
 * is written; the driver is being shown the answer so they can catch a mistyped
 * crane weight while still standing at the weighbridge.
 */
driverRouter.post(
  '/runs/:runId/tip-off/preview',
  validate({ params: RunIdParamsSchema, body: PreviewTipOffSchema }),
  asyncHandler(driverController.previewTipOff),
);

driverRouter.post(
  '/tip-off',
  validate({ body: TipOffEntrySchema }),
  asyncHandler(driverController.recordTipOff),
);

/* ── M4.9 · vehicle defects ──────────────────────────────────────────────── */

driverRouter.post(
  '/defects',
  validate({ body: DefectReportSchema }),
  asyncHandler(driverController.reportDefect),
);

/* ── M8.6 · W102 · the office ↔ driver thread ────────────────────────────── */

driverRouter.post(
  '/jobs/:jobId/messages',
  validate({ params: JobIdParamsSchema, body: SendMessageSchema }),
  asyncHandler(driverController.sendMessage),
);
