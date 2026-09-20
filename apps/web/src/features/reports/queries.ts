import type { ReportFilters } from '@plastago/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { useServices } from '@/services/services-context';
import type { ListQuery } from '@/services/types';

/**
 * Reports are expensive and rarely change within a session, so they cache for
 * five minutes and are keyed on their full filter set. `enabled` gates each one
 * on its tab being open — running all four on mount would make the first paint
 * four times slower for no benefit.
 */
const REPORT_CACHE = { staleTime: 5 * 60 * 1000 } as const;

export function useMonthlyVolumeReport(filters: ReportFilters, enabled: boolean) {
  const { reports } = useServices();
  return useQuery({
    queryKey: queryKeys.reports.monthlyVolume(filters),
    queryFn: () => reports.monthlyVolume(filters),
    enabled,
    ...REPORT_CACHE,
  });
}

export function useZoneVolumeReport(filters: ReportFilters, enabled: boolean) {
  const { reports } = useServices();
  return useQuery({
    queryKey: queryKeys.reports.zoneVolume(filters),
    queryFn: () => reports.zoneVolume(filters),
    enabled,
    ...REPORT_CACHE,
  });
}

export function useFinancialReport(filters: ReportFilters, enabled: boolean) {
  const { reports } = useServices();
  return useQuery({
    queryKey: queryKeys.reports.financial(filters),
    queryFn: () => reports.financial(filters),
    enabled,
    ...REPORT_CACHE,
  });
}

export function useCertificates(query: ListQuery, enabled: boolean) {
  const { reports } = useServices();
  return useQuery({
    queryKey: queryKeys.reports.certificates(query),
    queryFn: () => reports.certificates(query),
    enabled,
    placeholderData: (previous) => previous,
  });
}

export function useIssueCertificate() {
  const { reports } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => reports.issueCertificate(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.reports.all }),
  });
}

/**
 * The office's own preview of the document.
 *
 * Not invalidating anything: minting a link changes nothing about the
 * certificate, and a refetch here would only flicker the table.
 */
export function useCertificatePdf() {
  const { reports } = useServices();
  return useMutation({ mutationFn: (id: string) => reports.certificatePdf(id) });
}

export function useResendCertificate() {
  const { reports } = useServices();
  return useMutation({ mutationFn: (id: string) => reports.resendCertificate(id) });
}
