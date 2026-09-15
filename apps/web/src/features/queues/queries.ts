import type {
  CallUpRequest,
  CallUpState,
  ChangeRequestDecision,
  ChargeDecision,
  FutileDecision,
  LeadConversion,
  LeadCreate,
  LeadUpdate,
  PoConfirmation,
} from '@plastago/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { useServices } from '@/services/services-context';
import type { ListQuery } from '@/services/types';

/**
 * The five office queues.
 *
 * ── Why every mutation invalidates four domains ────────────────────────────
 * A queue decision is never local to its own grid. Approving a charge changes
 * the job, may move an invoice into the awaiting-PO queue, changes the dashboard
 * counter and produces a notification. Invalidating only `queues` would leave
 * the nav badge correct and the dashboard tile wrong — the exact class of
 * inconsistency that makes people stop trusting a console.
 */

const REFRESH_ON_DECISION = [
  queryKeys.queues.all,
  queryKeys.jobs.all,
  queryKeys.invoices.all,
  queryKeys.dashboard.all,
  queryKeys.notifications.all,
] as const;

function useQueueMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: () => {
      for (const queryKey of REFRESH_ON_DECISION) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}

/**
 * The nav badge counts.
 *
 * Refetched on an interval as well as on mutation, because the whole premise of
 * these queues is that work arrives while you are looking at something else — a
 * driver marks a job futile at 09:21 and the office should not have to reload to
 * find out. Sixty seconds is slow enough to be free and fast enough to matter.
 */
