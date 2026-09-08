import type { FutileDecisionSchema } from '@plastago/shared';
import type { Response } from 'express';
import { AppError } from '../../lib/app-error.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { queueService, type Caller } from './queue.service.js';
import type {
  ChargeDecisionBodySchema,
  QueueIdParamsSchema,
  QueueIdsSchema,
  QueueListQuerySchema,
} from './queue.schemas.js';

/**
 * Controller layer — HTTP in, HTTP out. No business rules, no Mongoose.
 *
 * Handlers are arrow-function properties, not methods: Express receives them as
 * bare references, so a `this`-bound method would silently lose its receiver.
 */

function callerFrom(req: { auth?: Express.Request['auth'] }): Caller {
  if (!req.auth) throw AppError.unauthenticated('Sign in to continue');

  return {
    userId: req.auth.userId,
    name: req.auth.name,
    roles: req.auth.roles as Caller['roles'],
  };
}

export const queueController = {
  counts: async (req: ValidatedRequest<object>, res: Response): Promise<void> => {
    res.json(await queueService.counts(callerFrom(req)));
  },

  /* ── M2.6 · Futile review ──────────────────────────────────────────────── */

  futileList: async (
    req: ValidatedRequest<{ query: typeof QueueListQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await queueService.futileList(req.validated.query, callerFrom(req)));
  },

  futileGet: async (
    req: ValidatedRequest<{ params: typeof QueueIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await queueService.futileGet(req.validated.params.id, callerFrom(req)));
  },

  futileDecide: async (
    req: ValidatedRequest<{
      params: typeof QueueIdParamsSchema;
      body: typeof FutileDecisionSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    await queueService.futileDecide(req.validated.params.id, req.validated.body, callerFrom(req));
    res.status(204).send();
  },

  /* ── M2.7 · Charge approvals ───────────────────────────────────────────── */

  approvalList: async (
    req: ValidatedRequest<{ query: typeof QueueListQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await queueService.approvalList(req.validated.query, callerFrom(req)));
  },

  approvalGet: async (
    req: ValidatedRequest<{ params: typeof QueueIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await queueService.approvalGet(req.validated.params.id, callerFrom(req)));
  },

  /** Returns the COUNT that changed — a bulk decision is expected to be partial. */
  approvalDecide: async (
    req: ValidatedRequest<{ body: typeof ChargeDecisionBodySchema }>,
    res: Response,
  ): Promise<void> => {
    const changed = await queueService.approvalDecide(
      req.validated.body.ids,
      { decision: req.validated.body.decision, note: req.validated.body.note },
      callerFrom(req),
    );
    res.json({ changed });
  },

  /* ── M7.3 · Awaiting a purchase order ──────────────────────────────────── */

  awaitingPoList: async (
    req: ValidatedRequest<{ query: typeof QueueListQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await queueService.awaitingPoList(req.validated.query, callerFrom(req)));
  },

  awaitingPoChase: async (
    req: ValidatedRequest<{ body: typeof QueueIdsSchema }>,
    res: Response,
  ): Promise<void> => {
    const changed = await queueService.awaitingPoChase(req.validated.body.ids, callerFrom(req));
    res.json({ changed });
  },
};
