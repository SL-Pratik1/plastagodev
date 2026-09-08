import type {
  AccountOnboardingSchema,
  PortalAccountUpdateSchema,
  PortalSupervisorInviteSchema,
} from '@plastago/shared';
import type { Response } from 'express';
import { AppError } from '../../lib/app-error.js';
import { reportService } from '../reports/report.service.js';
import type { ReportFiltersQuerySchema } from '../reports/report.schemas.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import {
  portalAccountService,
  portalCertificateService,
  type Caller,
} from './portal-account.service.js';
import type {
  PortalInvoiceIdsSchema,
  PortalInvoicesQuerySchema,
  PortalCertificateIdParamsSchema,
  PortalSupervisorIdParamsSchema,
  PortalSupervisorsQuerySchema,
  SetSupervisorStateSchema,
} from './portal.schemas.js';

/** Controller layer — HTTP in, HTTP out. No business rules, no Mongoose. */

function callerFrom(req: { auth?: Express.Request['auth'] }): Caller {
  if (!req.auth) throw AppError.unauthenticated('Sign in to continue');

  return {
    userId: req.auth.userId,
    name: req.auth.name,
    roles: req.auth.roles as Caller['roles'],
    accountId: req.auth.accountId,
  };
}

export const portalAccountController = {
  /* ── M5.10 · invoices ──────────────────────────────────────────────────── */

  invoices: async (
    req: ValidatedRequest<{ query: typeof PortalInvoicesQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await portalAccountService.invoices(req.validated.query, callerFrom(req)));
  },

  /** 202: the render is queued, not done. */
  requestInvoicePdf: async (
    req: ValidatedRequest<{ body: typeof PortalInvoiceIdsSchema }>,
    res: Response,
  ): Promise<void> => {
    res
      .status(202)
      .json(await portalAccountService.requestInvoicePdf(req.validated.body.ids, callerFrom(req)));
  },

  /* ── M5.14 · supervisors ───────────────────────────────────────────────── */

  supervisors: async (
    req: ValidatedRequest<{ query: typeof PortalSupervisorsQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await portalAccountService.supervisors(req.validated.query, callerFrom(req)));
  },

  inviteSupervisor: async (
    req: ValidatedRequest<{ body: typeof PortalSupervisorInviteSchema }>,
    res: Response,
  ): Promise<void> => {
    res
      .status(201)
      .json(await portalAccountService.inviteSupervisor(req.validated.body, callerFrom(req)));
  },

  setSupervisorState: async (
    req: ValidatedRequest<{
      params: typeof PortalSupervisorIdParamsSchema;
      body: typeof SetSupervisorStateSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    res.json(
      await portalAccountService.setSupervisorState(
        req.validated.params.id,
        req.validated.body.state,
        callerFrom(req),
      ),
    );
  },

  approveSupervisor: async (
    req: ValidatedRequest<{ params: typeof PortalSupervisorIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(
      await portalAccountService.approveSupervisor(req.validated.params.id, callerFrom(req)),
    );
  },

  /* ── M5.15 · the account ───────────────────────────────────────────────── */

  account: async (req: ValidatedRequest<object>, res: Response): Promise<void> => {
    res.json(await portalAccountService.account(callerFrom(req)));
  },

  updateAccount: async (
    req: ValidatedRequest<{ body: typeof PortalAccountUpdateSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await portalAccountService.updateAccount(req.validated.body, callerFrom(req)));
  },

  /* ── Journey A.4 · onboarding ──────────────────────────────────────────── */

  onboardingInvite: async (req: ValidatedRequest<object>, res: Response): Promise<void> => {
    res.json(await portalAccountService.onboardingInvite(callerFrom(req)));
  },

  completeOnboarding: async (
    req: ValidatedRequest<{ body: typeof AccountOnboardingSchema }>,
    res: Response,
  ): Promise<void> => {
    await portalAccountService.completeOnboarding(req.validated.body, callerFrom(req));
    res.status(204).send();
  },
};

/* ── M5.12 · certificates ────────────────────────────────────────────────── */

export const portalCertificateController = {
  certificates: async (
    req: ValidatedRequest<{ query: typeof PortalInvoicesQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(
      await portalCertificateService.certificates(
        { page: req.validated.query.page, pageSize: req.validated.query.pageSize },
        callerFrom(req),
      ),
    );
  },

  /** 202: the render is queued, not done. */
  requestCertificatePdf: async (
    req: ValidatedRequest<{ params: typeof PortalCertificateIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res
      .status(202)
      .json(
        await portalCertificateService.requestCertificatePdf(
          req.validated.params.id,
          callerFrom(req),
        ),
      );
  },

  /**
   * M5.11 · F1 — the customer's own monthly volume report.
   *
   * The office's report service does the work. `scopeFilters` there pins
   * `accountId` to the caller's account for every customer role, so the filters
   * arriving from the browser cannot widen it — see the note on the route.
   */
  monthlyReport: async (
    req: ValidatedRequest<{ query: typeof ReportFiltersQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await reportService.monthlyVolume(req.validated.query, callerFrom(req)));
  },
};
