import type { ListQuery } from '@/services/types';

/**
 * Every TanStack Query key in one place.
 *
 * Inline keys are the usual cause of a stale grid after a mutation: the
 * invalidation and the query disagree by one character and nobody notices.
 * Declaring them here makes invalidation a compile-checked call.
 *
 *   queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
 *
 * Each domain exposes `all` so a mutation can invalidate the whole domain
 * without knowing which filter combination happens to be on screen — the cheap,
 * correct default. Reach for a narrower key only when a domain gets large enough
 * that refetching it is measurably slow.
 */
export const queryKeys = {
  health: {
    all: ['health'] as const,
    readiness: () => [...queryKeys.health.all, 'readiness'] as const,
  },

  lookups: {
    all: ['lookups'] as const,
    accounts: () => [...queryKeys.lookups.all, 'accounts'] as const,
    builders: () => [...queryKeys.lookups.all, 'builders'] as const,
    drivers: () => [...queryKeys.lookups.all, 'drivers'] as const,
    rateCards: () => [...queryKeys.lookups.all, 'rate-cards'] as const,
    zones: () => [...queryKeys.lookups.all, 'zones'] as const,
    places: (query: string) => [...queryKeys.lookups.all, 'places', query] as const,
  },

  dashboard: {
    all: ['dashboard'] as const,
    summary: () => [...queryKeys.dashboard.all, 'summary'] as const,
  },

  users: {
    all: ['users'] as const,
    list: (query: ListQuery) => [...queryKeys.users.all, 'list', query] as const,
    detail: (id: string) => [...queryKeys.users.all, 'detail', id] as const,
  },

  customers: {
    all: ['customers'] as const,
    list: (query: ListQuery) => [...queryKeys.customers.all, 'list', query] as const,
    detail: (id: string) => [...queryKeys.customers.all, 'detail', id] as const,
    jobs: (id: string, query: ListQuery) =>
      [...queryKeys.customers.all, 'jobs', id, query] as const,
    invoices: (id: string, query: ListQuery) =>
      [...queryKeys.customers.all, 'invoices', id, query] as const,
  },

  jobs: {
    all: ['jobs'] as const,
    list: (query: ListQuery) => [...queryKeys.jobs.all, 'list', query] as const,
    detail: (id: string) => [...queryKeys.jobs.all, 'detail', id] as const,
    /** Keyed by the draft so a changed field refetches, and an unchanged one does not. */
    preview: (draft: unknown) => [...queryKeys.jobs.all, 'preview', draft] as const,
    /** M2.12 — the purchase orders one account can book a pickup against. */
    purchaseOrders: (accountId: string, search: string) =>
      [...queryKeys.jobs.all, 'purchase-orders', accountId, search] as const,
  },

  invoices: {
    all: ['invoices'] as const,
    list: (query: ListQuery) => [...queryKeys.invoices.all, 'list', query] as const,
    detail: (id: string) => [...queryKeys.invoices.all, 'detail', id] as const,
  },

  reports: {
    all: ['reports'] as const,
    monthlyVolume: (filters: unknown) =>
      [...queryKeys.reports.all, 'monthly-volume', filters] as const,
    zoneVolume: (filters: unknown) => [...queryKeys.reports.all, 'zone-volume', filters] as const,
    financial: (filters: unknown) => [...queryKeys.reports.all, 'financial', filters] as const,
    certificates: (query: ListQuery) => [...queryKeys.reports.all, 'certificates', query] as const,
  },

  drivers: {
    all: ['drivers'] as const,
    list: (query: ListQuery) => [...queryKeys.drivers.all, 'list', query] as const,
    detail: (id: string) => [...queryKeys.drivers.all, 'detail', id] as const,
  },

  vehicles: {
    all: ['vehicles'] as const,
    list: (query: ListQuery) => [...queryKeys.vehicles.all, 'list', query] as const,
    detail: (id: string) => [...queryKeys.vehicles.all, 'detail', id] as const,
  },

  notifications: {
    all: ['notifications'] as const,
    list: (query: ListQuery) => [...queryKeys.notifications.all, 'list', query] as const,
    summary: () => [...queryKeys.notifications.all, 'summary'] as const,
  },

  settings: {
    all: ['settings'] as const,
    detail: () => [...queryKeys.settings.all, 'detail'] as const,
  },

  /**
   * I1 · M7.8 — the Xero connection's state.
   *
   * Its own domain rather than a key under `settings`, for the same reason as
   * the extractor below: a settings save neither invalidates it nor should
   * cause a round trip to a third party's status.
   */
  xero: {
    all: ['xero'] as const,
    status: () => [...queryKeys.xero.all, 'status'] as const,
  },

  /**
   * I6 — the Extractor tab's brokered session.
   *
   * Its own domain rather than a key under `settings`, because it is neither
   * invalidated by a settings save nor worth re-minting when one happens.
   */
  extractor: {
    all: ['extractor'] as const,
    session: () => [...queryKeys.extractor.all, 'session'] as const,
  },

  /**
   * The five office queues. One domain key, because one decision usually moves
   * more than one queue — approving a charge on a PO-required account empties a
   * row from approvals and adds one to awaiting-PO.
   */
  queues: {
    all: ['queues'] as const,
    counts: () => [...queryKeys.queues.all, 'counts'] as const,
    futileList: (query: ListQuery) => [...queryKeys.queues.all, 'futile', query] as const,
    futileDetail: (id: string) => [...queryKeys.queues.all, 'futile', 'detail', id] as const,
    approvalList: (query: ListQuery) => [...queryKeys.queues.all, 'approvals', query] as const,
    approvalDetail: (id: string) => [...queryKeys.queues.all, 'approvals', 'detail', id] as const,
    awaitingPoList: (query: ListQuery) => [...queryKeys.queues.all, 'awaiting-po', query] as const,
    changeRequestList: (query: ListQuery) =>
      [...queryKeys.queues.all, 'change-requests', query] as const,
    /* M2.12b — orders waiting for a date, and the call-ups that arrived. */
    awaitingCallUpList: (query: ListQuery) =>
      [...queryKeys.queues.all, 'call-ups', 'awaiting', query] as const,
    callUpList: (query: ListQuery & { state?: string }) =>
      [...queryKeys.queues.all, 'call-ups', query] as const,
    callUpDetail: (id: string) => [...queryKeys.queues.all, 'call-ups', 'detail', id] as const,
    poReviewList: (query: ListQuery) => [...queryKeys.queues.all, 'po-review', query] as const,
    poReviewDetail: (id: string) => [...queryKeys.queues.all, 'po-review', 'detail', id] as const,
    leadList: (query: ListQuery) => [...queryKeys.queues.all, 'leads', query] as const,
    leadStats: () => [...queryKeys.queues.all, 'leads', 'stats'] as const,
    leadDetail: (id: string) => [...queryKeys.queues.all, 'leads', 'detail', id] as const,
  },

  /**
   * The customer portal (M5). One domain key, because every portal read is
   * scoped to the same session — invalidating "the portal" after a booking is
   * both correct and cheap, and it is what keeps the dashboard's next-pickup
   * tile honest the moment a supervisor books.
   */
  portal: {
    all: ['portal'] as const,
    scope: () => [...queryKeys.portal.all, 'scope'] as const,
    dashboard: () => [...queryKeys.portal.all, 'dashboard'] as const,
    jobs: (query: ListQuery) => [...queryKeys.portal.all, 'jobs', query] as const,
    /** M2.12b — this account's orders with no pickup booked against them. */
    awaitingCallUp: (query: ListQuery) =>
      [...queryKeys.portal.all, 'purchase-orders', 'awaiting', query] as const,
    job: (id: string) => [...queryKeys.portal.all, 'job', id] as const,
    quote: (draft: unknown) => [...queryKeys.portal.all, 'quote', draft] as const,
    invoices: (query: ListQuery) => [...queryKeys.portal.all, 'invoices', query] as const,
    report: (filters: unknown) => [...queryKeys.portal.all, 'report', filters] as const,
    certificates: (query: ListQuery) => [...queryKeys.portal.all, 'certificates', query] as const,
    supervisors: (query: ListQuery) => [...queryKeys.portal.all, 'supervisors', query] as const,
    account: () => [...queryKeys.portal.all, 'account'] as const,
    onboarding: () => [...queryKeys.portal.all, 'onboarding'] as const,
  },

  dispatch: {
    all: ['dispatch'] as const,
    board: (date: string) => [...queryKeys.dispatch.all, 'board', date] as const,
    /** Keyed by RUN, not by driver-and-date — a driver has two on a busy day. */
    runSheet: (runId: string) => [...queryKeys.dispatch.all, 'run-sheet', runId] as const,
    map: (date: string) => [...queryKeys.dispatch.all, 'map', date] as const,
    drivers: () => [...queryKeys.dispatch.all, 'drivers'] as const,
  },
} as const;
