import type { ApiClient } from '@plastago/api-client';
import {
  API_PREFIX,
  AwaitingCallUpSchema,
  CallUpOutcomeSchema,
  CertificateSchema,
  InvoiceDownloadsSchema,
  type CallUpRequest,
  MonthlyVolumeReportSchema,
  OnboardingInviteSchema,
  PortalAccountSchema,
  PortalDashboardSchema,
  PortalInvoiceSchema,
  PortalJobListItemSchema,
  PortalJobSchema,
  PortalScopeSchema,
  PortalSupervisorSchema,
  PricePreviewSchema,
  type AccountOnboarding,
  type PortalAccountUpdate,
  type PortalBookingDraft,
  type PortalChangeRequest,
  type PortalJobEdit,
  type PortalSupervisor,
  type PortalSupervisorInvite,
  type ReadinessCertification,
  type ReportFilters,
} from '@plastago/shared';
import type { CustomerPortalService, ListQuery } from '../types.js';
import { NoContentSchema, SignedUrlSchema, listParams, pageOf } from './list-params.js';
import { viaService } from './to-service-error.js';

/**
 * The customer portal (M5).
 *
 * ── ⚠️ Not one path here carries an account id ────────────────────────────
 * Every call is scoped from the SESSION, server-side. Putting the account in the
 * URL would put the authorisation decision where a user can edit it, and this is
 * the surface where that matters most: M1.5's rule is that a site supervisor
 * sees neither other sites nor any other builder's work.
 *
 * `scope()` tells the UI what to RENDER. It does not tell it what to allow — the
 * server does that, again, on every call.
 */
