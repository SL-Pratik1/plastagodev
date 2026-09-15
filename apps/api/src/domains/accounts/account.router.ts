import {
  AccountInvoiceTemplateBodySchema,
  AccountDraftSchema,
  AccountUpdateSchema,
} from '@plastago/shared';
import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { accountController } from './account.controller.js';
import {
  AccountIdParamsSchema,
  AccountTypeBodySchema,
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

/**
 * Who may read an account at all.
 *
 * The office roles see every account; the two customer roles see exactly their
 * own, because the repository narrows by `accountId` (see the note above). Both
 * belong here — the narrowing is what differs, not the right to ask.
 *
 * ⚠️ The DRIVER and the ALLOCATOR are absent, and their absence is the point.
 * Neither is narrowed by the repository, so without this gate both read every
 * customer row — including `rateCardId` and `poPolicy`, which is the commercial
 * tier each builder sits on. The allocator is denied pricing everywhere else in
 * the product on purpose ("allocation is a logistics decision, so the board
 * shows the job and never what it is worth"), and a driver's session lives on a
 * phone that goes to building sites. Neither surface calls this endpoint: the
 * driver app has `/driver/*`, and the pickers use `/lookups/accounts`.
 */
const MAY_READ = requireRole(
  'super-admin',
  'operations',
  'office-staff',
  'customer-administrator',
  'customer-site-supervisor',
);

accountRouter.get(
  '/',
  MAY_READ,
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
  MAY_READ,
  validate({ params: AccountIdParamsSchema }),
  asyncHandler(accountController.get),
);

/**
 * Correct an account's details.
 *
 * ── Why these three roles ─────────────────────────────────────────────────
 * The same three that can already change an account's type and its risk-
 * assessment rule: onboarding a customer and correcting how they were onboarded
 * are the same job, done by the same people, frequently in the same week.
 * Office staff are included deliberately — they are the ones who notice the
 * misspelt company name, because they are the ones raising the invoice it
 * prints on.
 *
 * ⚠️ The two CUSTOMER roles are absent. A customer administrator maintains
 * their own details in the portal, on a form written for them; reaching this
 * one would let them edit an account record the office is responsible for. The
 * service refuses a customer-role caller independently of this gate.
 *
 * PATCH rather than PUT: it changes the details and leaves the commercial terms
 * — rate card, payment terms, PO policy, capture mode — untouched. They are not
 * in the schema at all, so this endpoint cannot re-price anything.
 */
accountRouter.patch(
  '/:id',
  requireRole('super-admin', 'operations', 'office-staff'),
  validate({ params: AccountIdParamsSchema, body: AccountUpdateSchema }),
  asyncHandler(accountController.update),
);

/**
 * M7.5 — which template this account's invoices are drawn with.
 *
 * Its own route rather than a field on the details PATCH above, for the reason
 * that endpoint's own note gives: the details form must not be able to change
 * anything commercial. What an invoice LOOKS like is commercial — it is the
 * document a builder's accounts department receives.
 */
accountRouter.patch(
  '/:id/invoice-template',
  requireRole('super-admin', 'operations', 'office-staff'),
  validate({ params: AccountIdParamsSchema, body: AccountInvoiceTemplateBodySchema }),
  asyncHandler(accountController.setInvoiceTemplate),
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

/**
 * Builder or contractor — the account's journey (Matt, 21:55).
 *
 * Same three roles as the rule above: onboarding a customer and correcting how
 * they were onboarded are the same job. The service refuses a customer-role
 * caller independently, and refuses builder → contractor while supervisors can
 * still sign in.
 */
accountRouter.patch(
  '/:id/type',
  requireRole('super-admin', 'operations', 'office-staff'),
  validate({ params: AccountIdParamsSchema, body: AccountTypeBodySchema }),
  asyncHandler(accountController.setAccountType),
);
