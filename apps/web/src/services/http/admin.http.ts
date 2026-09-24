import type { ApiClient } from '@plastago/api-client';
import {
  AccountListItemSchema,
  AccountSchema,
  AllocationBoardSchema,
  API_PREFIX,
  BookablePurchaseOrderSchema,
  CertificateSchema,
  DriverSchema,
  FinancialReportSchema,
  InvitationResultSchema,
  InvoiceDownloadsSchema,
  InvoiceListItemSchema,
  RaisedInvoiceSchema,
  InvoiceSchema,
  JobCommentSchema,
  JobListItemSchema,
  JobSchema,
  MapPinSchema,
  MonthlyVolumeReportSchema,
  PricePreviewSchema,
  RunSchema,
  RunSheetSchema,
  VehicleListItemSchema,
  VehicleSchema,
  ZoneVolumeReportSchema,
  type AccountDraft,
  type AccountType,
  type CreateRunInput,
  type ExceptionReason,
  type JobCommentDraft,
  type JobDraft,
  type ReportFilters,
  type VehicleDefectState,
  type VehicleDraft,
  type VehicleExpenseDraft,
} from '@plastago/shared';
import * as z from 'zod';
import type { AccountUpdate } from '@plastago/shared';
import type {
  CustomerService,
  DispatchService,
  InvoiceService,
  JobService,
  ListQuery,
  ReportService,
  VehicleService,
} from '../types.js';
import { NoContentSchema, SignedUrlSchema, listParams, pageOf } from './list-params.js';
import { viaService } from './to-service-error.js';

/**
 * The office's working domains: customers, jobs, dispatch, invoices, reports and
 * fleet.
 *
 * Endpoint paths appear here and nowhere else in the app.
 */

/** `{ changed: n }` — how many rows a bulk action actually moved. */
const ChangedSchema = z.object({ changed: z.number().int().nonnegative() });

/* ── M2.8 · accounts ─────────────────────────────────────────────────────── */

export function createHttpCustomerService(api: ApiClient): CustomerService {
  const base = `${API_PREFIX}/accounts`;

  return {
    list: (query: ListQuery) =>
      viaService(() =>
        api.request(base, {
          searchParams: listParams(query),
          schema: pageOf(AccountListItemSchema),
        }),
      ),

    get: (id: string) => viaService(() => api.request(`${base}/${id}`, { schema: AccountSchema })),

    create: (draft: AccountDraft) =>
      viaService(() =>
        api.request(base, {
          method: 'POST',
          body: draft,
          /*
           * Inline rather than a shared schema, matching the lead conversion
           * response below it: the envelope is this endpoint's, and putting it
           * in `@plastago/shared` would make `party.ts` import `users.ts`,
           * which already imports `party.ts`.
           */
          schema: z.object({
            account: AccountListItemSchema,
            welcome: InvitationResultSchema.nullable(),
          }),
        }),
      ),

    /**
     * Correct an account's details.
     *
     * PATCH, and the full `AccountSchema` back. The server trims, lower-cases
     * the certificate email and turns blanks into nulls, so rendering the
     * request body instead of the response would show the office what they
     * typed rather than what was stored.
     */
    update: (accountId: string, input: AccountUpdate) =>
      viaService(() =>
        api.request(`${base}/${accountId}`, {
          method: 'PATCH',
          body: input,
          schema: AccountSchema,
        }),
      ),

    /*
     * ⚠️ Served by the JOBS list filtered to the account, not by a nested
     * `/accounts/:id/jobs`.
     *
     * A nested route would be a second listing of the same rows with its own
     * filters, sorting and scoping to keep in step with the first — and the
     * scoping is the part that must not drift. One list endpoint, one place the
     * rules live.
     */
    jobs: (accountId: string, query: ListQuery) =>
      viaService(() =>
        api.request(`${API_PREFIX}/jobs`, {
          searchParams: { ...listParams(query), account: accountId },
          schema: pageOf(JobListItemSchema),
        }),
      ),

    invoices: (accountId: string, query: ListQuery) =>
      viaService(() =>
        api.request(`${API_PREFIX}/invoices`, {
          searchParams: { ...listParams(query), account: accountId },
          schema: pageOf(InvoiceListItemSchema),
        }),
      ),

    setAccountType: (accountId: string, accountType: AccountType) =>
      viaService(() =>
        api.request(`${base}/${accountId}/type`, {
          method: 'PATCH',
          body: { accountType },
          // The whole account, so the page renders the stored journey. The
          // server can refuse this (409) when supervisors can still sign in,
          // in which case nothing comes back and the caller shows the message.
          schema: AccountSchema,
        }),
      ),

    setInvoiceTemplate: (accountId: string, invoiceTemplateId: string | null) =>
      viaService(() =>
        api.request(`${base}/${accountId}/invoice-template`, {
          method: 'PATCH',
          body: { invoiceTemplateId },
          // The whole account back, so the page renders what was stored rather
          // than what was asked for — the server refuses a template that has
          // since been deleted, and the row must show the refusal's outcome.
          schema: AccountSchema,
        }),
      ),

    setRiskAssessmentRequired: (accountId: string, required: boolean) =>
      viaService(() =>
        api.request(`${base}/${accountId}/risk-assessment`, {
          method: 'PATCH',
          body: { required },
          // Returns the whole account so the screen renders the server's
          // answer: this switch changes what a DRIVER is made to do at a fence,
          // and a UI showing "on" while the record says "off" is a compliance
          // gap wearing a tick.
          schema: AccountSchema,
        }),
      ),
  };
}