export function createHttpPortalService(api: ApiClient): CustomerPortalService {
  const base = `${API_PREFIX}/portal`;

  return {
    scope: () => viaService(() => api.request(`${base}/scope`, { schema: PortalScopeSchema })),

    dashboard: () =>
      viaService(() => api.request(`${base}/dashboard`, { schema: PortalDashboardSchema })),

    /* ── M5.7–M5.9 · jobs ─────────────────────────────────────────────────── */

    jobs: (query: ListQuery) =>
      viaService(() =>
        api.request(`${base}/jobs`, {
          searchParams: listParams(query),
          schema: pageOf(PortalJobListItemSchema),
        }),
      ),

    job: (id: string) =>
      viaService(() => api.request(`${base}/jobs/${id}`, { schema: PortalJobSchema })),

    /* ── M5.1 · booking ───────────────────────────────────────────────────── */

    book: (draft: PortalBookingDraft) =>
      viaService(() =>
        api.request(`${base}/jobs`, {
          method: 'POST',
          body: draft,
          // Returns the created job so the confirmation can name its number.
          schema: PortalJobListItemSchema,
        }),
      ),

    /*
     * A READ served over POST: the draft is an input to a calculation, not a
     * filter. Refused server-side for a site supervisor — the figure never
     * leaves the server rather than being hidden by the UI.
     */
    quote: (draft: PortalBookingDraft) =>
      viaService(() =>
        api.request(`${base}/jobs/quote`, {
          method: 'POST',
          body: draft,
          schema: PricePreviewSchema,
        }),
      ),

    /* ── M2.12b · orders waiting for a date ───────────────────────────────── */

    awaitingCallUp: (query: ListQuery) =>
      viaService(() =>
        api.request(`${base}/purchase-orders/awaiting`, {
          searchParams: listParams(query),
          schema: pageOf(AwaitingCallUpSchema),
        }),
      ),

    callUp: (purchaseOrderId: string, request: CallUpRequest) =>
      viaService(() =>
        api.request(`${base}/purchase-orders/${purchaseOrderId}/call-up`, {
          method: 'POST',
          body: request,
          // Says what it DID — booked, or queued for the office. See the schema.
          schema: CallUpOutcomeSchema,
        }),
      ),

    /* ── M5.4 · changing a booking ────────────────────────────────────────── */

    editJob: (id: string, input: PortalJobEdit) =>
      viaService(() =>
        api.request(`${base}/jobs/${id}`, {
          method: 'PATCH',
          body: input,
          schema: PortalJobListItemSchema,
        }),
      ),

    requestChange: async (id: string, input: PortalChangeRequest) => {
      await viaService(() =>
        api.request(`${base}/jobs/${id}/change-request`, {
          method: 'POST',
          // Once the job is on a run sheet the edit above is refused and this
          // is the route instead — the change goes to the office, not the job.
          body: input,
          schema: NoContentSchema,
        }),
      );
    },

    setUrgency: (id: string, urgent: boolean) =>
      viaService(() =>
        api.request(`${base}/jobs/${id}/urgency`, {
          method: 'POST',
          body: { urgent },
          schema: PortalJobListItemSchema,
        }),
      ),

    certifyReadiness: (id: string, input: ReadinessCertification) =>
      viaService(() =>
        api.request(`${base}/jobs/${id}/readiness`, {
          method: 'POST',
          body: input,
          schema: PortalJobListItemSchema,
        }),
      ),

    /* ── M5.10 · invoices — administrator only, enforced server-side ──────── */

    invoices: (query: ListQuery) =>
      viaService(() =>
        api.request(`${base}/invoices`, {
          searchParams: listParams(query),
          schema: pageOf(PortalInvoiceSchema),
        }),
      ),

    requestInvoicePdf: (ids: readonly string[]) =>
      viaService(() =>
        api.request(`${base}/invoices/pdf`, {
          method: 'POST',
          body: { ids },
          // 200 — rendered, with links to the files.
          schema: InvoiceDownloadsSchema,
        }),
      ),

    /* ── M5.11 · F1 · the monthly report ──────────────────────────────────── */

    /*
     * The filters go up, but `accountId` is OVERWRITTEN server-side with the
     * caller's own account. Sending it changes nothing; it is dropped here
     * anyway so a null cannot arrive as the string "null".
     */
    monthlyReport: (filters: ReportFilters) =>
      viaService(() =>
        api.request(`${base}/report/monthly`, {
          searchParams: {
            from: filters.from,
            to: filters.to,
            ...(filters.suburb ? { suburb: filters.suburb } : {}),
            ...(filters.zoneId ? { zoneId: filters.zoneId } : {}),
          },
          schema: MonthlyVolumeReportSchema,
        }),
      ),

    /* ── M5.12 · F52 · diversion certificates ─────────────────────────────── */

    certificates: (query: ListQuery) =>
      viaService(() =>
        api.request(`${base}/certificates`, {
          searchParams: listParams(query),
          // Only ISSUED certificates reach a customer — a draft is a tonnage
          // the office has not stood behind yet. Filtered server-side.
          schema: pageOf(CertificateSchema),
        }),
      ),

    /**
     * A link to the stored PDF.
     *
     * POST although it reads: it mints a signed URL, and a GET would leave
     * that credential in browser history and in any proxy log on the way.
     */
    requestCertificatePdf: (id: string) =>
      viaService(() =>
        api.request(`${base}/certificates/${id}/pdf`, {
          method: 'POST',
          schema: SignedUrlSchema,
        }),
      ),

    /* ── M5.14 · the customer manages their own supervisors ───────────────── */

    supervisors: (query: ListQuery) =>
      viaService(() =>
        api.request(`${base}/supervisors`, {
          searchParams: listParams(query),
          schema: pageOf(PortalSupervisorSchema),
        }),
      ),

    inviteSupervisor: (input: PortalSupervisorInvite) =>
      viaService(() =>
        api.request(`${base}/supervisors`, {
          method: 'POST',
          body: input,
          schema: PortalSupervisorSchema,
        }),
      ),

    setSupervisorState: (id: string, state: PortalSupervisor['state']) =>
      viaService(() =>
        api.request(`${base}/supervisors/${id}`, {
          method: 'PATCH',
          // Suspend or reactivate. Never a delete — the bookings they made stand.
          body: { state },
          schema: PortalSupervisorSchema,
        }),
      ),

    approveSupervisor: (id: string) =>
      viaService(() =>
        api.request(`${base}/supervisors/${id}/approve`, {
          method: 'POST',
          schema: PortalSupervisorSchema,
        }),
      ),

    /* ── M5.15 · the account ──────────────────────────────────────────────── */

    account: () => viaService(() => api.request(`${base}/account`, { schema: PortalAccountSchema })),

    updateAccount: (input: PortalAccountUpdate) =>
      viaService(() =>
        api.request(`${base}/account`, {
          method: 'PATCH',
          // Nothing reachable here can change what a job costs: the rate card,
          // the terms and the PO policy are absent from the schema entirely.
          body: input,
          schema: PortalAccountSchema,
        }),
      ),

    /* ── Journey A.4 · the customer completes their own account ───────────── */

    onboardingInvite: () =>
      viaService(() => api.request(`${base}/onboarding`, { schema: OnboardingInviteSchema })),

    completeOnboarding: async (input: AccountOnboarding) => {
      await viaService(() =>
        api.request(`${base}/onboarding`, {
          method: 'POST',
          // The terms tick — the record Matt currently chases as a signed PDF.
          body: input,
          schema: NoContentSchema,
        }),
      );
    },
  };
}

