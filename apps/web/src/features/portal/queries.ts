import type {
  PortalAccountUpdate,
  PortalBookingDraft,
  PortalChangeRequest,
  PortalJobEdit,
  PortalSiteUpdate,
  PortalSupervisor,
  PortalSupervisorInvite,
  ReportFilters,
} from '@plastago/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { useServices } from '@/services/services-context';
import type { ListQuery } from '@/services/types';

/**
 * The customer portal's data layer (M5 Part 1).
 *
 * ── `scope` is cached hard and read by nearly every screen ────────────────
 * It answers "which account am I, do I see pricing, do I need a PO" — facts that
 * do not change inside a session. Refetching it per screen would put a second
 * round trip in front of every page on a phone on a building site, which is the
 * one place latency is genuinely expensive.
 */
export function usePortalScope() {
  const { portal } = useServices();
  return useQuery({
    queryKey: queryKeys.portal.scope(),
    queryFn: () => portal.scope(),
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}

export function usePortalDashboard() {
  const { portal } = useServices();
  return useQuery({
    queryKey: queryKeys.portal.dashboard(),
    queryFn: () => portal.dashboard(),
    refetchInterval: 60_000,
  });
}

/* ── Pickups ──────────────────────────────────────────────────────────────── */

export function usePortalJobs(query: ListQuery) {
  const { portal } = useServices();
  return useQuery({
    queryKey: queryKeys.portal.jobs(query),
    queryFn: () => portal.jobs(query),
    placeholderData: (previous) => previous,
  });
}

export function usePortalJob(id: string | undefined) {
  const { portal } = useServices();
  return useQuery({
    queryKey: queryKeys.portal.job(id ?? 'none'),
    queryFn: () => portal.job(id ?? ''),
    enabled: Boolean(id),
  });
}

/**
 * Anything that changes a pickup invalidates the whole portal AND the admin
 * domains, because a customer booking is the same job the office allocates.
 * A portal-only invalidation would leave the dispatch board a refresh behind.
 */
function usePortalJobMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: () => {
      for (const queryKey of [
        queryKeys.portal.all,
        queryKeys.jobs.all,
        queryKeys.dispatch.all,
        queryKeys.dashboard.all,
        queryKeys.notifications.all,
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}

/** M6.9 — the estimate, for roles that may see pricing. Never client-computed. */
export function usePortalQuote(draft: PortalBookingDraft | null, enabled: boolean) {
  const { portal } = useServices();
  return useQuery({
    queryKey: queryKeys.portal.quote(draft),
    queryFn: () => portal.quote(draft as PortalBookingDraft),
    enabled: enabled && draft !== null && draft.siteId !== '' && draft.expectedAreaM2 > 0,
    staleTime: 30_000,
    // A failed quote must never block a booking — the price is informational
    // here, and the authoritative figure is on the invoice.
    retry: false,
  });
}

export function usePortalBook() {
  const { portal } = useServices();
  return usePortalJobMutation((draft: PortalBookingDraft) => portal.book(draft));
}

export function usePortalEditJob() {
  const { portal } = useServices();
  return usePortalJobMutation(({ id, input }: { id: string; input: PortalJobEdit }) =>
    portal.editJob(id, input),
  );
}

export function usePortalRequestChange() {
  const { portal } = useServices();
  return usePortalJobMutation(({ id, input }: { id: string; input: PortalChangeRequest }) =>
    portal.requestChange(id, input),
  );
}

export function usePortalSetUrgency() {
  const { portal } = useServices();
  return usePortalJobMutation(({ id, urgent }: { id: string; urgent: boolean }) =>
    portal.setUrgency(id, urgent),
  );
}

export function usePortalCertifyReadiness() {
  const { portal } = useServices();
  return usePortalJobMutation((id: string) =>
    portal.certifyReadiness(id, {
      jobReady: true,
      truckAccessible: true,
      freeOfContaminants: true,
    }),
  );
}

/* ── Sites ────────────────────────────────────────────────────────────────── */

export function usePortalSites(query: ListQuery) {
  const { portal } = useServices();
  return useQuery({
    queryKey: queryKeys.portal.sites(query),
    queryFn: () => portal.sites(query),
    placeholderData: (previous) => previous,
  });
}

export function usePortalSite(id: string | undefined) {
  const { portal } = useServices();
  return useQuery({
    queryKey: queryKeys.portal.site(id ?? 'none'),
    queryFn: () => portal.site(id ?? ''),
    enabled: Boolean(id),
  });
}

export function usePortalUpdateSite() {
  const { portal } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: PortalSiteUpdate }) =>
      portal.updateSite(id, input),
    onSuccess: () => {
      // Also the admin side: the office reads these access notes on the run
      // sheet, and stale gate hours are how a driver ends up at a locked gate.
      void queryClient.invalidateQueries({ queryKey: queryKeys.portal.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dispatch.all });
    },
  });
}

