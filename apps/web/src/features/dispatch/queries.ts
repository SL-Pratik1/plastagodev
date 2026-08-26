import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { useServices } from '@/services/services-context';

export function useAllocationBoard(date: string) {
  const { dispatch } = useServices();
  return useQuery({
    queryKey: queryKeys.dispatch.board(date),
    queryFn: () => dispatch.board(date),
    placeholderData: (previous) => previous,
  });
}

export function useRunSheet(driverId: string | null, date: string) {
  const { dispatch } = useServices();
  return useQuery({
    queryKey: queryKeys.dispatch.runSheet(driverId ?? 'none', date),
    queryFn: () => dispatch.runSheet(driverId ?? '', date),
    enabled: Boolean(driverId),
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

/**
 * Allocation.
 *
 * Invalidates dispatch AND jobs, because they are two views of one fact: the
 * board moving a card and the jobs grid showing a driver name must agree. It
 * also invalidates the dashboard, whose unallocated counter just changed.
 *
 * No optimistic update. Assignment can legitimately fail — the driver may be at
 * capacity, which the service enforces — and a card that jumps to a driver and
 * then jumps back is worse than one that waits 400 ms and lands once.
 */
export function useAssignJob() {
  const { dispatch } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ jobId, driverId, date }: { jobId: string; driverId: string; date: string }) =>
      dispatch.assign(jobId, driverId, date),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.dispatch.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
    },
  });
}

export function useUnassignJob() {
  const { dispatch } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (jobId: string) => dispatch.unassign(jobId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.dispatch.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
    },
  });
}
