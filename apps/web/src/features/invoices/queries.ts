import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { useServices } from '@/services/services-context';
import type { ListQuery } from '@/services/types';

export function useInvoiceList(query: ListQuery) {
  const { invoices } = useServices();
  return useQuery({
    queryKey: queryKeys.invoices.list(query),
    queryFn: () => invoices.list(query),
    placeholderData: (previous) => previous,
  });
}

export function useInvoice(id: string | undefined) {
  const { invoices } = useServices();
  return useQuery({
    queryKey: queryKeys.invoices.detail(id ?? 'none'),
    queryFn: () => invoices.get(id ?? ''),
    enabled: Boolean(id),
  });
}

/**
 * Invoice mutations invalidate four domains, because an invoice is never only
 * an invoice.
 *
 * The awaiting-PO **queue**, the dashboard **tile** and the invoice **row** are
 * three views of one fact (M7.3, M9.4). Recording the PO that releases an
 * invoice has to empty the queue row and shrink the nav badge — invalidating
 * only `invoices` left the row sitting there with a PO printed beside it, which
 * is exactly how a queue stops being trusted.
 */
function useInvoiceMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: () => {
      for (const queryKey of [
        queryKeys.invoices.all,
        queryKeys.queues.all,
        queryKeys.jobs.all,
        queryKeys.dashboard.all,
        queryKeys.notifications.all,
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}

export function useSendInvoices() {
  const { invoices } = useServices();
  return useInvoiceMutation((ids: readonly string[]) => invoices.send(ids));
}

export function useApproveInvoices() {
  const { invoices } = useServices();
  return useInvoiceMutation((ids: readonly string[]) => invoices.approve(ids));
}

export function useRecordPo() {
  const { invoices } = useServices();
  return useInvoiceMutation(({ id, poNumber }: { id: string; poNumber: string }) =>
    invoices.recordPo(id, poNumber),
  );
}

export function useRetryXero() {
  const { invoices } = useServices();
  return useInvoiceMutation((id: string) => invoices.retryXero(id));
}

/**
 * A PDF request changes nothing, so it does not invalidate anything — the
 * rendering happens server-side and the file arrives by another route (§6A.6).
 */
export function useRequestInvoicePdf() {
  const { invoices } = useServices();
  return useMutation({ mutationFn: (ids: readonly string[]) => invoices.requestPdf(ids) });
}
