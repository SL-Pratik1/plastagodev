import type {
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
import type { Response } from 'express';
import { AppError } from '../../lib/app-error.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { driverService, type DriverCaller } from './driver.service.js';
import type {
  DateQuerySchema,
  JobIdParamsSchema,
  PhotoParamsSchema,
  PresignDefectPhotoSchema,
  PresignDocketPhotoSchema,
  PresignPhotoSchema,
  PreviewTipOffSchema,
  RunIdParamsSchema,
  SendMessageSchema,
} from './driver.schemas.js';

/**
 * Controller layer — HTTP in, HTTP out. No business rules, no Mongoose.
 *
 * Handlers are arrow-function properties, not methods: Express receives them as
 * bare references, so a `this`-bound method would silently lose its receiver.
 */

/**
 * The signed-in driver.
 *
 * Throws rather than defaulting if `req.auth` is missing — that means the route
 * was mounted without `requireAuth`, which is a wiring mistake to find loudly in
 * development rather than a request to serve anonymously.
 */
function callerFrom(req: { auth?: Express.Request['auth'] }): DriverCaller {
  if (!req.auth) throw AppError.unauthenticated('Sign in to continue');

  return {
    userId: req.auth.userId,
    name: req.auth.name,
    /*
     * Null here on purpose — the auth token says who signed in, not what they
     * are driving. The service resolves the pairing when a request actually
     * needs it (`resolveVehicle` in `driver.service.ts`), so the 15 handlers
     * that do not care about a truck pay nothing for the lookup.
     */
    vehicleRego: null,
  };
}

export const driverController = {
  runSheet: async (
    req: ValidatedRequest<{ query: typeof DateQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await driverService.runSheet(req.validated.query.date, callerFrom(req)));
  },

  job: async (
    req: ValidatedRequest<{ params: typeof JobIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await driverService.job(req.validated.params.jobId, callerFrom(req)));
  },

  updateStatus: async (
    req: ValidatedRequest<{ params: typeof JobIdParamsSchema; body: typeof StatusUpdateSchema }>,
    res: Response,
  ): Promise<void> => {
    await driverService.updateStatus(req.validated.params.jobId, req.validated.body, callerFrom(req));
    res.status(204).send();
  },

  complete: async (
    req: ValidatedRequest<{ params: typeof JobIdParamsSchema; body: typeof CompletionSchema }>,
    res: Response,
  ): Promise<void> => {
    await driverService.complete(req.validated.params.jobId, req.validated.body, callerFrom(req));
    res.status(204).send();
  },

  captureWeights: async (
    req: ValidatedRequest<{ params: typeof JobIdParamsSchema; body: typeof WeightCaptureSchema }>,
    res: Response,
  ): Promise<void> => {
    await driverService.captureWeights(
      req.validated.params.jobId,
      req.validated.body,
      callerFrom(req),
    );
    res.status(204).send();
  },

  /**
   * 201 with the upload URL — the photo RECORD exists, the bytes do not yet.
   * The phone PUTs them to `upload.uploadUrl` itself (§6A.10 #9).
   */
  presignPhoto: async (
    req: ValidatedRequest<{ params: typeof JobIdParamsSchema; body: typeof PresignPhotoSchema }>,
    res: Response,
  ): Promise<void> => {
    const result = await driverService.presignPhoto(
      req.validated.params.jobId,
      req.validated.body,
      callerFrom(req),
    );
    res.status(201).json(result);
  },

  /**
   * 204 — the phone confirming its PUT landed, so the tick can be honest.
   *
   * Idempotent: a retried confirmation after a timeout is the normal case on a
   * building site, not an error worth telling the driver about.
   */
  confirmPhotoUpload: async (
    req: ValidatedRequest<{ params: typeof PhotoParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    await driverService.confirmPhotoUpload(
      req.validated.params.jobId,
      req.validated.params.photoId,
      callerFrom(req),
    );
    res.status(204).send();
  },

  removePhoto: async (
    req: ValidatedRequest<{ params: typeof PhotoParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    await driverService.removePhoto(
      req.validated.params.jobId,
      req.validated.params.photoId,
      callerFrom(req),
    );
    res.status(204).send();
  },

  markFutile: async (
    req: ValidatedRequest<{ params: typeof JobIdParamsSchema; body: typeof FutileReportSchema }>,
    res: Response,
  ): Promise<void> => {
    await driverService.markFutile(req.validated.params.jobId, req.validated.body, callerFrom(req));
    res.status(204).send();
  },

  markContaminated: async (
    req: ValidatedRequest<{
      params: typeof JobIdParamsSchema;
      body: typeof ContaminationReportSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    /*
     * 200 with a body rather than 204, because the phone has to be able to tell
     * the driver whether a charge was actually raised. A job carries one
     * contamination charge at most, so a second report raises nothing — and on a
     * 204 the screen cheerfully said "a charge goes to the office for approval"
     * either way.
     */
    const outcome = await driverService.markContaminated(
      req.validated.params.jobId,
      req.validated.body,
      callerFrom(req),
    );
    res.status(200).json(outcome);
  },

  submitPreStart: async (
    req: ValidatedRequest<{ body: typeof PreStartSubmissionSchema }>,
    res: Response,
  ): Promise<void> => {
    await driverService.submitPreStart(req.validated.body, callerFrom(req));
    res.status(204).send();
  },

  submitRiskAssessment: async (
    req: ValidatedRequest<{ body: typeof SiteRiskAssessmentSchema }>,
    res: Response,
  ): Promise<void> => {
    await driverService.submitRiskAssessment(req.validated.body, callerFrom(req));
    res.status(204).send();
  },

  /** A READ that happens to take a body — see the note on the route. */
  previewTipOff: async (
    req: ValidatedRequest<{ params: typeof RunIdParamsSchema; body: typeof PreviewTipOffSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(
      await driverService.previewTipOff(
        req.validated.params.runId,
        req.validated.body.totalKg,
        callerFrom(req),
      ),
    );
  },

  /**
   * 201 with the upload URL. `photoId` here IS the storage key — see the note on
   * the service method for why a run docket has no photo record.
   */
  presignDocketPhoto: async (
    req: ValidatedRequest<{
      params: typeof RunIdParamsSchema;
      body: typeof PresignDocketPhotoSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    const result = await driverService.presignDocketPhoto(
      req.validated.params.runId,
      req.validated.body,
      callerFrom(req),
    );
    res.status(201).json(result);
  },

  /**
   * 201 with the upload URL for a defect photo, exactly like the docket one.
   * The key in `photoId` is what the defect report sends back in `photoIds`.
   */
  presignDefectPhoto: async (
    req: ValidatedRequest<{ body: typeof PresignDefectPhotoSchema }>,
    res: Response,
  ): Promise<void> => {
    const result = await driverService.presignDefectPhoto(req.validated.body, callerFrom(req));
    res.status(201).json(result);
  },

  recordTipOff: async (
    req: ValidatedRequest<{ body: typeof TipOffEntrySchema }>,
    res: Response,
  ): Promise<void> => {
    await driverService.recordTipOff(req.validated.body, callerFrom(req));
    res.status(204).send();
  },

  reportDefect: async (
    req: ValidatedRequest<{ body: typeof DefectReportSchema }>,
    res: Response,
  ): Promise<void> => {
    await driverService.reportDefect(req.validated.body, callerFrom(req));
    res.status(204).send();
  },

  sendMessage: async (
    req: ValidatedRequest<{ params: typeof JobIdParamsSchema; body: typeof SendMessageSchema }>,
    res: Response,
  ): Promise<void> => {
    await driverService.sendMessage(
      req.validated.params.jobId,
      req.validated.body.body,
      callerFrom(req),
    );
    res.status(204).send();
  },
};
