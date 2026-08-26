import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { useServices } from '@/services/services-context';

/**
 * The operations dashboard.
 *
 * Refetched on an interval because this screen is left open all day and its
 * whole purpose is to show what needs a decision *now* — a queue count from two
 * hours ago is worse than useless, because it looks current.
 */
export function useDashboardSummary() {
  const { dashboard } = useServices();

  return useQuery({
    queryKey: queryKeys.dashboard.summary(),
    queryFn: () => dashboard.summary(),
    refetchInterval: 60_000,
    placeholderData: (previous) => previous,
  });
}
