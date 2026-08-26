import type { Integration, Settings } from '@plastago/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { useServices } from '@/services/services-context';

export function useSettings() {
  const { settings } = useServices();
  return useQuery({
    queryKey: queryKeys.settings.detail(),
    queryFn: () => settings.get(),
    // Settings change rarely and are read by several tabs; refetching on every
    // tab switch would be pure waste.
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * One mutation per section rather than a single save.
 *
 * A failure in the pricing form must not discard what someone typed in
 * notifications — and a single PUT of the whole settings object would also make
 * two people editing different sections silently overwrite each other.
 */
function useSettingsMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.all });
      // The SLA and reminder settings change what the dashboard counts as at
      // risk, so it has to re-read.
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
    },
  });
}

export function useSaveGeneralSettings() {
  const { settings } = useServices();
  return useSettingsMutation((input: Settings['general']) => settings.saveGeneral(input));
}

export function useSaveNotificationSettings() {
  const { settings } = useServices();
  return useSettingsMutation((input: Settings['notifications']) =>
    settings.saveNotifications(input),
  );
}

export function useSaveInvoicingSettings() {
  const { settings } = useServices();
  return useSettingsMutation((input: Settings['invoicing']) => settings.saveInvoicing(input));
}

export function useSaveCredentialTypes() {
  const { settings } = useServices();
  return useSettingsMutation((input: Settings['credentialTypes']) =>
    settings.saveCredentialTypes(input),
  );
}

export function useTestIntegration() {
  const { settings } = useServices();
  return useSettingsMutation((id: Integration['id']) => settings.testIntegration(id));
}
