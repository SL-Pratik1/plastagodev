import {
  AccountOnboardingSchema,
  CallUpRequestSchema,
  PortalAccountUpdateSchema,
  PortalBookingDraftSchema,
  PortalChangeRequestSchema,
  PortalJobEditSchema,
  PortalSupervisorInviteSchema,
  ReadinessCertificationSchema,
} from '@plastago/shared';
import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { ReportFiltersQuerySchema } from '../reports/report.schemas.js';
import {
  portalAccountController,
  portalCertificateController,
} from './portal-account.controller.js';
import { portalController } from './portal.controller.js';
import {
  PortalAwaitingQuerySchema,
  PortalInvoiceIdsSchema,
  PortalCertificateIdParamsSchema,
  PortalInvoicesQuerySchema,
  PortalJobIdParamsSchema,
  PortalJobsQuerySchema,
  PortalPurchaseOrderIdParamsSchema,
  PortalSupervisorIdParamsSchema,
  PortalSupervisorsQuerySchema,
  SetSupervisorStateSchema,
  SetUrgencySchema,
} from './portal.schemas.js';

/**
 * Router layer — paths and middleware only. No logic.
 *
 * ── Why this router is gated to customer roles ONLY ───────────────────────
 * Because every route here answers "what does MY account see", resolved from
 * the session. An office user reaching these would be a caller with no account
 * id, and the honest failure is at the door rather than a confusing empty list
 * three screens in — the office has its own screens for the same data.
 *
 * ⚠️ There is no account id in any path. The scope cannot be widened by editing
 * a URL because there is nothing in the URL to edit.
 */
export const portalRouter = Router();

portalRouter.use(requireAuth);
portalRouter.use(requireRole('customer-administrator', 'customer-site-supervisor'));

/** Resolved on every page load. Cheap, cached hard. */
portalRouter.get('/scope', asyncHandler(portalController.scope));

/* ── M5.7 · the screen that replaces phoning the office ──────────────────── */

portalRouter.get('/dashboard', asyncHandler(portalController.dashboard));

/* ── M2.12b · purchase orders waiting for a date ─────────────────────────── */

/**
 * Matt, 30:40: *"he can log into his portal and that PO that we got will be
 * sitting there on his account and he can go call this up for the 21st."*
 *
 * The fallback for when the builder's own call-up email never arrives — which is
 * often enough that the work would otherwise stall on a phone call.
 */
portalRouter.get(
  '/purchase-orders/awaiting',
  validate({ query: PortalAwaitingQuerySchema }),
  asyncHandler(portalController.awaitingCallUp),
);

portalRouter.post(
  '/purchase-orders/:purchaseOrderId/call-up',
  validate({ params: PortalPurchaseOrderIdParamsSchema, body: CallUpRequestSchema }),
  asyncHandler(portalController.callUp),
);

/* ── M5.7, M5.8, M5.9 · jobs ─────────────────────────────────────────────── */

portalRouter.get(
  '/jobs',
  validate({ query: PortalJobsQuerySchema }),
  asyncHandler(portalController.jobs),
);

portalRouter.get(
  '/jobs/:id',
  validate({ params: PortalJobIdParamsSchema }),
  asyncHandler(portalController.job),
);

/* ── M5.1 · booking ──────────────────────────────────────────────────────── */

portalRouter.post(
  '/jobs',
  validate({ body: PortalBookingDraftSchema }),
  asyncHandler(portalController.book),
);

/**
 * M6.9 — the estimate before booking.
 *
 * A READ served over POST: the draft is an input to a calculation, not a
 * filter, and it is far too long for a query string. Refused for a site
 * supervisor in the service — the figure never leaves the server.
 */
portalRouter.post(
  '/jobs/quote',
  validate({ body: PortalBookingDraftSchema }),
  asyncHandler(portalController.quote),
);

/* ── M5.4 · changing a booking ───────────────────────────────────────────── */

/** A direct edit — allowed only while the job has not reached a run sheet. */
portalRouter.patch(
  '/jobs/:id',
  validate({ params: PortalJobIdParamsSchema, body: PortalJobEditSchema }),
  asyncHandler(portalController.editJob),
);

/** Once it is allocated, the change routes to the office instead. */
portalRouter.post(
  '/jobs/:id/change-request',
  validate({ params: PortalJobIdParamsSchema, body: PortalChangeRequestSchema }),
  asyncHandler(portalController.requestChange),
);

/* ── M5.5 · urgency ──────────────────────────────────────────────────────── */

portalRouter.post(
  '/jobs/:id/urgency',
  validate({ params: PortalJobIdParamsSchema, body: SetUrgencySchema }),
  asyncHandler(portalController.setUrgency),
);

