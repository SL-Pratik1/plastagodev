import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { useServices } from '@/services/services-context';
import type { ListQuery } from '@/services/types';

/* ── Drivers (M9.8 · F53, M9.9 · F22) ─────────────────────────────────────── */

export function useDriverList(query: ListQuery) {
  const { drivers } = useServices();
  return useQuery({
    queryKey: queryKeys.drivers.list(query),
    queryFn: () => drivers.list(query),
    placeholderData: (previous) => previous,
  });
}

export function useDriverProfile(id: string | undefined) {
  const { drivers } = useServices();
  return useQuery({
    queryKey: queryKeys.drivers.detail(id ?? 'none'),
    queryFn: () => drivers.get(id ?? ''),
    enabled: Boolean(id),
  });
}

/* ── Vehicles (M9.7 · F43) ────────────────────────────────────────────────── */

export function useVehicleList(query: ListQuery) {
  const { vehicles } = useServices();
  return useQuery({
    queryKey: queryKeys.vehicles.list(query),
    queryFn: () => vehicles.list(query),
    placeholderData: (previous) => previous,
  });
}

export function useVehicle(id: string | undefined) {
  const { vehicles } = useServices();
  return useQuery({
    queryKey: queryKeys.vehicles.detail(id ?? 'none'),
    queryFn: () => vehicles.get(id ?? ''),
    enabled: Boolean(id),
  });
}

/**
 * Renewing registration and resolving a defect both change what the
 * notification centre is chasing, so they invalidate it too — otherwise the bell
 * keeps asking for something already done, which is how people learn to ignore
 * it.
 */
function useFleetMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.vehicles.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    },
  });
}

export function useRenewRegistration() {
  const { vehicles } = useServices();
  return useFleetMutation((id: string) => vehicles.renewRegistration(id));
}

export function useResolveDefect() {
  const { vehicles } = useServices();
  return useFleetMutation(({ vehicleId, defectId }: { vehicleId: string; defectId: string }) =>
    vehicles.resolveDefect(vehicleId, defectId),
  );
}
