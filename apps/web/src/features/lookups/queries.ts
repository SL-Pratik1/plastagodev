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

/**
 * Address lookup (Matt, 7:25).
 *
 * Keyed by the query so each distinct set of keystrokes is cached separately —
 * backspacing then retyping the same thing hits the cache rather than the
 * service. The same long cache applies: the list of suburbs PlastaGo services
 * does not change while somebody fills in a form.
 */
export function usePlaceOptions(query: string) {
  const { lookups } = useServices();
  return useQuery({
    queryKey: queryKeys.lookups.places(query),
    queryFn: () => lookups.places(query),
    ...REFERENCE_CACHE,
  });
}
