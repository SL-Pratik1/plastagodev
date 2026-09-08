import type { Response } from 'express';
import { Router } from 'express';
import { AppError } from '../../lib/app-error.js';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { dashboardService } from './dashboard.service.js';
import type { Caller } from './dashboard.service.js';

/**
 * M9.4 · F15 — the admin dashboard.
 *
 * One route, one call. Everything the screen needs comes back together, because
 * eleven round trips means eleven chances to render half a dashboard.
 *
 * ── Controller and router in one file ─────────────────────────────────────
 * A separate controller for a single passthrough handler would be a file that
 * exists to satisfy a pattern rather than to do anything. The layering rule is
 * about keeping Mongoose out of the transport, and it still holds.
 */
export const dashboardRouter = Router();

dashboardRouter.use(requireAuth);
dashboardRouter.use(requireRole('super-admin', 'operations', 'office-staff', 'allocator'));

function callerFrom(req: { auth?: Express.Request['auth'] }): Caller {
  if (!req.auth) throw AppError.unauthenticated('Sign in to continue');

  return {
    userId: req.auth.userId,
    name: req.auth.name,
    roles: req.auth.roles as Caller['roles'],
  };
}

dashboardRouter.get(
  '/',
  asyncHandler(async (req: ValidatedRequest<object>, res: Response): Promise<void> => {
    res.json(await dashboardService.summary(callerFrom(req)));
  }),
);
