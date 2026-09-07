import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateRunInput } from '@plastago/shared';
import { queryKeys } from '@/lib/query-keys';
import { useServices } from '@/services/services-context';

/**
 * Allocation and dispatch (M3).
 *
 * ── Every mutation here invalidates three domains ─────────────────────────
 * Dispatch, jobs and the dashboard are three views of one fact. The board
 * moving a stop, the jobs grid showing a driver name and the dashboard's
 * unallocated counter must agree, and they only do if all three are dropped
 * together.
 *
 * ── And none of them is optimistic ────────────────────────────────────────
 * Every write below can legitimately fail — the driver may be over capacity,
 * the job may already be on another run, the run may have left the yard. A card
 * that jumps and then jumps back is worse than one that waits 400 ms and lands
 * once.
 */

export function useAllocationBoard(date: string) {
  const { dispatch } = useServices();
  return useQuery({
    queryKey: queryKeys.dispatch.board(date),
    queryFn: () => dispatch.board(date),
    placeholderData: (previous) => previous,
  });
}

/** One run's sheet. A driver working a morning and an afternoon has two. */
export function useRunSheet(runId: string | null) {
  const { dispatch } = useServices();
  return useQuery({
    queryKey: queryKeys.dispatch.runSheet(runId ?? 'none'),
    queryFn: () => dispatch.runSheet(runId ?? ''),
    enabled: Boolean(runId),
  });
}

export function useMapPins(date: string) {
  const { dispatch } = useServices();
  return useQuery({
    queryKey: queryKeys.dispatch.map(date),
    queryFn: () => dispatch.mapPins(date),
    placeholderData: (previous) => previous,
  });
}

export function useDrivers() {
  const { dispatch } = useServices();
  return useQuery({
    queryKey: queryKeys.dispatch.drivers(),
    queryFn: () => dispatch.drivers(),
    staleTime: 5 * 60 * 1000,
  });
}

/** Shared by every dispatch write — see the note at the top of this file. */
function useDispatchInvalidation() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.dispatch.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
  };
}

/* ── Building a run ─────────────────────────────────────────────────────── */

export function useCreateRun() {
  const { dispatch } = useServices();
  const invalidate = useDispatchInvalidation();

  return useMutation({
    mutationFn: (input: CreateRunInput) => dispatch.createRun(input),
    onSuccess: invalidate,
  });
}

export function useRenameRun() {
  const { dispatch } = useServices();
  const invalidate = useDispatchInvalidation();

  return useMutation({
    mutationFn: ({ runId, name }: { runId: string; name: string }) =>
      dispatch.renameRun(runId, name),
    onSuccess: invalidate,
  });
}

export function useDeleteRun() {
  const { dispatch } = useServices();
  const invalidate = useDispatchInvalidation();

  return useMutation({
    mutationFn: (runId: string) => dispatch.deleteRun(runId),
    onSuccess: invalidate,
  });
}

export function useAddJobToRun() {
  const { dispatch } = useServices();
  const invalidate = useDispatchInvalidation();

  return useMutation({
    mutationFn: ({ runId, jobId }: { runId: string; jobId: string }) =>
      dispatch.addJobToRun(runId, jobId),
    onSuccess: invalidate,
  });
}

export function useRemoveJobFromRun() {
  const { dispatch } = useServices();
  const invalidate = useDispatchInvalidation();

  return useMutation({
    mutationFn: ({ runId, jobId }: { runId: string; jobId: string }) =>
      dispatch.removeJobFromRun(runId, jobId),
    onSuccess: invalidate,
  });
}

export function useReorderRun() {
  const { dispatch } = useServices();
  const invalidate = useDispatchInvalidation();

  return useMutation({
    mutationFn: ({ runId, jobIds }: { runId: string; jobIds: readonly string[] }) =>
      dispatch.reorderRun(runId, jobIds),
    onSuccess: invalidate,
  });
}

/**
 * I11 — Google Route Optimization.
 *
 * Slower than the other writes on purpose: it is a network call to Google in
 * the real build, and a spinner that resolves instantly trains the allocator to
 * expect something the shipped version cannot deliver.
 */
export function useOptimiseRun() {
  const { dispatch } = useServices();
  const invalidate = useDispatchInvalidation();

  return useMutation({
    mutationFn: (runId: string) => dispatch.optimiseRun(runId),
    onSuccess: invalidate,
  });
}

/* ── Staffing it ────────────────────────────────────────────────────────── */

export function useAssignRun() {
  const { dispatch } = useServices();
  const invalidate = useDispatchInvalidation();

  return useMutation({
    mutationFn: ({ runId, driverId }: { runId: string; driverId: string }) =>
      dispatch.assignRun(runId, driverId),
    onSuccess: invalidate,
  });
}

export function useUnassignRun() {
  const { dispatch } = useServices();
  const invalidate = useDispatchInvalidation();

  return useMutation({
    mutationFn: (runId: string) => dispatch.unassignRun(runId),
    onSuccess: invalidate,
  });
}