/* ── M2 · jobs ───────────────────────────────────────────────────────────── */

export function createHttpJobService(api: ApiClient): JobService {
  const base = `${API_PREFIX}/jobs`;

  return {
    list: (query: ListQuery) =>
      viaService(() =>
        api.request(base, { searchParams: listParams(query), schema: pageOf(JobListItemSchema) }),
      ),

    get: (id: string) => viaService(() => api.request(`${base}/${id}`, { schema: JobSchema })),

    /*
     * A READ served over POST. The draft is an input to a calculation rather
     * than a filter, and it is far too long for a query string. Pricing stays
     * server-resolved (Risk 1) — a second implementation in the browser would
     * be a second thing to keep matching TransVirtual to the cent.
     */
    preview: (draft: JobDraft) =>
      viaService(() =>
        api.request(`${base}/preview`, {
          method: 'POST',
          body: draft,
          schema: PricePreviewSchema,
        }),
      ),

    /**
     * M2.12 — the purchase orders this account can book against.
     *
     * Mounted at `/jobs/purchase-orders` rather than under `/queues`, where the
     * review workflow lives: choosing which order a pickup fulfils is a booking
     * concern, and the office booking a job has no business reaching the review
     * queue's endpoints.
     */
    purchaseOrders: (accountId: string, search?: string) =>
      viaService(() =>
        api.request(`${base}/purchase-orders`, {
          searchParams: { accountId, ...(search ? { q: search } : {}) },
          schema: z.array(BookablePurchaseOrderSchema),
        }),
      ),

    create: (draft: JobDraft) =>
      viaService(() =>
        api.request(base, { method: 'POST', body: draft, schema: JobListItemSchema }),
      ),

    cancel: async (id: string, reason: ExceptionReason, note: string) => {
      await viaService(() =>
        api.request(`${base}/${id}/cancel`, {
          method: 'POST',
          // A structured reason, never free text (M2.4): a reason picked from a
          // list can be counted.
          body: { reason, note },
          schema: NoContentSchema,
        }),
      );
    },

    reschedule: async (id: string, readyDate: string) => {
      await viaService(() =>
        api.request(`${base}/${id}/reschedule`, {
          method: 'POST',
          body: { readyDate },
          schema: NoContentSchema,
        }),
      );
    },

    addComment: (jobId: string, draft: JobCommentDraft) =>
      viaService(() =>
        api.request(`${base}/${jobId}/comments`, {
          method: 'POST',
          body: draft,
          // Returns the created comment because the delivery state is part of
          // the answer, and the thread has to show it.
          schema: JobCommentSchema,
        }),
      ),
  };
}

/* ── M3 · dispatch ───────────────────────────────────────────────────────── */

