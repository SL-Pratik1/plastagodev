import type { AccountDraft, AccountType, AccountUpdate } from '@plastago/shared';
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
 * Correct an account’s details.
 *
 * ── Why the lookups go stale too ──────────────────────────────────────────
 * The company name is on this form, and the account pickers on job creation and
 * the booking screens cache it. An account renamed here and still listed under
 * its old name in a dropdown is the same record disagreeing with itself on two
 * screens at once.
 */
export function useUpdateCustomer(accountId: string | undefined) {
  const { customers } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: AccountUpdate) => customers.update(accountId ?? '', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.all });
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
/**
 * M7.5 — point this account at an invoice template, or back at its brand.
 *
 * Invalidates the customers tree so the detail page's "Invoice template" row
 * re-reads. Nothing else depends on it: the choice reaches an invoice only when
 * one is rendered.
 */
export function useSetInvoiceTemplate(accountId: string | undefined) {
  const { customers } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (invoiceTemplateId: string | null) =>
      customers.setInvoiceTemplate(accountId ?? '', invoiceTemplateId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.all });
    },
  });
}

export function useSetRiskAssessmentRequired(accountId: string | undefined) {
  const { customers } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (required: boolean) =>
      customers.setRiskAssessmentRequired(accountId ?? '', required),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.all });
      // The server carries the rule onto the account's open jobs, so any job
      // screen already loaded (its Compliance tab, its timeline) is now stale.
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
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
