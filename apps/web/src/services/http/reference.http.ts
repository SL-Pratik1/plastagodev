import type { ApiClient } from '@plastago/api-client';
import {
  API_PREFIX,
  DashboardSummarySchema,
  DriverListItemSchema,
  DriverProfileSchema,
  InvitationResultSchema,
  InvitedUserSchema,
  NotificationSchema,
  NotificationSummarySchema,
  PlaceSchema,
  type PlaceWrite,
  SettingsSchema,
  PresignedUploadSchema,
  type InvoicingSettings,
  TemplatePreviewSchema,
  UserListItemSchema,
  UserSchema,
  type AdditionalServiceCreate,
  type AdditionalServiceUpdate,
  type InvoiceTemplateWrite,
  type RateCardCreate,
  type RateCardUpdate,
  type RateScheduleCreate,
  type UserDraft,
  type UserStatus,
  type ZoneCreate,
  ZoneSummarySchema,
  type ZoneUpdate,
} from '@plastago/shared';
import * as z from 'zod';
import type {
  DashboardService,
  DriverService,
  ListQuery,
  LookupOption,
  LookupService,
  NotificationService,
  SettingsService,
  SuburbService,
  UserService,
} from '../types.js';
import { NoContentSchema, listParams, pageOf } from './list-params.js';
import { viaService } from './to-service-error.js';

/**
 * The small, mostly-read domains: lookups, users, dashboard,
 * notifications, settings and the driver roster.
 *
 * Grouped into one file because each is three or four passthrough methods and a
 * file apiece would be seven files of imports. The larger domains — jobs,
 * dispatch, invoices, queues, portal — get their own.
 *
 * Endpoint paths appear here and nowhere else in the app; that is the whole
 * point of the seam described in `services/README.md`.
 */

const LookupOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  group: z.string().optional(),
});

/** A zone carries one thing a lookup option does not: whether it is retired. */
const ZoneOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  archived: z.boolean(),
});

/* ── Reference lists ─────────────────────────────────────────────────────── */

export function createHttpLookupService(api: ApiClient): LookupService {
  const base = `${API_PREFIX}/lookups`;

  const list = (path: string): Promise<LookupOption[]> =>
    viaService(() => api.request(`${base}/${path}`, { schema: z.array(LookupOptionSchema) }));

  return {
    accounts: () => list('accounts'),
    builders: () => list('builders'),
    drivers: () => list('drivers'),
    rateCards: () => list('rate-cards'),

    zones: () =>
      viaService(() =>
        api.request(`${base}/zones`, { schema: z.array(ZoneOptionSchema) }),
      ),

    places: (query: string) =>
      viaService(() =>
        api.request(`${base}/places`, {
          // The control opens before anything is typed, so an empty term is a
          // valid request for "show me the list", not a skipped call.
          searchParams: { q: query },
          schema: z.array(PlaceSchema),
        }),
      ),
  };
}

/* ── M6.3 · suburbs ──────────────────────────────────────────────────────── */

export function createHttpSuburbService(api: ApiClient): SuburbService {
  const base = `${API_PREFIX}/lookups/places`;

  return {
    list: () => viaService(() => api.request(`${base}/all`, { schema: z.array(PlaceSchema) })),

    create: (draft: PlaceWrite) =>
      viaService(() => api.request(base, { method: 'POST', body: draft, schema: PlaceSchema })),

    update: (id: string, draft: PlaceWrite) =>
      viaService(() =>
        api.request(`${base}/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: draft,
          schema: PlaceSchema,
        }),
      ),

    /*
     * ⚠️ 200 with the archived row, or 204 when it was really deleted — the
     * screen has to tell them apart, because "retired, and here is why" is a
     * different thing to show than "gone".
     */
    remove: (id: string) =>
      viaService(() =>
        api.request(`${base}/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          schema: PlaceSchema.nullable(),
        }),
      ),

    restore: (id: string) =>
      viaService(() =>
        api.request(`${base}/${encodeURIComponent(id)}/restore`, {
          method: 'POST',
          schema: PlaceSchema,
        }),
      ),
  };
}

/* ── M1.5 · users ────────────────────────────────────────────────────────── */

