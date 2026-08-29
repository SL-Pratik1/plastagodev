import type {
  VehicleDefectState,
  VehicleDraft,
  VehicleExpenseDraft,
} from '@plastago/shared';
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
  return useFleetMutation(
    ({ id, expense }: { id: string; expense?: VehicleExpenseDraft | null }) =>
      vehicles.renewRegistration(id, expense),
  );
}

/**
 * open → scheduled → resolved.
 *
 * One hook rather than `useResolveDefect` plus `useScheduleDefect`, because the
 * two differ only in the value they pass and a pair would drift the moment a
 * fourth state appears.
 */
export function useSetDefectState() {
  const { vehicles } = useServices();
  return useFleetMutation(
    ({
      vehicleId,
      defectId,
      state,
    }: {
      vehicleId: string;
      defectId: string;
      state: VehicleDefectState;
    }) => vehicles.setDefectState(vehicleId, defectId, state),
  );
}

export function useCreateVehicle() {
  const { vehicles } = useServices();
  return useFleetMutation((draft: VehicleDraft) => vehicles.create(draft));
}

export function useUpdateVehicle() {
  const { vehicles } = useServices();
  return useFleetMutation(({ id, draft }: { id: string; draft: VehicleDraft }) =>
    vehicles.update(id, draft),
  );
}

export function useSetVehicleActive() {
  const { vehicles } = useServices();
  return useFleetMutation(({ id, active }: { id: string; active: boolean }) =>
    vehicles.setActive(id, active),
  );
}

/**
 * Invalidates the DRIVER list as well as the vehicle one.
 *
 * The assignment shows on both screens — "Vehicle" on the drivers grid, "Driver"
 * on the vehicles grid — so refreshing only the side you happened to be looking
 * at leaves the other one confidently wrong until something else happens to
 * refetch it. Same reason dispatch is invalidated: a run sheet names the truck.
 */
export function useAssignVehicleDriver() {
  const { vehicles } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, driverName }: { id: string; driverName: string | null }) =>
      vehicles.assignDriver(id, driverName),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.vehicles.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.drivers.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dispatch.all });
    },
  });
}

export function useAddVehicleExpense() {
  const { vehicles } = useServices();
  return useFleetMutation(({ id, draft }: { id: string; draft: VehicleExpenseDraft }) =>
    vehicles.addExpense(id, draft),
  );
}

export function useSetNextService() {
  const { vehicles } = useServices();
  return useFleetMutation(({ id, dueOn }: { id: string; dueOn: string | null }) =>
    vehicles.setNextService(id, dueOn),
  );
}
