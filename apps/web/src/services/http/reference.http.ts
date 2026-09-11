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
  SettingsSchema,
  UserListItemSchema,
  UserSchema,
  type AdditionalServiceCreate,
  type AdditionalServiceUpdate,
  type InvoiceTemplateWrite,
  type RateCardCreate,
  type RateCardUpdate,
  type RateScheduleCreate,
  type Settings,
  type UserDraft,
  type UserStatus,
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
  UserService,
} from '../types.js';
import { listParams, pageOf } from './list-params.js';
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
   * Saves are per SECTION, matching the API. One giant PUT would mean a failure
   * in one form discards what somebody typed in another — and each section
   * returns only its own slice, so a save cannot silently overwrite a sibling
   * with stale values from this tab.
   *
   * Invoicing is the only writable section: pricing is read-only because rates
   * are effective-dated, and the notification-rules, integrations and
   * credential-type sections were removed.
   */
  const section = <TKey extends keyof Settings>(
    path: string,
    schema: z.ZodType<Settings[TKey]>,
  ) =>
    (input: Settings[TKey]): Promise<Settings[TKey]> =>
      viaService(() => api.request(`${base}/${path}`, { method: 'PUT', body: input, schema }));

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

    saveInvoicing: section<'invoicing'>('invoicing', SettingsSchema.shape.invoicing),

    /* ── Rate cards (M6.1, M6.2) ───────────────────────────────────────── */

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
  };
}


