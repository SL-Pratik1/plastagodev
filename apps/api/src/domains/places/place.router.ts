import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { placeController } from './place.controller.js';
import { SearchPlacesQuerySchema } from './place.schemas.js';

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
