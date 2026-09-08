import type { Response } from 'express';
import { AppError } from '../../lib/app-error.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { rosterService, type Caller } from './roster.service.js';
import type { DriverIdParamsSchema, ListDriversQuerySchema } from './roster.schemas.js';

/** Controller layer — HTTP in, HTTP out. No business rules, no Mongoose. */

function callerFrom(req: { auth?: Express.Request['auth'] }): Caller {
  if (!req.auth) throw AppError.unauthenticated('Sign in to continue');

  return {
    userId: req.auth.userId,
    name: req.auth.name,
    roles: req.auth.roles as Caller['roles'],
  };
}

export const rosterController = {
  list: async (
    req: ValidatedRequest<{ query: typeof ListDriversQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await rosterService.list(req.validated.query, callerFrom(req)));
  },

  get: async (
    req: ValidatedRequest<{ params: typeof DriverIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await rosterService.get(req.validated.params.id, callerFrom(req)));
  },
};
