import type {
  AdditionalServiceCreate,
  AdditionalServiceUpdate,
  InvoiceTemplateWrite,
  RateCardCreate,
  RateScheduleCreate,
  Settings,
} from '@plastago/shared';
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
 * Invoicing is the only writable section today, but the seam stays: a single
 * PUT of the whole settings object would make two people editing different
 * sections silently overwrite each other, and pricing is next in line to
 * become editable.
 */
function useSettingsMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.all });
      // Settings feed the dashboard's at-risk counts, so it has to re-read.
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
    },
  });
}

/*
 * There is no `useSaveGeneralSettings`, and no `saveGeneral` on the settings
 * service either. The General tab is gone and so is `PUT /settings/general` —
 * see the note in `@plastago/shared`'s settings schema. The SLA still drives
 * every job's target date; it is a seed-time value now rather than a form.
 *
 * There is likewise no `useSaveNotificationSettings`, `useSaveCredentialTypes`
 * or `useTestIntegration`. Those three sections were removed outright: every
 * one of them wrote a value nothing downstream ever read.
 */

export function useSaveInvoicingSettings() {
  const { settings } = useServices();
  return useSettingsMutation((input: Settings['invoicing']) => settings.saveInvoicing(input));
}

/* ── Pricing (M6.1, M6.2) ────────────────────────────────────────────────── */

/**
 * A pricing write, which invalidates one thing the invoicing writes do not.
 *
 * ⚠️ `queryKeys.lookups.all` as well as settings. Rate cards populate the
 * dropdowns on new-customer, the customers filter and lead conversion, and
 * those are cached for an HOUR — so without this a card created on this screen
 * would be invisible everywhere else for the rest of the session, which reads
 * as the save having silently failed.
 */
function usePricingMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.lookups.all });
      /*
       * Jobs and quotes too: a new schedule changes what the next booking is
       * priced at, and a stale preview would quote yesterday's rate.
       */
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
    },
  });
}

export function useCreateRateCard() {
  const { settings } = useServices();
  return usePricingMutation((input: RateCardCreate) => settings.createRateCard(input));
}

export function useRenameRateCard() {
  const { settings } = useServices();
  return usePricingMutation((input: { id: string; label: string }) =>
    settings.renameRateCard(input.id, { label: input.label }),
  );
}

/** M6.2 — add a dated version. There is no "edit these rates" counterpart. */
export function useIssueSchedule() {
  const { settings } = useServices();
  return usePricingMutation((input: { id: string; schedule: RateScheduleCreate }) =>
    settings.issueSchedule(input.id, input.schedule),
  );
}

export function useDeleteRateCard() {
  const { settings } = useServices();
  return usePricingMutation((id: string) => settings.deleteRateCard(id));
}

export function useCreateAdditionalService() {
  const { settings } = useServices();
  return usePricingMutation((input: AdditionalServiceCreate) =>
    settings.createAdditionalService(input),
  );
}

export function useUpdateAdditionalService() {
  const { settings } = useServices();
  return usePricingMutation((input: { code: string; patch: AdditionalServiceUpdate }) =>
    settings.updateAdditionalService(input.code, input.patch),
  );
}

export function useDeleteAdditionalService() {
  const { settings } = useServices();
  return usePricingMutation((code: string) => settings.deleteAdditionalService(code));
}

/* ── Invoice templates (M7.5) ────────────────────────────────────────────── */

export function useCreateInvoiceTemplate() {
  const { settings } = useServices();
  return useSettingsMutation((input: InvoiceTemplateWrite) =>
    settings.createInvoiceTemplate(input),
  );
}

export function useUpdateInvoiceTemplate() {
  const { settings } = useServices();
  return useSettingsMutation((input: { id: string; body: InvoiceTemplateWrite }) =>
    settings.updateInvoiceTemplate(input.id, input.body),
  );
}

export function useDeleteInvoiceTemplate() {
  const { settings } = useServices();
  return useSettingsMutation((id: string) => settings.deleteInvoiceTemplate(id));
}