export function createHttpUserService(api: ApiClient): UserService {
  const base = `${API_PREFIX}/users`;

  return {
    list: (query: ListQuery) =>
      viaService(() =>
        api.request(base, { searchParams: listParams(query), schema: pageOf(UserListItemSchema) }),
      ),

    get: (id: string) => viaService(() => api.request(`${base}/${id}`, { schema: UserSchema })),

    create: (draft: UserDraft) =>
      viaService(() =>
        api.request(base, { method: 'POST', body: draft, schema: InvitedUserSchema }),
      ),

    update: (id: string, draft: UserDraft) =>
      viaService(() =>
        api.request(`${base}/${id}`, {
          method: 'PATCH',
          body: draft,
          schema: UserListItemSchema,
        }),
      ),

    setStatus: (id: string, status: UserStatus) =>
      viaService(() =>
        api.request(`${base}/${id}/status`, {
          method: 'POST',
          // Its own endpoint, not a field on the edit form: changing somebody's
          // access is a different decision from correcting their job title.
          body: { status },
          schema: UserListItemSchema,
        }),
      ),

    /**
     * 202 with the outcome.
     *
     * It used to be an empty body, when nothing was actually sent. Now that a
     * message really goes out, the screen has to be able to say WHICH channel
     * carried it — and, more importantly, when it failed, so the office rings
     * them instead of assuming.
     */
    resendInvite: (id: string) =>
      viaService(() =>
        api.request(`${base}/${id}/resend-invite`, {
          method: 'POST',
          schema: InvitationResultSchema,
        }),
      ),
  };
}

/* ── M9.8 · F53 / M9.9 · F22 — the driver roster ─────────────────────────── */

export function createHttpDriverService(api: ApiClient): DriverService {
  // `/drivers` is the OFFICE's view of the roster. The driver's own app is
  // `/driver` (singular) and lives in `driver-run.http.ts`.
  const base = `${API_PREFIX}/drivers`;

  return {
    list: (query: ListQuery) =>
      viaService(() =>
        api.request(base, {
          searchParams: listParams(query),
          schema: pageOf(DriverListItemSchema),
        }),
      ),

    get: (id: string) =>
      viaService(() => api.request(`${base}/${id}`, { schema: DriverProfileSchema })),
  };
}

/* ── M9.4 · F15 — the dashboard ──────────────────────────────────────────── */

export function createHttpDashboardService(api: ApiClient): DashboardService {
  return {
    // One call for the whole screen — eleven round trips would be eleven
    // chances to render half a dashboard.
    summary: () =>
      viaService(() =>
        api.request(`${API_PREFIX}/dashboard`, { schema: DashboardSummarySchema }),
      ),
  };
}

/* ── M8.7 — the notification centre ──────────────────────────────────────── */

export function createHttpNotificationService(api: ApiClient): NotificationService {
  const base = `${API_PREFIX}/notifications`;

  return {
    list: (query: ListQuery) =>
      viaService(() =>
        api.request(base, { searchParams: listParams(query), schema: pageOf(NotificationSchema) }),
      ),

    summary: () =>
      viaService(() => api.request(`${base}/summary`, { schema: NotificationSummarySchema })),

    markRead: async (ids: readonly string[]) => {
      await viaService(() =>
        api.request(`${base}/read`, {
          method: 'POST',
          body: { ids },
          // The server reports how many moved; the UI refetches rather than
          // reconciling a count, so the number is parsed and dropped.
          schema: z.object({ changed: z.number() }),
        }),
      );
    },

    markAllRead: async () => {
      await viaService(() =>
        api.request(`${base}/read-all`, {
          method: 'POST',
          schema: z.object({ changed: z.number() }),
        }),
      );
    },
  };
}

/* ── W3 · settings ───────────────────────────────────────────────────────── */