/* ── M5.2 · readiness ────────────────────────────────────────────────────── */

/**
 * Certify a job ready, or re-confirm closer to the day.
 *
 * Append-only: a re-confirmation is a new, stronger fact, not an edit to the
 * old one. See the model.
 */
portalRouter.post(
  '/jobs/:id/readiness',
  validate({ params: PortalJobIdParamsSchema, body: ReadinessCertificationSchema }),
  asyncHandler(portalController.certifyReadiness),
);

/* ── M5.10 · invoices ────────────────────────────────────────────────────── */

/**
 * ⚠️ Administrator only, enforced in the service.
 *
 * A site supervisor books pickups; what the business is billed is not theirs to
 * see. Gated in the service rather than here so the same rule holds however the
 * method is reached.
 */
portalRouter.get(
  '/invoices',
  validate({ query: PortalInvoicesQuerySchema }),
  asyncHandler(portalAccountController.invoices),
);

portalRouter.post(
  '/invoices/pdf',
  validate({ body: PortalInvoiceIdsSchema }),
  asyncHandler(portalAccountController.requestInvoicePdf),
);

/* ── M5.14 · the customer manages their own supervisors ──────────────────── */

portalRouter.get(
  '/supervisors',
  validate({ query: PortalSupervisorsQuerySchema }),
  asyncHandler(portalAccountController.supervisors),
);

portalRouter.post(
  '/supervisors',
  validate({ body: PortalSupervisorInviteSchema }),
  asyncHandler(portalAccountController.inviteSupervisor),
);

/** Suspend or reactivate. Never a hard delete — their bookings stand. */
portalRouter.patch(
  '/supervisors/:id',
  validate({ params: PortalSupervisorIdParamsSchema, body: SetSupervisorStateSchema }),
  asyncHandler(portalAccountController.setSupervisorState),
);

/** B.2 — approve somebody who joined using the customer code. */
portalRouter.post(
  '/supervisors/:id/approve',
  validate({ params: PortalSupervisorIdParamsSchema }),
  asyncHandler(portalAccountController.approveSupervisor),
);

/* ── M5.15 · the account ─────────────────────────────────────────────────── */

portalRouter.get('/account', asyncHandler(portalAccountController.account));

/**
 * The preferences a customer may change about themselves.
 *
 * Nothing reachable here can alter what a job costs — the rate card, the terms
 * and the PO policy are absent from the schema entirely.
 */
portalRouter.patch(
  '/account',
  validate({ body: PortalAccountUpdateSchema }),
  asyncHandler(portalAccountController.updateAccount),
);

/* ── Journey A.4 · the customer completes their own account ──────────────── */

portalRouter.get('/onboarding', asyncHandler(portalAccountController.onboardingInvite));

/**
 * The terms tick — the record Matt currently chases as a signed PDF (7:49).
 *
 * Accepted once, by a NAMED person who types their own name. See the service.
 */
portalRouter.post(
  '/onboarding',
  validate({ body: AccountOnboardingSchema }),
  asyncHandler(portalAccountController.completeOnboarding),
);

/* ── M5.11 · F1 · the monthly report ─────────────────────────────────────── */

/**
 * The report PlastaGo currently produces and emails by hand.
 *
 * ⚠️ Delegates straight to `reportService.monthlyVolume`, which already forces
 * `accountId` to the caller's own account for a customer role (`scopeFilters`).
 * That is why there is no portal-specific report service: a second
 * implementation would be a second place for the scoping rule to be got wrong,
 * and this is the surface where getting it wrong shows one builder another
 * builder's tonnages.
 *
 * An `accountId` in the query string is accepted and then OVERWRITTEN, so
 * editing the URL changes nothing.
 */
portalRouter.get(
  '/report/monthly',
  validate({ query: ReportFiltersQuerySchema }),
  asyncHandler(portalCertificateController.monthlyReport),
);

/* ── M5.12 · F52 · diversion certificates ────────────────────────────────── */

/**
 * Only ISSUED certificates reach a customer.
 *
 * A draft is a figure the office has not stood behind yet, and downloading one
 * would put an unconfirmed tonnage into a Green Star submission.
 */
portalRouter.get(
  '/certificates',
  validate({ query: PortalInvoicesQuerySchema }),
  asyncHandler(portalCertificateController.certificates),
);

portalRouter.post(
  '/certificates/:id/pdf',
  validate({ params: PortalCertificateIdParamsSchema }),
  asyncHandler(portalCertificateController.requestCertificatePdf),
);
