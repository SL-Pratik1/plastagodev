import { useMemo } from 'react';
import { useUserList } from '@/features/users/queries';
import type { LookupOption } from '@/services/types';

/**
 * Staff options for the audit log's "who" filter.
 *
 * Built from the users domain rather than from the audit entries themselves.
 * Deriving the filter from the visible page would offer only the people who
 * happen to appear on it — so filtering by someone would be impossible until you
 * had already found them, which defeats the point of the filter.
 *
 * Customers and drivers are excluded: they do not act in the console, so listing
 * them would pad the dropdown with options that can never match.
 */
export function useUserOptionsFromAudit(): LookupOption[] {
  const { data } = useUserList({ page: 1, pageSize: 100, sort: 'name' });

  return useMemo(
    () =>
      (data?.data ?? [])
        .filter((user) => !user.role.startsWith('customer-') && user.role !== 'driver')
        .map((user) => ({ value: user.id, label: user.name })),
    [data],
  );
}
