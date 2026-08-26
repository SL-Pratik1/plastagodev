import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { useServices } from '@/services/services-context';

/**
 * Reference lists for pickers and filters.
 *
 * Cached for an hour and never refetched on mount: the account list does not
 * change while someone fills in a form, and re-requesting it every time a filter
 * bar renders is pure waste. This is the one place a long `staleTime` is
 * unambiguously right.
 */
const REFERENCE_CACHE = { staleTime: 60 * 60 * 1000, gcTime: 60 * 60 * 1000 } as const;

export function useAccountOptions() {
  const { lookups } = useServices();
  return useQuery({
    queryKey: queryKeys.lookups.accounts(),
    queryFn: () => lookups.accounts(),
    ...REFERENCE_CACHE,
  });
}

export function useBuilderOptions() {
  const { lookups } = useServices();
  return useQuery({
    queryKey: queryKeys.lookups.builders(),
    queryFn: () => lookups.builders(),
    ...REFERENCE_CACHE,
  });
}

export function useDriverOptions() {
  const { lookups } = useServices();
  return useQuery({
    queryKey: queryKeys.lookups.drivers(),
    queryFn: () => lookups.drivers(),
    ...REFERENCE_CACHE,
  });
}

/** Sites for one account. Disabled until an account is chosen. */
export function useSiteOptions(accountId: string | null) {
  const { lookups } = useServices();
  return useQuery({
    queryKey: queryKeys.lookups.sites(accountId ?? 'none'),
    queryFn: () => lookups.sitesForAccount(accountId ?? ''),
    enabled: accountId !== null && accountId !== '',
    ...REFERENCE_CACHE,
  });
}
