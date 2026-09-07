import type { Response } from 'express';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { placeService } from './place.service.js';
import type { SearchPlacesQuerySchema } from './place.schemas.js';

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
};
