import type { Response } from 'express';
import { Router } from 'express';
import { AppError } from '../../lib/app-error.js';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth } from '../../middleware/require-auth.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { lookupService, type Caller } from './lookup.service.js';

/**
 * Reference lists (M-wide) — three routes, all GETs, all cacheable.
 *
 * ── Controller and router in one file ─────────────────────────────────────
 * Three identical passthrough handlers do not earn a separate controller file;
 * it would exist to satisfy a pattern rather than to do anything. The layering
 * rule is about keeping Mongoose out of the transport, and that still holds.
 *
 * ⚠️ Mounted at `/lookups` ALONGSIDE the place router, which owns
 * `/lookups/places`. Two routers on one prefix is deliberate: a suburb table is
 * a different domain from the customer register, with different access rules —
 * see `lookup.service.ts` — and merging them to save a mount would put a public
 * list and a commercially sensitive one behind the same guard.
 */
export const lookupRouter = Router();

lookupRouter.use(requireAuth);

function callerFrom(req: { auth?: Express.Request['auth'] }): Caller {
  if (!req.auth) throw AppError.unauthenticated('Sign in to continue');

  return {
    userId: req.auth.userId,
    name: req.auth.name,
    roles: req.auth.roles as Caller['roles'],
  };
}

lookupRouter.get(
  '/accounts',
  asyncHandler(async (req: ValidatedRequest<object>, res: Response): Promise<void> => {
    res.json(await lookupService.accounts(callerFrom(req)));
  }),
);

lookupRouter.get(
  '/builders',
  asyncHandler(async (req: ValidatedRequest<object>, res: Response): Promise<void> => {
    res.json(await lookupService.builders(callerFrom(req)));
  }),
);

lookupRouter.get(
  '/drivers',
  asyncHandler(async (req: ValidatedRequest<object>, res: Response): Promise<void> => {
    res.json(await lookupService.drivers(callerFrom(req)));
  }),
);

lookupRouter.get(
  '/zones',
  asyncHandler(async (req: ValidatedRequest<object>, res: Response): Promise<void> => {
    res.json(await lookupService.zones(callerFrom(req)));
  }),
);

lookupRouter.get(
  '/rate-cards',
  asyncHandler(async (req: ValidatedRequest<object>, res: Response): Promise<void> => {
    res.json(await lookupService.rateCards(callerFrom(req)));
  }),
);