export function createHttpDispatchService(api: ApiClient): DispatchService {
  const base = `${API_PREFIX}/dispatch`;

  /** Every run mutation answers 204; the board refetches. */
  const command = async (path: string, body?: unknown): Promise<void> => {
    await viaService(() =>
      api.request(path, {
        method: 'POST',
        ...(body === undefined ? {} : { body }),
        schema: NoContentSchema,
      }),
    );
  };

  return {
    board: (date: string) =>
      viaService(() =>
        api.request(`${base}/board`, {
          searchParams: { date },
          schema: AllocationBoardSchema,
        }),
      ),

    createRun: (input: CreateRunInput) =>
      viaService(() =>
        api.request(`${base}/runs`, { method: 'POST', body: input, schema: RunSchema }),
      ),

    renameRun: async (runId: string, name: string) => {
      await viaService(() =>
        api.request(`${base}/runs/${runId}`, {
          method: 'PATCH',
          body: { name },
          schema: NoContentSchema,
        }),
      );
    },

    deleteRun: async (runId: string) => {
      await viaService(() =>
        api.request(`${base}/runs/${runId}`, { method: 'DELETE', schema: NoContentSchema }),
      );
    },

    addJobToRun: (runId: string, jobId: string) => command(`${base}/runs/${runId}/jobs`, { jobId }),

    removeJobFromRun: async (runId: string, jobId: string) => {
      await viaService(() =>
        api.request(`${base}/runs/${runId}/jobs/${jobId}`, {
          method: 'DELETE',
          schema: NoContentSchema,
        }),
      );
    },

    reorderRun: (runId: string, jobIds: readonly string[]) =>
      command(`${base}/runs/${runId}/reorder`, { jobIds }),

    optimiseRun: (runId: string) =>
      viaService(() =>
        api.request(`${base}/runs/${runId}/optimise`, {
          method: 'POST',
          // Returns the reordered run: this overwrites any hand-ordering, so
          // the screen must render what the server decided rather than guess.
          schema: RunSchema,
        }),
      ),

    assignRun: (runId: string, driverId: string) =>
      command(`${base}/runs/${runId}/assign`, { driverId }),

    unassignRun: (runId: string) => command(`${base}/runs/${runId}/unassign`),

    runSheet: (runId: string) =>
      viaService(() => api.request(`${base}/runs/${runId}/sheet`, { schema: RunSheetSchema })),

    mapPins: (date: string) =>
      viaService(() =>
        api.request(`${base}/map`, { searchParams: { date }, schema: z.array(MapPinSchema) }),
      ),

    drivers: () =>
      viaService(() => api.request(`${base}/drivers`, { schema: z.array(DriverSchema) })),
  };
}

/* ── M7 · invoicing ──────────────────────────────────────────────────────── */

export function createHttpInvoiceService(api: ApiClient): InvoiceService {
  const base = `${API_PREFIX}/invoices`;

  return {
    list: (query: ListQuery) =>
      viaService(() =>
        api.request(base, {
          searchParams: listParams(query),
          schema: pageOf(InvoiceListItemSchema),
        }),
      ),

    get: (id: string) => viaService(() => api.request(`${base}/${id}`, { schema: InvoiceSchema })),

    raiseForJob: (jobId: string) =>
      viaService(() =>
        api.request(`${base}/jobs/${jobId}`, {
          method: 'POST',
          // Raised or brought up to date — each one says which.
          schema: z.array(RaisedInvoiceSchema),
        }),
      ),

    send: async (ids: readonly string[]) => {
      // The count is returned rather than thrown on: a grid selection is
      // expected to contain rows somebody else already actioned, and failing
      // the whole batch for one of them would make the button useless.
      const { changed } = await viaService(() =>
        api.request(`${base}/send`, { method: 'POST', body: { ids }, schema: ChangedSchema }),
      );
      return changed;
    },

    approve: async (ids: readonly string[]) => {
      const { changed } = await viaService(() =>
        api.request(`${base}/approve`, { method: 'POST', body: { ids }, schema: ChangedSchema }),
      );
      return changed;
    },

    recordPo: async (id: string, poNumber: string) => {
      await viaService(() =>
        api.request(`${base}/${id}/purchase-order`, {
          method: 'POST',
          body: { poNumber },
          schema: NoContentSchema,
        }),
      );
    },

    requestPdf: (ids: readonly string[]) =>
      viaService(() =>
        api.request(`${base}/pdf`, {
          method: 'POST',
          body: { ids },
          // 200 — the documents exist and their links come back with the answer.
          schema: InvoiceDownloadsSchema,
        }),
      ),

    /*
     * ⚠️ Answers with an OUTCOME, not 204.
     *
     * The push happens while this request is open, so `pushed: false` is a
     * successful HTTP call reporting that Xero said no. Treating it as a bare
     * success — which a 204 forces — is how the page ends up saying "Re-sent
     * to Xero" directly above a badge reading "Xero push failed".
     */
    retryXero: (id: string) =>
      viaService(() =>
        api.request(`${base}/${id}/xero-retry`, {
          method: 'POST',
          schema: XeroRetryResultSchema,
        }),
      ),
  };
}

/* ── M9 · reports ────────────────────────────────────────────────────────── */

const XeroRetryResultSchema = z.object({
  pushed: z.boolean(),
  message: z.string().nullable(),
});

