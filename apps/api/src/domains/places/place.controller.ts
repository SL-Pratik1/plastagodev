import type { Request, Response } from 'express';
import { PlaceWriteSchema } from '@plastago/shared';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { AppError } from '../../lib/app-error.js';
import type { Caller } from './place.service.js';
import { placeService } from './place.service.js';
import type { PlaceIdParamsSchema, SearchPlacesQuerySchema } from './place.schemas.js';

/**
 * Controller layer — HTTP in, HTTP out. No business rules, no Mongoose.
 *
 * Handlers are arrow-function properties, not methods: Express receives them as
 * bare references, so a `this`-bound method would silently lose its receiver.
 */
export const placeController = {
  search: async (
    req: ValidatedRequest<{ query: typeof SearchPlacesQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    const places = await placeService.search(req.validated.query.q);
    res.json(places);
  },

  list: async (req: Request, res: Response): Promise<void> => {
    res.json(await placeService.list(callerOf(req)));
  },

  create: async (
    req: ValidatedRequest<{ body: typeof PlaceWriteSchema }>,
    res: Response,
  ): Promise<void> => {
    const place = await placeService.create(req.validated.body, callerOf(req));
    res.status(201).json(place);
  },

  update: async (
    req: ValidatedRequest<{ params: typeof PlaceIdParamsSchema; body: typeof PlaceWriteSchema }>,
    res: Response,
  ): Promise<void> => {
    const place = await placeService.update(
      req.validated.params.id,
      req.validated.body,
      callerOf(req),
    );
    res.json(place);
  },

  /**
   * ⚠️ 200 with the archived row, or 204 when it was really deleted.
   *
   * Two outcomes behind one verb — see `placeService.remove`. The screen has to
   * be able to tell them apart, because "retired, and here is why" is a
   * different thing to show than "gone".
   */
  remove: async (
    req: ValidatedRequest<{ params: typeof PlaceIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    const place = await placeService.remove(req.validated.params.id, callerOf(req));
    if (place) {
      res.json(place);
      return;
    }
    res.status(204).end();
  },

  restore: async (
    req: ValidatedRequest<{ params: typeof PlaceIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await placeService.restore(req.validated.params.id, callerOf(req)));
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
  return { roles: req.auth.roles as Caller['roles'], accountId: req.auth.accountId };
}
