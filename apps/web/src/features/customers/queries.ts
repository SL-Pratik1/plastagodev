import type { AccountDraft, AccountType } from '@plastago/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
/** Create an account directly — no lead (Matt, 6:10). */
export function useCreateCustomer() {
  const { customers } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (draft: AccountDraft) => customers.create(draft),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.all });
      // The account picker on job creation is one of these.
      void queryClient.invalidateQueries({ queryKey: queryKeys.lookups.all });
    },
  });
}

/**
 * Move an account between the two journeys — builder or contractor.
 *
 * ── Why the lookups go stale too ──────────────────────────────────────────
 * The type decides which booking form the customer sees and whether they have
 * site supervisors, so it is not only this page that is now wrong: the account
 * pickers cache the same rows. Invalidating both is cheaper than a stale
 * contractor sitting in a dropdown with a builder's form behind it.
 */
export function useSetAccountType(accountId: string | undefined) {
  const { customers } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (accountType: AccountType) =>
      customers.setAccountType(accountId ?? '', accountType),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.lookups.all });
    },
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

/**
 * M4.8b — turn the Site Risk Assessment requirement on or off for an account.
 *
 * ── Why this invalidates the SITES list as well as the account ────────────
 * The sites grid shows each site's EFFECTIVE answer, which is the account's
 * rule unless that site overrides it. Flipping the account therefore changes
 * every inheriting row — and leaving them stale would show a grid that
 * contradicts the switch immediately above it.
 */
export function useSetRiskAssessmentRequired(accountId: string | undefined) {
  const { customers } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (required: boolean) =>
      customers.setRiskAssessmentRequired(accountId ?? '', required),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.all });
    },
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
