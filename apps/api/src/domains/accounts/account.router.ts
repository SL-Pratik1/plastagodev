import { AccountDraftSchema } from '@plastago/shared';
import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { accountController } from './account.controller.js';
import {
  AccountIdParamsSchema,
  ListAccountsQuerySchema,
  RiskAssessmentBodySchema,
} from './account.schemas.js';

/**
 * Router layer — paths and middleware only. No logic.
 *
 * ── Two layers of access control, doing different jobs ────────────────────
 * `requireRole` below answers "may this KIND of user reach this endpoint at
 * all" — a coarse gate a browser cannot be trusted to apply. It does NOT decide
 * which rows come back: a customer administrator legitimately reaches `GET /`
 * and must see exactly one account. That narrowing happens in the repository
 * (§6A.3 #5), because a filter applied here is one somebody can forget.
 */
export const accountRouter = Router();

// Every route below is authenticated. Mounted once rather than per-route so a
// new endpoint cannot be added unprotected by omission.
accountRouter.use(requireAuth);

accountRouter.get(
  '/',
  validate({ query: ListAccountsQuerySchema }),
  asyncHandler(accountController.list),
);

/**
 * Creating an account is an office act.
 *
 * Matt, 6:10 — the office opens accounts for the large builders directly. A
 * customer administrator manages their own account but cannot mint another one.
 */
accountRouter.post(
  '/',
  requireRole('super-admin', 'operations'),
  validate({ body: AccountDraftSchema }),
  asyncHandler(accountController.create),
);

accountRouter.get(
  '/:id',
  validate({ params: AccountIdParamsSchema }),
  asyncHandler(accountController.get),
);

accountRouter.get(
  '/:id/terms',
  validate({ params: AccountIdParamsSchema }),
  asyncHandler(accountController.getTerms),
);

/**
 * PATCH, not PUT — this changes one field and leaves the rest alone.
 *
 * The service refuses a customer-role caller independently of the role gate
 * here, because only the service's refusal is a boundary.
 */
accountRouter.patch(
  '/:id/risk-assessment',
  requireRole('super-admin', 'operations', 'office-staff'),
  validate({ params: AccountIdParamsSchema, body: RiskAssessmentBodySchema }),
  asyncHandler(accountController.setRiskAssessmentRequired),
);
