import type { CallUpRequestSchema } from '@plastago/shared';
import type { Response } from 'express';
import { AppError } from '../../lib/app-error.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import type { Caller } from '../jobs/job.service.js';
import { callUpService } from './call-up.service.js';
import type {
  CallUpIdParamsSchema,
  ListAwaitingQuerySchema,
  ListCallUpsQuerySchema,
  PurchaseOrderIdParamsSchema,
  RejectCallUpSchema,
} from './call-up.schemas.js';

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

export const callUpController = {
  list: async (
    req: ValidatedRequest<{ query: typeof ListCallUpsQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await callUpService.list(req.validated.query, callerFrom(req)));
  },

  get: async (
    req: ValidatedRequest<{ params: typeof CallUpIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await callUpService.get(req.validated.params.id, callerFrom(req)));
  },

  /**
   * Tries a queued call-up again, once whatever blocked it has been fixed.
   *
   * Answers with the outcome rather than 204: the retry may well land in the
   * queue again for a different reason, and the screen has to say so.
   */
  retry: async (
    req: ValidatedRequest<{ params: typeof CallUpIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await callUpService.retry(req.validated.params.id, callerFrom(req)));
  },

  /** Sets one aside as not actionable, with a reason. */
  reject: async (
    req: ValidatedRequest<{
      params: typeof CallUpIdParamsSchema;
      body: typeof RejectCallUpSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    await callUpService.reject(req.validated.params.id, req.validated.body.note, callerFrom(req));

    res.status(204).end();
  },

  /** Matt's *"sitting there waiting"* list (21:30) — orders with no job yet. */
  listAwaiting: async (
    req: ValidatedRequest<{ query: typeof ListAwaitingQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(
      await callUpService.listAwaiting(
        { ...req.validated.query, accountId: req.validated.query.accountId ?? null },
        callerFrom(req),
      ),
    );
  },

  /**
   * Calling an order up by hand (Matt, 30:40).
   *
   * 201 rather than 200: this creates a call-up record, and where it resolves
   * cleanly it creates a job as well. The body says which, because a call-up
   * that landed in the queue instead looks identical from the outside otherwise.
   */
  callUp: async (
    req: ValidatedRequest<{
      params: typeof PurchaseOrderIdParamsSchema;
      body: typeof CallUpRequestSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    const caller = callerFrom(req);

    const outcome = await callUpService.callUpByHand(
      req.validated.params.purchaseOrderId,
      req.validated.body,
      caller,
    );

    res.status(201).json(outcome);
  },
};
