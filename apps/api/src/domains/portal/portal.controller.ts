import type {
  PortalBookingDraftSchema,
  PortalChangeRequestSchema,
  PortalJobEditSchema,
  ReadinessCertificationSchema,
} from '@plastago/shared';
import type { Response } from 'express';
import { AppError } from '../../lib/app-error.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { portalService, type Caller } from './portal.service.js';
import type {
  PortalJobIdParamsSchema,
  PortalJobsQuerySchema,
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
