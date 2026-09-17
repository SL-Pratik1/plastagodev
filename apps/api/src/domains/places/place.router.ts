import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { PlaceWriteSchema } from '@plastago/shared';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { placeController } from './place.controller.js';
import { PlaceIdParamsSchema, SearchPlacesQuerySchema } from './place.schemas.js';

/**
 * Router layer — paths and middleware only. No logic.
 *
 * Every signed-in role reaches this, including a customer's site supervisor:
 * they book pickups in the portal and need the same suburb picker the office
 * uses. There is nothing account-specific in a list of suburbs, so there is
 * nothing here to scope.
 */
export const placeRouter = Router();

placeRouter.use(requireAuth);

placeRouter.get(
  '/places',
  validate({ query: SearchPlacesQuerySchema }),
  asyncHandler(placeController.search),
);

/* ── Administration (M6.3) ────────────────────────────────────────────────── */

/**
 * ⚠️ Reading is open to every signed-in role above, including a customer's site
 * supervisor. Writing is not.
 *
 * Looser than zone administration on purpose: adding a suburb is an operational
 * fact that writes no money row, where adding a ZONE writes a rate row on every
 * card for every schedule they have ever had. The service refuses independently
 * — the same double-gate the settings router documents, at its own setting.
 */
const PLACE_ADMIN = requireRole('super-admin', 'operations');

/** The whole table, archived rows included. `GET /places` above is the picker. */
placeRouter.get('/places/all', PLACE_ADMIN, asyncHandler(placeController.list));

placeRouter.post(
  '/places',
  PLACE_ADMIN,
  validate({ body: PlaceWriteSchema }),
  asyncHandler(placeController.create),
);

placeRouter.patch(
  '/places/:id',
  PLACE_ADMIN,
  validate({ params: PlaceIdParamsSchema, body: PlaceWriteSchema }),
  asyncHandler(placeController.update),
);

placeRouter.post(
  '/places/:id/restore',
  PLACE_ADMIN,
  validate({ params: PlaceIdParamsSchema }),
  asyncHandler(placeController.restore),
);

placeRouter.delete(
  '/places/:id',
  PLACE_ADMIN,
  validate({ params: PlaceIdParamsSchema }),
  asyncHandler(placeController.remove),
);
