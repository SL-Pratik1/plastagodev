import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { useServices } from '@/services/services-context';
import type { ListQuery } from '@/services/types';

/**
 * The audit log (M1.6). Read-only — the collection is append-only, so there are
 * no mutations to write here and none should ever be added.
 */
export function useAuditList(query: ListQuery) {
  const { audit } = useServices();
  return useQuery({
    queryKey: queryKeys.audit.list(query),
    queryFn: () => audit.list(query),
    placeholderData: (previous) => previous,
  });
}

export function useAuditEntry(id: string | null) {
  const { audit } = useServices();
  return useQuery({
    queryKey: queryKeys.audit.detail(id ?? 'none'),
    queryFn: () => audit.get(id ?? ''),
    enabled: id !== null,
  });
}
