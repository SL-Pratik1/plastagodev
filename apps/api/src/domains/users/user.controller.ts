import type { UserDraftSchema } from '@plastago/shared';
import type { Response } from 'express';
import { AppError } from '../../lib/app-error.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { userService, type Caller } from './user.service.js';
import type {
  ListUsersQuerySchema,
  SetUserStatusSchema,
  UserIdParamsSchema,
} from './user.schemas.js';

/** Controller layer — HTTP in, HTTP out. No business rules, no Mongoose. */

function callerFrom(req: { auth?: Express.Request['auth'] }): Caller {
  if (!req.auth) throw AppError.unauthenticated('Sign in to continue');

  return {
    userId: req.auth.userId,
    name: req.auth.name,
    roles: req.auth.roles as Caller['roles'],
  };
}

export const userController = {
  list: async (
    req: ValidatedRequest<{ query: typeof ListUsersQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await userService.list(req.validated.query, callerFrom(req)));
  },

  get: async (
    req: ValidatedRequest<{ params: typeof UserIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await userService.get(req.validated.params.id, callerFrom(req)));
  },

  create: async (
    req: ValidatedRequest<{ body: typeof UserDraftSchema }>,
    res: Response,
  ): Promise<void> => {
    res.status(201).json(await userService.create(req.validated.body, callerFrom(req)));
  },

  update: async (
    req: ValidatedRequest<{ params: typeof UserIdParamsSchema; body: typeof UserDraftSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(
      await userService.update(req.validated.params.id, req.validated.body, callerFrom(req)),
    );
  },

  setStatus: async (
    req: ValidatedRequest<{
      params: typeof UserIdParamsSchema;
      body: typeof SetUserStatusSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    res.json(
      await userService.setStatus(
        req.validated.params.id,
        req.validated.body.status,
        callerFrom(req),
      ),
    );
  },

  /**
   * 202, with what actually happened.
   *
   * ⚠️ Still 202 rather than 200: the provider accepting a message is not the
   * recipient receiving it, and this endpoint must not imply delivery. The body
   * says which channel was used and whether the send failed, because the office
   * needs to know now — while they can still ring the person instead.
   */
  resendInvite: async (
    req: ValidatedRequest<{ params: typeof UserIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    const result = await userService.resendInvite(req.validated.params.id, callerFrom(req));
    res.status(202).json(result);
  },
};