export function useQueueCounts() {
  const { queues } = useServices();
  return useQuery({
    queryKey: queryKeys.queues.counts(),
    queryFn: () => queues.counts(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

/* ── M2.6 · Futile review ─────────────────────────────────────────────────── */

export function useFutileList(query: ListQuery) {
  const { queues } = useServices();
  return useQuery({
    queryKey: queryKeys.queues.futileList(query),
    queryFn: () => queues.futileList(query),
    placeholderData: (previous) => previous,
  });
}

export function useFutileReview(id: string | undefined) {
  const { queues } = useServices();
  return useQuery({
    queryKey: queryKeys.queues.futileDetail(id ?? 'none'),
    queryFn: () => queues.futileGet(id ?? ''),
    enabled: Boolean(id),
  });
}

export function useFutileDecide() {
  const { queues } = useServices();
  return useQueueMutation(({ id, decision }: { id: string; decision: FutileDecision }) =>
    queues.futileDecide(id, decision),
  );
}

/* ── M2.7 · Service approvals ─────────────────────────────────────────────── */

export function useApprovalList(query: ListQuery) {
  const { queues } = useServices();
  return useQuery({
    queryKey: queryKeys.queues.approvalList(query),
    queryFn: () => queues.approvalList(query),
    placeholderData: (previous) => previous,
  });
}

export function useApprovalDetail(id: string | undefined) {
  const { queues } = useServices();
  return useQuery({
    queryKey: queryKeys.queues.approvalDetail(id ?? 'none'),
    queryFn: () => queues.approvalGet(id ?? ''),
    enabled: Boolean(id),
  });
}

export function useApprovalDecide() {
  const { queues } = useServices();
  return useQueueMutation(
    ({ ids, decision }: { ids: readonly string[]; decision: ChargeDecision }) =>
      queues.approvalDecide(ids, decision),
  );
}

/* ── M7.3 · Awaiting PO ───────────────────────────────────────────────────── */

export function useAwaitingPoList(query: ListQuery) {
  const { queues } = useServices();
  return useQuery({
    queryKey: queryKeys.queues.awaitingPoList(query),
    queryFn: () => queues.awaitingPoList(query),
    placeholderData: (previous) => previous,
  });
}

export function useAwaitingPoChase() {
  const { queues } = useServices();
  return useQueueMutation((ids: readonly string[]) => queues.awaitingPoChase(ids));
}

/* ── M5.4 · Change requests ───────────────────────────────────────────────── */

export function useChangeRequestList(query: ListQuery) {
  const { queues } = useServices();
  return useQuery({
    queryKey: queryKeys.queues.changeRequestList(query),
    queryFn: () => queues.changeRequestList(query),
    placeholderData: (previous) => previous,
  });
}

export function useChangeRequestDecide() {
  const { queues } = useServices();
  return useQueueMutation((input: { id: string; decision: ChangeRequestDecision }) =>
    queues.changeRequestDecide(input.id, input.decision),
  );
}

/* ── M2.12 · PO review ────────────────────────────────────────────────────── */

export function usePoReviewList(query: ListQuery) {
  const { queues } = useServices();
  return useQuery({
    queryKey: queryKeys.queues.poReviewList(query),
    queryFn: () => queues.poReviewList(query),
    placeholderData: (previous) => previous,
  });
}

export function usePoExtraction(id: string | undefined) {
  const { queues } = useServices();
  return useQuery({
    queryKey: queryKeys.queues.poReviewDetail(id ?? 'none'),
    queryFn: () => queues.poReviewGet(id ?? ''),
    enabled: Boolean(id),
  });
}

export function usePoReviewConfirm() {
  const { queues } = useServices();
  return useQueueMutation(({ id, input }: { id: string; input: PoConfirmation }) =>
    queues.poReviewConfirm(id, input),
  );
}

export function usePoReviewReject() {
  const { queues } = useServices();
  return useQueueMutation(({ id, note }: { id: string; note: string }) =>
    queues.poReviewReject(id, note),
  );
}

/* ── M2.12b · call-ups ───────────────────────────────────────────────────── */

/**
 * Orders confirmed and not booked — Matt's *"sitting there waiting"* (21:30).
 */
export function useAwaitingCallUps(query: ListQuery) {
  const { queues } = useServices();
  return useQuery({
    queryKey: queryKeys.queues.awaitingCallUpList(query),
    queryFn: () => queues.awaitingCallUpList(query),
  });
}

export function useCallUps(query: ListQuery & { state?: CallUpState }) {
  const { queues } = useServices();
  return useQuery({
    queryKey: queryKeys.queues.callUpList(query),
    queryFn: () => queues.callUpList(query),
  });
}

export function useCallUp(id: string | undefined) {
  const { queues } = useServices();
  return useQuery({
    queryKey: queryKeys.queues.callUpDetail(id ?? 'none'),
    queryFn: () => queues.callUpGet(id ?? ''),
    enabled: Boolean(id),
  });
}

/**
 * Calling an order up by hand (Matt, 30:40).
 *
 * ⚠️ Goes through `useQueueMutation` like every other queue act, so the nav
 * badges and both lists refetch. A call-up that books a job empties a row from
 * the waiting list and adds one to the board, and a screen still showing the
 * order as unbooked invites somebody to call it up twice.
 */
export function useCallUpOrder() {
  const { queues } = useServices();
  return useQueueMutation(
    ({ purchaseOrderId, request }: { purchaseOrderId: string; request: CallUpRequest }) =>
      queues.callUpOrder(purchaseOrderId, request),
  );
}

/**
 * Retrying a queued call-up.
 *
 * ⚠️ A queue mutation, because a successful retry changes three lists at once:
 * this queue empties a row, the waiting-orders list loses one, and a job appears
 * on the board. Invalidating only this screen would leave the other two lying.
 */
export function useCallUpRetry() {
  const { queues } = useServices();
  return useQueueMutation((id: string) => queues.callUpRetry(id));
}

export function useCallUpReject() {
  const { queues } = useServices();
  return useQueueMutation(({ id, note }: { id: string; note: string }) =>
    queues.callUpReject(id, note),
  );
}

/* ── M5 · Journey A — leads ───────────────────────────────────────────────── */

export function useLeadList(query: ListQuery) {
  const { queues } = useServices();
  return useQuery({
    queryKey: queryKeys.queues.leadList(query),
    queryFn: () => queues.leadList(query),
    placeholderData: (previous) => previous,
  });
}

/**
 * The three cards above the grid.
 *
 * Invalidated by `useQueueMutation` along with everything else under
 * `queues.all`, so converting a lead moves the Won figure without a reload.
 */
export function useLeadStats() {
  const { queues } = useServices();
  return useQuery({
    queryKey: queryKeys.queues.leadStats(),
    queryFn: () => queues.leadStats(),
  });
}

export function useLead(id: string | undefined) {
  const { queues } = useServices();
  return useQuery({
    queryKey: queryKeys.queues.leadDetail(id ?? 'none'),
    queryFn: () => queues.leadGet(id ?? ''),
    enabled: Boolean(id),
  });
}

/**
 * A.1 — take a lead by hand.
 *
 * Uses `useQueueMutation` like every other queue write, which is more
 * invalidation than a new lead strictly causes — it touches no job and no
 * invoice. That is deliberate: the alternative is a bespoke invalidation list
 * per mutation, and the one thing a new lead MUST refresh is the nav badge,
 * which is `queues.counts` and is exactly what the shared helper already gets
 * right. Refetching a couple of idle queries is cheaper than a stale badge.
 */
export function useLeadCreate() {
  const { queues } = useServices();
  return useQueueMutation((input: LeadCreate) => queues.leadCreate(input));
}

export function useLeadUpdate() {
  const { queues } = useServices();
  return useQueueMutation(({ id, input }: { id: string; input: LeadUpdate }) =>
    queues.leadUpdate(id, input),
  );
}

/** Attach a PDF proposal to a lead (Matt, 5:53). */
export function useLeadAttach() {
  const { queues } = useServices();
  return useQueueMutation(({ id, file }: { id: string; file: File }) =>
    queues.leadAttach(id, file),
  );
}

export function useLeadDetach() {
  const { queues } = useServices();
  return useQueueMutation(({ id, attachmentId }: { id: string; attachmentId: string }) =>
    queues.leadDetach(id, attachmentId),
  );
}

/** A.4 — also touches accounts and lookups, since an account now exists. */
export function useLeadConvert() {
  const { queues } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: LeadConversion }) =>
      queues.leadConvert(id, input),
    onSuccess: () => {
      for (const queryKey of [
        queryKeys.queues.all,
        queryKeys.customers.all,
        queryKeys.lookups.all,
        queryKeys.dashboard.all,
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}