export function createHttpSettingsService(api: ApiClient): SettingsService {
  const base = `${API_PREFIX}/settings`;

  /*
   * ⚠️ The generic `section` helper that used to sit here is gone.
   *
   * It typed a save as `(input: Settings[K]) => Promise<Settings[K]>` — the
   * same shape in and out — which stopped being true once the read and the
   * write diverged: invoicing now reads back a derived `logoUrl` that must
   * never be sent. Invoicing was also its only caller, so the abstraction was
   * one implementation behind a type that had become a lie.
   */

  /*
   * A rate-card write returns the card AS STORED, not the input echoed back.
   * The response carries the derived id, the account count, the closed window
   * on the schedule this one superseded, and whether the card is still
   * deletable — none of which the caller could compute.
   */
  const cardSchema = SettingsSchema.shape.pricing.shape.rateCards.element;
  const serviceSchema = SettingsSchema.shape.pricing.shape.additionalServices.element;

  return {
    get: () => viaService(() => api.request(base, { schema: SettingsSchema })),

    /*
     * ⚠️ Sends the WRITE shape and parses the READ shape.
     *
     * They differ by one field: `logoUrl` is derived from the stored key and
     * comes back on every read, but must never be sent — a client echoing back
     * a URL that expired ten minutes ago would be asking the server to store a
     * dead link as the logo. The server strips it; this keeps the types honest
     * about why.
     */
    saveInvoicing: (input: InvoicingSettings) =>
      viaService(() =>
        api.request(`${base}/invoicing`, {
          method: 'PUT',
          body: input,
          schema: SettingsSchema.shape.invoicing,
        }),
      ),

    /* ── The invoice logo (M7.5) ───────────────────────────────────────── */

    /**
     * Ask, PUT, confirm.
     *
     * ⚠️ The bytes go STRAIGHT to storage, not through this API — the second
     * step below is a bare `fetch` to a presigned URL, deliberately not
     * `api.request`, which would attach this app's credentials and JSON
     * handling to somebody else's host.
     *
     * The headers are not advisory: they are signed into the URL, so a PUT that
     * alters one fails at the bucket rather than here.
     */
    uploadLogo: async (file: File) => {
      const ticket = await viaService(() =>
        api.request(`${base}/invoicing/logo`, {
          method: 'POST',
          body: { contentType: file.type, contentLength: file.size },
          schema: PresignedUploadSchema,
        }),
      );

      const response = await fetch(ticket.uploadUrl, {
        method: 'PUT',
        headers: ticket.headers,
        body: file,
      });

      if (!response.ok) {
        throw new Error(`The logo could not be uploaded (${String(response.status)})`);
      }

      const { logoUrl } = await viaService(() =>
        api.request(`${base}/invoicing/logo`, {
          method: 'PUT',
          body: { key: ticket.key },
          schema: LogoConfirmedSchema,
        }),
      );

      return logoUrl;
    },

    removeLogo: async () => {
      await viaService(() =>
        api.request(`${base}/invoicing/logo`, { method: 'DELETE', schema: NoContentSchema }),
      );
    },

    /* ── The certificate signature (M9.5 · F52) ────────────────────────── */

    uploadCertificateSignature: async (file: File) => {
      const path = `${base}/invoicing/certificate-signature`;

      const ticket = await viaService(() =>
        api.request(path, {
          method: 'POST',
          body: { contentType: file.type, contentLength: file.size },
          schema: PresignedUploadSchema,
        }),
      );

      const response = await fetch(ticket.uploadUrl, {
        method: 'PUT',
        headers: ticket.headers,
        body: file,
      });

      if (!response.ok) {
        throw new Error(`The signature could not be uploaded (${String(response.status)})`);
      }

      const { certificateSignatureUrl } = await viaService(() =>
        api.request(path, {
          method: 'PUT',
          body: { key: ticket.key },
          schema: SignatureConfirmedSchema,
        }),
      );

      return certificateSignatureUrl;
    },

    removeCertificateSignature: async () => {
      await viaService(() =>
        api.request(`${base}/invoicing/certificate-signature`, {
          method: 'DELETE',
          schema: NoContentSchema,
        }),
      );
    },

    /* ── Rate cards (M6.1, M6.2) ───────────────────────────────────────── */

    createZone: (input: ZoneCreate) =>
      viaService(() =>
        api.request(`${base}/zones`, { method: 'POST', body: input, schema: ZoneSummarySchema }),
      ),

    renameZone: (id: string, input: ZoneUpdate) =>
      viaService(() =>
        api.request(`${base}/zones/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: input,
          schema: ZoneSummarySchema,
        }),
      ),

    reorderZones: (zoneIds: readonly string[]) =>
      viaService(() =>
        api.request(`${base}/zones/order`, {
          method: 'PUT',
          body: { zoneIds },
          schema: z.array(ZoneSummarySchema),
        }),
      ),

    /* ⚠️ Returns the RETIRED zone, not 204 — the screen shows what happened. */
    archiveZone: (id: string) =>
      viaService(() =>
        api.request(`${base}/zones/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          schema: ZoneSummarySchema,
        }),
      ),

    restoreZone: (id: string) =>
      viaService(() =>
        api.request(`${base}/zones/${encodeURIComponent(id)}/restore`, {
          method: 'POST',
          schema: ZoneSummarySchema,
        }),
      ),

    createRateCard: (input: RateCardCreate) =>
      viaService(() =>
        api.request(`${base}/rate-cards`, { method: 'POST', body: input, schema: cardSchema }),
      ),

    renameRateCard: (id: string, input: RateCardUpdate) =>
      viaService(() =>
        api.request(`${base}/rate-cards/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: input,
          schema: cardSchema,
        }),
      ),

    /* POST to a sub-collection: a schedule is ADDED, never overwritten. */
    issueSchedule: (id: string, input: RateScheduleCreate) =>
      viaService(() =>
        api.request(`${base}/rate-cards/${encodeURIComponent(id)}/schedules`, {
          method: 'POST',
          body: input,
          schema: cardSchema,
        }),
      ),

    /*
     * DELETE on the schedule's own path. The date identifies it, because that
     * is how a schedule is named everywhere else — the card plus the day it
     * starts.
     */
    deleteSchedule: (id: string, effectiveFrom: string) =>
      viaService(() =>
        api.request(
          `${base}/rate-cards/${encodeURIComponent(id)}/schedules/${encodeURIComponent(effectiveFrom)}`,
          { method: 'DELETE', schema: cardSchema },
        ),
      ),

    deleteRateCard: async (id: string) => {
      await viaService(() =>
        api.request(`${base}/rate-cards/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          // 204, so there is no body to parse. `z.unknown()` rather than a
          // shape: asserting one would fail on an empty response.
          schema: z.unknown(),
        }),
      );
    },

    /* ── Additional services (M6.5) ────────────────────────────────────── */

    createAdditionalService: (input: AdditionalServiceCreate) =>
      viaService(() =>
        api.request(`${base}/additional-services`, {
          method: 'POST',
          body: input,
          schema: serviceSchema,
        }),
      ),

    updateAdditionalService: (code: string, input: AdditionalServiceUpdate) =>
      viaService(() =>
        api.request(`${base}/additional-services/${encodeURIComponent(code)}`, {
          method: 'PATCH',
          body: input,
          schema: serviceSchema,
        }),
      ),

    deleteAdditionalService: async (code: string) => {
      await viaService(() =>
        api.request(`${base}/additional-services/${encodeURIComponent(code)}`, {
          method: 'DELETE',
          schema: z.unknown(),
        }),
      );
    },

    /* ── Invoice templates (M7.5) ────────────────────────────────────────── */

    createInvoiceTemplate: (input: InvoiceTemplateWrite) =>
      viaService(() =>
        api.request(`${base}/invoice-templates`, {
          method: 'POST',
          body: input,
          schema: SettingsSchema.shape.invoicing.shape.templates.element,
        }),
      ),

    updateInvoiceTemplate: (id: string, input: InvoiceTemplateWrite) =>
      viaService(() =>
        api.request(`${base}/invoice-templates/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: input,
          schema: SettingsSchema.shape.invoicing.shape.templates.element,
        }),
      ),

    deleteInvoiceTemplate: async (id: string) => {
      await viaService(() =>
        api.request(`${base}/invoice-templates/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          schema: z.unknown(),
        }),
      );
    },

    /* POST, not GET: it draws a PDF and stores it, so it is not something a
       browser may retry or prefetch on its own. */
    previewTemplate: (id: string) =>
      viaService(() =>
        api.request(`${base}/invoice-templates/${encodeURIComponent(id)}/preview`, {
          method: 'POST',
          schema: TemplatePreviewSchema,
        }),
      ),
  };
}

/** What the confirm answers with — the link to the logo now in force. */
const LogoConfirmedSchema = z.object({ logoUrl: z.string().nullable() });
const SignatureConfirmedSchema = z.object({ certificateSignatureUrl: z.string().nullable() });


