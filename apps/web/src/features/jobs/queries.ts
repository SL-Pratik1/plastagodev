import type { JobCommentDraft, JobDraft, OfficeCancelReason } from '@plastago/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LIVE_REFRESH } from '@/lib/live-refresh';
import { queryKeys } from '@/lib/query-keys';
import { useServices } from '@/services/services-context';
import type { ListQuery } from '@/services/types';

export function useJobList(query: ListQuery) {
  const { jobs } = useServices();
  return useQuery({
    queryKey: queryKeys.jobs.list(query),
    queryFn: () => jobs.list(query),
    placeholderData: (previous) => previous,
  });
}

export function useJob(id: string | undefined) {
  const { jobs } = useServices();
  return useQuery({
    queryKey: queryKeys.jobs.detail(id ?? 'none'),
    queryFn: () => jobs.get(id ?? ''),
    enabled: Boolean(id),
    ...LIVE_REFRESH,
  });
}

/**
 * The price estimate on the create-job form (M2.1).
 *
 * A query rather than a mutation, deliberately: it is a read, it is idempotent,
 * and keying it on the draft means an unchanged form does not re-ask the server
 * on every keystroke while a changed one does. `enabled` holds it back until the
 * form has the two fields pricing actually needs — a site (which decides the
 * zone) and an area — so the panel never shows a total built on nothing.
 */
export function useJobPricePreview(draft: JobDraft | null) {
  const { jobs } = useServices();

  return useQuery({
    queryKey: queryKeys.jobs.preview(draft),
    queryFn: () => jobs.preview(draft as JobDraft),
    // The suburb is what carries the zone, and the zone is what prices the
    // job — so there is nothing to preview until one is chosen.
    enabled: draft !== null && draft.placeId !== '',
    staleTime: 30_000,
  });
}

/**
 * M2.12 — the purchase orders a pickup can be booked against.
 *
 * Held until an account is chosen, because purchase orders are scoped to one:
 * asking without an account would either return nothing or, worse, everything.
 *
 * Cached briefly rather than aggressively. A confirmed order can appear in this
 * list within minutes of the extractor reading it, and an office that has just
 * approved one in the review queue expects to find it here.
 */
export function useBookablePurchaseOrders(accountId: string | undefined, search = '') {
  const { jobs } = useServices();

  return useQuery({
    queryKey: queryKeys.jobs.purchaseOrders(accountId ?? '', search),
    queryFn: () => jobs.purchaseOrders(accountId as string, search || undefined),
    enabled: Boolean(accountId),
    staleTime: 30_000,
  });
}

export function useCreateJob() {
  const { jobs } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (draft: JobDraft) => jobs.create(draft),
    onSuccess: () => {
      // A new job changes the dashboard counters, the allocation board and the
      // account's open-job count — all three read from the same store.
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dispatch.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.all });
    },
  });
}

export function useCancelJob() {
  const { jobs } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, reason, note }: { id: string; reason: OfficeCancelReason; note: string }) =>
      jobs.cancel(id, reason, note),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dispatch.all });
    },
  });
}

/** Undo an arrival from the office (21 Oct): off the run, no charge. */
export function useUnarriveJob() {
  const { jobs } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => jobs.unarrive(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dispatch.all });
    },
  });
}

/** "Set m²" (23 Oct) — the price moves, and a held invoice may go out. */
export function useSetJobArea() {
  const { jobs } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, expectedAreaM2 }: { id: string; expectedAreaM2: number }) =>
      jobs.setArea(id, expectedAreaM2),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.invoices.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    },
  });
}

export function useRescheduleJob() {
  const { jobs } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, readyDate }: { id: string; readyDate: string }) =>
      jobs.reschedule(id, readyDate),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dispatch.all });
    },
  });
}

/**
 * M2.11 / M8.6 — post a comment.
 *
 * Only the job is invalidated. A comment changes nothing else: not the
 * dashboard, not the board, not an invoice. Invalidating broadly "to be safe"
 * is what turns a 300ms post into four refetches and a visibly stuttering page.
 */
export function useAddJobComment() {
  const { jobs } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, draft }: { id: string; draft: JobCommentDraft }) =>
      jobs.addComment(id, draft),
    onSuccess: (_comment, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.detail(variables.id) });
    },
  });
}