/* ── Commercial — Customer Administrator only ─────────────────────────────── */

export function usePortalInvoices(query: ListQuery) {
  const { portal } = useServices();
  return useQuery({
    queryKey: queryKeys.portal.invoices(query),
    queryFn: () => portal.invoices(query),
    placeholderData: (previous) => previous,
  });
}

export function usePortalInvoicePdf() {
  const { portal } = useServices();
  return useMutation({ mutationFn: (ids: readonly string[]) => portal.requestInvoicePdf(ids) });
}

export function usePortalMonthlyReport(filters: ReportFilters) {
  const { portal } = useServices();
  return useQuery({
    queryKey: queryKeys.portal.report(filters),
    queryFn: () => portal.monthlyReport(filters),
    placeholderData: (previous) => previous,
  });
}

export function usePortalCertificates(query: ListQuery) {
  const { portal } = useServices();
  return useQuery({
    queryKey: queryKeys.portal.certificates(query),
    queryFn: () => portal.certificates(query),
    placeholderData: (previous) => previous,
  });
}

export function usePortalCertificatePdf() {
  const { portal } = useServices();
  return useMutation({ mutationFn: (id: string) => portal.requestCertificatePdf(id) });
}

/* ── Supervisors and account (M5.14, M5.15) ───────────────────────────────── */

export function usePortalSupervisors(query: ListQuery) {
  const { portal } = useServices();
  return useQuery({
    queryKey: queryKeys.portal.supervisors(query),
    queryFn: () => portal.supervisors(query),
    placeholderData: (previous) => previous,
  });
}

function useSupervisorMutation<TInput>(mutationFn: (input: TInput) => Promise<PortalSupervisor>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.portal.all });
      // A new supervisor is a new user on the account, which the office sees.
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
    },
  });
}

export function usePortalInviteSupervisor() {
  const { portal } = useServices();
  return useSupervisorMutation((input: PortalSupervisorInvite) => portal.inviteSupervisor(input));
}

export function usePortalSetSupervisorState() {
  const { portal } = useServices();
  return useSupervisorMutation(({ id, state }: { id: string; state: PortalSupervisor['state'] }) =>
    portal.setSupervisorState(id, state),
  );
}

export function usePortalSetSupervisorSites() {
  const { portal } = useServices();
  return useSupervisorMutation(
    ({ id, siteIds }: { id: string; siteIds: readonly string[] | null }) =>
      portal.setSupervisorSites(id, siteIds),
  );
}

export function usePortalApproveSupervisor() {
  const { portal } = useServices();
  return useSupervisorMutation((id: string) => portal.approveSupervisor(id));
}

export function usePortalAccount() {
  const { portal } = useServices();
  return useQuery({
    queryKey: queryKeys.portal.account(),
    queryFn: () => portal.account(),
  });
}

export function usePortalUpdateAccount() {
  const { portal } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: PortalAccountUpdate) => portal.updateAccount(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.portal.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.all });
    },
  });
}
