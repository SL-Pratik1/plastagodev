import type { JobChargeDraftSchema, JobCommentDraftSchema, JobDraftSchema } from '@plastago/shared';
import type { Request, Response } from 'express';
import { AppError } from '../../lib/app-error.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { jobService, type Caller } from './job.service.js';
import type {
  CancelJobBodySchema,
  JobIdParamsSchema,
  ListJobsQuerySchema,
  PurchaseOrderOptionsQuerySchema,
  RescheduleJobBodySchema,
} from './job.schemas.js';

/**
 * Controller layer — HTTP in, HTTP out. No business rules, no Mongoose.
 *
 * Handlers are arrow-function properties, not methods: Express receives them as
 * bare references, so a `this`-bound method would silently lose its receiver.
 */
export const jobController = {
  list: async (
    req: ValidatedRequest<{ query: typeof ListJobsQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    const result = await jobService.list(req.validated.query, callerOf(req));
    res.json(result);
  },

  get: async (
    req: ValidatedRequest<{ params: typeof JobIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    const job = await jobService.get(req.validated.params.id, callerOf(req));
    res.json(job);
  },

  /**
   * The estimate, before there is a job to attach it to.
   *
   * POST rather than GET despite computing nothing: the draft is a large
   * structured body, and a booking form's worth of fields does not belong in a
   * querystring where it would be logged in full.
   */
  preview: async (
    req: ValidatedRequest<{ body: typeof JobDraftSchema }>,
    res: Response,
  ): Promise<void> => {
    const preview = await jobService.preview(req.validated.body, callerOf(req));
    res.json(preview);
  },

  /** M2.12 — the purchase orders this account can book a pickup against. */
  purchaseOrders: async (
    req: ValidatedRequest<{ query: typeof PurchaseOrderOptionsQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    const { accountId, q } = req.validated.query;
    res.json(await jobService.purchaseOrders(accountId, q, callerOf(req)));
  },

  create: async (
    req: ValidatedRequest<{ body: typeof JobDraftSchema }>,
    res: Response,
  ): Promise<void> => {
    const job = await jobService.create(req.validated.body, callerOf(req));
    // 201 with the created row: the grid and the redirect both need its id.
    res.status(201).json(job);
  },

  cancel: async (
    req: ValidatedRequest<{
      params: typeof JobIdParamsSchema;
      body: typeof CancelJobBodySchema;
    }>,
    res: Response,
  ): Promise<void> => {
    const { reason, note } = req.validated.body;
    await jobService.cancel(req.validated.params.id, reason, note, callerOf(req));
    // 204: the caller already knows what it asked for, and the grid refetches.
    res.status(204).send();
  },

  reschedule: async (
    req: ValidatedRequest<{
      params: typeof JobIdParamsSchema;
      body: typeof RescheduleJobBodySchema;
    }>,
    res: Response,
  ): Promise<void> => {
    await jobService.reschedule(
      req.validated.params.id,
      req.validated.body.readyDate,
      callerOf(req),
    );
    res.status(204).send();
  },

  /**
   * Returns the created comment rather than 204: a driver comment carries a
   * delivery state (M8.6), and "did they get it" is part of the answer the
   * thread has to show.
   */
  addComment: async (
    req: ValidatedRequest<{
      params: typeof JobIdParamsSchema;
      body: typeof JobCommentDraftSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    const comment = await jobService.addComment(
      req.validated.params.id,
      req.validated.body,
      callerOf(req),
    );
    res.status(201).json(comment);
  },

  /** M6.5 — an extra the office adds from the configured price list. */
  addCharge: async (
    req: ValidatedRequest<{
      params: typeof JobIdParamsSchema;
      body: typeof JobChargeDraftSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    const charge = await jobService.addCharge(
      req.validated.params.id,
      req.validated.body,
      callerOf(req),
    );
    res.status(201).json(charge);
  },
};

/**
 * The caller, from the session the auth middleware already resolved.
 *
 * Throws rather than defaulting if `req.auth` is missing — that means the route
 * was mounted without `requireAuth`, which is a routing bug and must fail
 * loudly rather than quietly running unscoped.
 */
function callerOf(req: Request): Caller {
  if (!req.auth) throw AppError.unauthenticated('Sign in to continue');

  return {
    userId: req.auth.userId,
    name: req.auth.name,
    roles: req.auth.roles as Caller['roles'],
    accountId: req.auth.accountId,
  };
}
