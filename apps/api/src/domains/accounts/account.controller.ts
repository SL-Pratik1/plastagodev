import type { AccountDraftSchema } from '@plastago/shared';
import type { Request, Response } from 'express';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { AppError } from '../../lib/app-error.js';
import { accountService, type Caller } from './account.service.js';
import type {
  AccountIdParamsSchema,
  AccountTypeBodySchema,
  ListAccountsQuerySchema,
  RiskAssessmentBodySchema,
} from './account.schemas.js';

/**
 * Controller layer — HTTP in, HTTP out. No business rules, no Mongoose.
 *
 * Handlers are arrow-function properties, not methods: Express receives them as
 * bare references, so a `this`-bound method would silently lose its receiver.
 */
export const accountController = {
  list: async (
    req: ValidatedRequest<{ query: typeof ListAccountsQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    const result = await accountService.list(req.validated.query, callerOf(req));
    res.json(result);
  },

  get: async (
    req: ValidatedRequest<{ params: typeof AccountIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    const account = await accountService.get(req.validated.params.id, callerOf(req));
    res.json(account);
  },

  create: async (
    req: ValidatedRequest<{ body: typeof AccountDraftSchema }>,
    res: Response,
  ): Promise<void> => {
    const account = await accountService.create(req.validated.body);
    // 201 with the created row: the grid and the redirect both need its id.
    res.status(201).json(account);
  },

  setRiskAssessmentRequired: async (
    req: ValidatedRequest<{
      params: typeof AccountIdParamsSchema;
      body: typeof RiskAssessmentBodySchema;
    }>,
    res: Response,
  ): Promise<void> => {
    const account = await accountService.setRiskAssessmentRequired(
      req.validated.params.id,
      req.validated.body.required,
      callerOf(req),
    );
    res.json(account);
  },

  setAccountType: async (
    req: ValidatedRequest<{
      params: typeof AccountIdParamsSchema;
      body: typeof AccountTypeBodySchema;
    }>,
    res: Response,
  ): Promise<void> => {
    const account = await accountService.setAccountType(
      req.validated.params.id,
      req.validated.body.accountType,
      callerOf(req),
    );
    res.json(account);
  },

  getTerms: async (
    req: ValidatedRequest<{ params: typeof AccountIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    const terms = await accountService.getTermsAcceptance(req.validated.params.id, callerOf(req));
    // 200 with `null` rather than 404: "not signed yet" is a normal state the
    // screen renders, not a missing resource.
    res.json(terms);
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
