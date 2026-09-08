import type { Response } from 'express';
import { AppError } from '../../lib/app-error.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { auditService, type Caller } from './audit.service.js';
import type { AuditIdParamsSchema, ListAuditQuerySchema } from './audit.schemas.js';

/** Controller layer — HTTP in, HTTP out. No business rules, no Mongoose. */

function callerFrom(req: { auth?: Express.Request['auth'] }): Caller {
  if (!req.auth) throw AppError.unauthenticated('Sign in to continue');

  return {
    userId: req.auth.userId,
    name: req.auth.name,
    roles: req.auth.roles as Caller['roles'],
  };
}

export const auditController = {
  list: async (
    req: ValidatedRequest<{ query: typeof ListAuditQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await auditService.list(req.validated.query, callerFrom(req)));
  },

  get: async (
    req: ValidatedRequest<{ params: typeof AuditIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await auditService.get(req.validated.params.id, callerFrom(req)));
  },

  /**
   * §6A.8 — how much of the log is attributed to a known actor.
   *
   * Exposed because a backstop nobody reads is a backstop nobody trusts: if
   * `attributedPercent` starts falling, a service has stopped recording and the
   * log is quietly becoming less useful than it looks.
   */
  coverage: async (
    req: ValidatedRequest<object>,
    res: Response,
  ): Promise<void> => {
    res.json(await auditService.coverage(callerFrom(req)));
  },
};
