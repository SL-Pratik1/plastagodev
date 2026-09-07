import {
  INVOICE_KIND_LABELS,
  INVOICE_STATUS_LABELS,
  INVOICE_STATUSES,
  type InvoiceListItem,
} from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Pagination,
  Spinner,
  useToast,
} from '@plastago/ui';
import { FileTextIcon, ReceiptIcon, SendIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn, FilterDefinition } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { InvoiceStatusBadge } from '@/components/domain-badges';
import { PageHeader } from '@/components/page-header';
import {
  useApproveInvoices,
  useInvoiceList,
  useRequestInvoicePdf,
  useSendInvoices,
} from '@/features/invoices/queries';
import { useAccountOptions } from '@/features/lookups/queries';
import { useSettings } from '@/features/settings/queries';
import { describeError } from '@/lib/error-message';
import { formatDate, formatInvoiceNumber, formatMoney } from '@/lib/format';

/**
 * Invoice list (M7.7).
 *
 * ── The bulk actions are exactly the documented ones ───────────────────────
 * M7.7 says "bulk approve, bulk send"; M7.6 says "PDF individually and in bulk".
 * That is the whole set. There is no Stripe or card capture — I4 was dropped by
 * the client because payment is 7-day EFT against a PO — and no credit notes or
 * part-payments, which are v1.1.
 *
 * ── Two filters that look like one ────────────────────────────────────────
 * **Invoice state** is where it sits in the workflow (draft, awaiting PO, sent).
 * **Payment status** is whether the money arrived. They are different questions
 * asked by different people, so they are separate controls — and "Unknown" is a
 * real payment status, because their current list genuinely shows it where the
 * Xero sync is only partly working.
 */
const FILTER_KEYS = ['account', 'status', 'payment', 'kind', 'issuedWindow'] as const;

const STATIC_FILTERS: readonly FilterDefinition[] = [
  {
    key: 'status',
    label: 'Invoice state',
    allLabel: 'Any state',
    options: INVOICE_STATUSES.map((status) => ({
      value: status,
      label: INVOICE_STATUS_LABELS[status],
    })),
  },
  {
    key: 'payment',
    label: 'Payment',
    allLabel: 'Any payment status',
    options: [
      { value: 'outstanding', label: 'Outstanding' },
      { value: 'overdue', label: 'Overdue' },
      { value: 'paid', label: 'Paid' },
      { value: 'unknown', label: 'Unknown' },
    ],
  },
  {
    key: 'kind',
    label: 'Kind',
    allLabel: 'Base and additional',
    options: [
      { value: 'base', label: 'Base invoice' },
      { value: 'additional-charges', label: 'Additional charges' },
    ],
  },
  {
    key: 'issuedWindow',
    label: 'Issued',
    allLabel: 'Any date',
    options: [
      { value: 'this-month', label: 'This month' },
      { value: 'last-7', label: 'Last 7 days' },
      { value: 'last-30', label: 'Last 30 days' },
      { value: 'last-90', label: 'Last 90 days' },
      { value: 'unissued', label: 'Not yet issued' },
    ],
  },
];

