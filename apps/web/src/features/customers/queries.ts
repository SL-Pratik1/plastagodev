import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { useServices } from '@/services/services-context';
import type { ListQuery } from '@/services/types';

export function useCustomerList(query: ListQuery) {
  const { customers } = useServices();
  return useQuery({
    queryKey: queryKeys.customers.list(query),
    queryFn: () => customers.list(query),
    placeholderData: (previous) => previous,
  });
}

export function useCustomer(id: string | undefined) {
  const { customers } = useServices();
  return useQuery({
    queryKey: queryKeys.customers.detail(id ?? 'none'),
    queryFn: () => customers.get(id ?? ''),
    enabled: Boolean(id),
  });
}

/**
 * The detail page's tab data.
 *
 * Each tab is its own query, `enabled` only when that tab is open. Loading all
 * six on mount would make opening an account four times slower than it needs to
 * be for the one tab the user actually wanted.
 */
export function useCustomerSites(id: string | undefined, query: ListQuery, enabled: boolean) {
  const { customers } = useServices();
  return useQuery({
    queryKey: queryKeys.customers.sites(id ?? 'none', query),
    queryFn: () => customers.sites(id ?? '', query),
    enabled: Boolean(id) && enabled,
    placeholderData: (previous) => previous,
  });
}

export function useCustomerJobs(id: string | undefined, query: ListQuery, enabled: boolean) {
  const { customers } = useServices();
  return useQuery({
    queryKey: queryKeys.customers.jobs(id ?? 'none', query),
    queryFn: () => customers.jobs(id ?? '', query),
    enabled: Boolean(id) && enabled,
    placeholderData: (previous) => previous,
  });
}

export function useCustomerInvoices(id: string | undefined, query: ListQuery, enabled: boolean) {
  const { customers } = useServices();
  return useQuery({
    queryKey: queryKeys.customers.invoices(id ?? 'none', query),
    queryFn: () => customers.invoices(id ?? '', query),
    enabled: Boolean(id) && enabled,
    placeholderData: (previous) => previous,
  });
}
