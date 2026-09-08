import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { rosterController } from './roster.controller.js';
import { DriverIdParamsSchema, ListDriversQuerySchema } from './roster.schemas.js';

/**
 * Router layer — paths and middleware only. No logic.
 *
 * Mounted at `/drivers`, which is the office's word for this. `/driver`
 * (singular) is the driver's own app and a different audience entirely — see the
 * note at the top of `roster.model.ts`.
 */
export const rosterRouter = Router();

rosterRouter.use(requireAuth);
rosterRouter.use(requireRole('super-admin', 'operations', 'office-staff', 'allocator'));

rosterRouter.get(
  '/',
  validate({ query: ListDriversQuerySchema }),
  asyncHandler(rosterController.list),
);

rosterRouter.get(
  '/:id',
  validate({ params: DriverIdParamsSchema }),
  asyncHandler(rosterController.get),
);