function columns(prefix: string): readonly DataTableColumn<InvoiceListItem>[] {
  return [
  {
    id: 'invoiceNumber',
    header: 'Invoice',
    sortKey: 'invoiceNumber',
    priority: 'primary',
    cell: (row) => (
      <span className="block">
        <span className="font-mono font-medium">
          {formatInvoiceNumber(row.invoiceNumber, prefix)}
        </span>
        <span className="block text-xs text-muted-foreground">{INVOICE_KIND_LABELS[row.kind]}</span>
      </span>
    ),
  },
  {
    id: 'accountName',
    header: 'Customer',
    sortKey: 'accountName',
    priority: 'detail',
    cell: (row) => row.accountName,
  },
  {
    id: 'status',
    header: 'State',
    sortKey: 'status',
    priority: 'secondary',
    cell: (row) => <InvoiceStatusBadge status={row.status} />,
  },
  {
    id: 'jobNumber',
    header: 'Job',
    priority: 'detail',
    cell: (row) =>
      row.jobId ? (
        <Link
          to={`/admin/jobs/${row.jobId}`}
          className="focus-ring rounded font-mono text-primary underline-offset-4 hover:underline"
        >
          #{row.jobNumber}
        </Link>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    id: 'poNumber',
    header: 'PO',
    priority: 'detail',
    cell: (row) =>
      row.poNumber ? (
        <span className="font-mono text-xs">{row.poNumber}</span>
      ) : (
        <Badge variant="outline">None</Badge>
      ),
  },
  {
    id: 'issuedOn',
    header: 'Issued / due',
    sortKey: 'issuedOn',
    priority: 'detail',
    cell: (row) => (
      <span className="block">
        <span className="tabular-nums">{formatDate(row.issuedOn)}</span>
        <span className="block text-xs text-muted-foreground tabular-nums">
          due {formatDate(row.dueOn)}
        </span>
      </span>
    ),
  },
  {
    id: 'totalIncGst',
    header: 'Total inc GST',
    sortKey: 'totalIncGst',
    numeric: true,
    priority: 'secondary',
    cell: (row) => formatMoney(row.totalIncGst),
    },
  ];
}

export function AdminInvoicesPage() {
  const toast = useToast();
  const controller = useListQuery({ filterKeys: FILTER_KEYS, defaultSort: '-invoiceNumber' });
  const { data, error, isPending, isFetching, refetch } = useInvoiceList(controller.query);
  const accounts = useAccountOptions();
  // Presentation only (Matt, 7:07). Empty until the office sets one.
  const prefix = useSettings().data?.invoicing.invoiceNumberPrefix ?? '';

  const [selected, setSelected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<'send' | 'approve' | null>(null);

  const sendInvoices = useSendInvoices();
  const approveInvoices = useApproveInvoices();
  const requestPdf = useRequestInvoicePdf();

  const filters: readonly FilterDefinition[] = [
    ...STATIC_FILTERS,
    { key: 'account', label: 'Customer', allLabel: 'All customers', options: accounts.data ?? [] },
  ];

  const run = async (action: 'send' | 'approve') => {
    try {
      const changed =
        action === 'send'
          ? await sendInvoices.mutateAsync(selected)
          : await approveInvoices.mutateAsync(selected);

      toast.success(
        action === 'send'
          ? `${String(changed)} invoice${changed === 1 ? '' : 's'} sent`
          : `${String(changed)} invoice${changed === 1 ? '' : 's'} approved`,
        action === 'send'
          ? 'Pushed to Xero and emailed to the account’s billing contact.'
          : 'Released from the awaiting-PO queue.',
      );
      setSelected([]);
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    } finally {
      setConfirm(null);
    }
  };

  const downloadPdfs = async () => {
    try {
      await requestPdf.mutateAsync(selected);
      toast.success(
        `${String(selected.length)} PDF${selected.length === 1 ? '' : 's'} queued`,
        'Rendered server-side; they will appear in your downloads shortly.',
      );
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const busy = sendInvoices.isPending || approveInvoices.isPending || requestPdf.isPending;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Invoices"
        description="One invoice per job on completion. Additional charges are invoiced separately once their own PO arrives."
      />

      <Card className="overflow-hidden p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search invoice number, customer, PO or job…"
          filters={filters}
          actions={
            selected.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                {busy && <Spinner label="Working" />}
                <span className="text-xs text-muted-foreground">
                  {selected.length} selected on this page
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setConfirm('approve');
                  }}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void downloadPdfs()}
                >
                  <FileTextIcon aria-hidden />
                  PDF
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setConfirm('send');
                  }}
                >
                  <SendIcon aria-hidden />
                  Send
                </Button>
              </div>
            ) : undefined
          }
        />

        <DataTable
          caption="Invoices"
          columns={columns(prefix)}
          rows={data?.data ?? []}
          getRowId={(row) => row.id}
          isPending={isPending}
          isFetching={isFetching && !isPending}
          error={error}
          onRetry={() => void refetch()}
          sort={controller.sort}
          onToggleSort={controller.toggleSort}
          isFiltered={controller.isFiltered}
          onClearFilters={controller.clearFilters}
          rowHref={(row) => `/admin/invoices/${row.id}`}
          selectedIds={selected}
          onSelectionChange={setSelected}
          // A paid invoice has nothing left to do in bulk, so it cannot be
          // selected — better than letting it be selected and then skipped.
          selectableRow={(row) => row.status !== 'paid'}
          empty={{
            icon: ReceiptIcon,
            title: 'No invoices yet',
            description: 'Invoices are generated when a job completes.',
          }}
        />

        {data && (
          <Pagination
            page={data.meta.page}
            pageSize={data.meta.pageSize}
            total={data.meta.total}
            onPageChange={controller.setPage}
            onPageSizeChange={controller.setPageSize}
            disabled={isFetching}
          />
        )}
      </Card>

      <Alert variant="info" title="Why there are two invoices per job sometimes">
        The base invoice goes out on completion against the original PO. Additional charges —
        contamination, extra load time — need their own PO, so they are invoiced separately once it
        arrives. Cash for the job itself is never held up waiting for a second approval.
      </Alert>

      <ConfirmDialog
        open={confirm !== null}
        onCancel={() => {
          setConfirm(null);
        }}
        onConfirm={() => {
          if (confirm) void run(confirm);
        }}
        title={
          confirm === 'send'
            ? `Send ${String(selected.length)} invoice${selected.length === 1 ? '' : 's'}?`
            : `Approve ${String(selected.length)} invoice${selected.length === 1 ? '' : 's'}?`
        }
        description={
          confirm === 'send'
            ? 'They will be pushed to Xero and emailed to each account’s billing contact. Sending cannot be undone.'
            : 'Approved invoices leave the awaiting-PO queue and become sendable. Anything still missing a PO will be skipped.'
        }
        confirmLabel={confirm === 'send' ? 'Send invoices' : 'Approve invoices'}
        pending={busy}
      />
    </div>
  );
}
