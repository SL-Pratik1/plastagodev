import type {
  CallUpRequestSchema,
  PortalBookingDraftSchema,
  PortalChangeRequestSchema,
  PortalJobEditSchema,
  PortalJobMessageDraftSchema,
  ReadinessCertificationSchema,
} from '@plastago/shared';
import type { Response } from 'express';
import { AppError } from '../../lib/app-error.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { portalService, type Caller } from './portal.service.js';
import type {
  PortalAwaitingQuerySchema,
  PortalJobIdParamsSchema,
  PortalJobsQuerySchema,
  PortalPurchaseOrderIdParamsSchema,
  SetUrgencySchema,
} from './portal.schemas.js';

/** Controller layer — HTTP in, HTTP out. No business rules, no Mongoose. */

function callerFrom(req: { auth?: Express.Request['auth'] }): Caller {
  if (!req.auth) throw AppError.unauthenticated('Sign in to continue');

  return {
    userId: req.auth.userId,
    name: req.auth.name,
    roles: req.auth.roles as Caller['roles'],
    // From the SESSION. See the note on `portal.schemas.ts`.
    accountId: req.auth.accountId,
  };
}

export const portalController = {
  scope: async (req: ValidatedRequest<object>, res: Response): Promise<void> => {
    res.json(await portalService.scope(callerFrom(req)));
  },

  dashboard: async (req: ValidatedRequest<object>, res: Response): Promise<void> => {
    res.json(await portalService.dashboard(callerFrom(req)));
  },

  jobs: async (
    req: ValidatedRequest<{ query: typeof PortalJobsQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await portalService.jobs(req.validated.query, callerFrom(req)));
  },

  job: async (
    req: ValidatedRequest<{ params: typeof PortalJobIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await portalService.job(req.validated.params.id, callerFrom(req)));
  },

  book: async (
    req: ValidatedRequest<{ body: typeof PortalBookingDraftSchema }>,
    res: Response,
  ): Promise<void> => {
    res.status(201).json(await portalService.book(req.validated.body, callerFrom(req)));
  },

  quote: async (
    req: ValidatedRequest<{ body: typeof PortalBookingDraftSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await portalService.quote(req.validated.body, callerFrom(req)));
  },

  /** M2.12b — orders on this account that nobody has booked a date for yet. */
  awaitingCallUp: async (
    req: ValidatedRequest<{ query: typeof PortalAwaitingQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await portalService.awaitingCallUp(req.validated.query, callerFrom(req)));
  },

  /**
   * Calling one of them up (Matt, 30:40).
   *
   * 201: this creates a call-up, and where the order resolves cleanly it creates
   * the job too. The body says which, because a call-up that landed in the
   * office queue instead is otherwise indistinguishable from a booked one.
   */
  callUp: async (
    req: ValidatedRequest<{
      params: typeof PortalPurchaseOrderIdParamsSchema;
      body: typeof CallUpRequestSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    const outcome = await portalService.callUp(
      req.validated.params.purchaseOrderId,
      req.validated.body,
      callerFrom(req),
    );

    res.status(201).json(outcome);
  },

  editJob: async (
    req: ValidatedRequest<{
      params: typeof PortalJobIdParamsSchema;
      body: typeof PortalJobEditSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    res.json(
      await portalService.editJob(req.validated.params.id, req.validated.body, callerFrom(req)),
    );
  },

  requestChange: async (
    req: ValidatedRequest<{
      params: typeof PortalJobIdParamsSchema;
      body: typeof PortalChangeRequestSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    await portalService.requestChange(
      req.validated.params.id,
      req.validated.body,
      callerFrom(req),
    );
    res.status(204).send();
  },

  setUrgency: async (
    req: ValidatedRequest<{
      params: typeof PortalJobIdParamsSchema;
      body: typeof SetUrgencySchema;
    }>,
    res: Response,
  ): Promise<void> => {
    res.json(
      await portalService.setUrgency(
        req.validated.params.id,
        req.validated.body.urgent,
        callerFrom(req),
      ),
    );
  },

  /** 201: a new message on the thread, returned so the portal can show it at once. */
  postMessage: async (
    req: ValidatedRequest<{
      params: typeof PortalJobIdParamsSchema;
      body: typeof PortalJobMessageDraftSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    res
      .status(201)
      .json(
        await portalService.postMessage(
          req.validated.params.id,
          req.validated.body,
          callerFrom(req),
        ),
      );
  },

  certifyReadiness: async (
    req: ValidatedRequest<{
      params: typeof PortalJobIdParamsSchema;
      body: typeof ReadinessCertificationSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    res.json(
      await portalService.certifyReadiness(
        req.validated.params.id,
        req.validated.body,
        callerFrom(req),
      ),
    );
  },
};