export function createHttpReportService(api: ApiClient): ReportService {
  const base = `${API_PREFIX}/reports`;

  /*
   * `ReportFilters` carries nulls for the facets that are not set, and a null in
   * a query string arrives as the STRING "null" — which fails an ObjectId check
   * on the server. Dropped here instead.
   */
  const filterParams = (filters: ReportFilters): Record<string, string | undefined> => {
    const params: Record<string, string | undefined> = { from: filters.from, to: filters.to };

    if (filters.accountId) params.accountId = filters.accountId;
    if (filters.suburb) params.suburb = filters.suburb;
    if (filters.zoneId) params.zoneId = filters.zoneId;
    if (filters.driverId) params.driverId = filters.driverId;

    return params;
  };

  return {
    // Three NAMED reports and no generic `run(query)`. Risk 5 calls the report
    // builder the biggest scope trap in the project, and a query object is how
    // that starts.
    monthlyVolume: (filters: ReportFilters) =>
      viaService(() =>
        api.request(`${base}/volume`, {
          searchParams: filterParams(filters),
          schema: MonthlyVolumeReportSchema,
        }),
      ),

    zoneVolume: (filters: ReportFilters) =>
      viaService(() =>
        api.request(`${base}/zones`, {
          searchParams: filterParams(filters),
          schema: ZoneVolumeReportSchema,
        }),
      ),

    financial: (filters: ReportFilters) =>
      viaService(() =>
        api.request(`${base}/financial`, {
          searchParams: filterParams(filters),
          schema: FinancialReportSchema,
        }),
      ),

    certificates: (query: ListQuery) =>
      viaService(() =>
        api.request(`${base}/certificates`, {
          searchParams: listParams(query),
          schema: pageOf(CertificateSchema),
        }),
      ),

    issueCertificate: (id: string) =>
      viaService(() =>
        api.request(`${base}/certificates/${id}/issue`, {
          method: 'POST',
          // Returns the issued certificate: once issued it can never change, so
          // the screen must show the version that was actually frozen.
          schema: CertificateSchema,
        }),
      ),

    /** A link to the stored PDF, for the office's own preview. */
    certificatePdf: (id: string) =>
      viaService(() =>
        api.request(`${base}/certificates/${id}/pdf`, {
          method: 'POST',
          schema: SignedUrlSchema,
        }),
      ),

    /** Sends the stored document again, to the account's certificate address. */
    resendCertificate: (id: string) =>
      viaService(() =>
        api.request(`${base}/certificates/${id}/resend`, {
          method: 'POST',
          schema: ResentSchema,
        }),
      ),
  };
}

/** What a resend reports back: the address it actually went to, or null. */
const ResentSchema = z.object({ sentTo: z.string().nullable() });

/* ── M9.7 · F43 · fleet ──────────────────────────────────────────────────── */

export function createHttpVehicleService(api: ApiClient): VehicleService {
  const base = `${API_PREFIX}/vehicles`;

  /*
   * Nearly every mutation returns the WHOLE vehicle, not the field that moved.
   * One expense shifts the odometer, the totals, the cost per kilometre and —
   * when it is a service — the maintenance history with it, so a partial
   * response would leave the screen showing four stale figures beside one fresh
   * one.
   */
  const mutate = (path: string, body?: unknown) =>
    viaService(() =>
      api.request(path, {
        method: 'POST',
        ...(body === undefined ? {} : { body }),
        schema: VehicleSchema,
      }),
    );

  return {
    list: (query: ListQuery) =>
      viaService(() =>
        api.request(base, {
          searchParams: listParams(query),
          schema: pageOf(VehicleListItemSchema),
        }),
      ),

    get: (id: string) => viaService(() => api.request(`${base}/${id}`, { schema: VehicleSchema })),

    create: (draft: VehicleDraft) =>
      viaService(() =>
        api.request(base, { method: 'POST', body: draft, schema: VehicleListItemSchema }),
      ),

    update: (id: string, draft: VehicleDraft) =>
      viaService(() =>
        api.request(`${base}/${id}`, { method: 'PATCH', body: draft, schema: VehicleSchema }),
      ),

    setActive: (id: string, active: boolean) => mutate(`${base}/${id}/active`, { active }),

    assignDriver: (id: string, driverName: string | null) =>
      mutate(`${base}/${id}/driver`, { driverName }),

    addExpense: (id: string, draft: VehicleExpenseDraft) => mutate(`${base}/${id}/expenses`, draft),

    setDefectState: (vehicleId: string, defectId: string, state: VehicleDefectState) =>
      mutate(`${base}/${vehicleId}/defects/${defectId}/state`, { state }),

    setNextService: (id: string, dueOn: string | null) =>
      mutate(`${base}/${id}/next-service`, { dueOn }),

    renewRegistration: (id: string, expense?: VehicleExpenseDraft | null) =>
      // The expense is optional and sent as null when absent: the moment
      // somebody renews is the only moment they have the amount in front of
      // them, but making it mandatory would block the renewal on a missing
      // receipt.
      mutate(`${base}/${id}/registration/renew`, { expense: expense ?? null }),
  };
}
