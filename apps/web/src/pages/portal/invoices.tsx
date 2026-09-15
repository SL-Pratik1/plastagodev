import type { PortalInvoice } from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  Pagination,
  Spinner,
  useToast,
  type BadgeProps,
} from '@plastago/ui';
import { DownloadIcon, ReceiptIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn, FilterDefinition } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { StatCard } from '@/components/stat-card';
import {
  usePortalInvoicePdf,
  usePortalInvoices,
  usePortalScope,
} from '@/features/portal/queries';
import { useInvoiceDownloads } from '@/features/invoices/use-invoice-downloads';
import { describeError } from '@/lib/error-message';
import { formatDate, formatInvoiceNumber, formatMoney } from '@/lib/format';

/**
 * Invoices (M5.10 · F8, W72, W73) — Customer Administrator only.
 *
 * ── Why the PO and the job reference are columns, not details ─────────────
 * Because this screen is used to answer an accounts-payable query: *"what is
 * invoice 104071 for and which PO does it sit under?"* Today that question is a
 * phone call to the office. Putting both on the row means the answer is on the
 * screen the moment it loads.
 *
 * ── No payment button, and that is correct ────────────────────────────────
 * Stripe (I4) was dropped by the client: payment is 7-day EFT against a PO.
 * A "Pay now" button would be a feature nobody asked for and a reconciliation
 * problem for a business that banks against remittance advice.
 */
const FILTER_KEYS = ['status', 'kind'] as const;

const STATUS_LABELS: Record<PortalInvoice['status'], string> = {
  'awaiting-po': 'Awaiting your PO',
  sent: 'Outstanding',
  overdue: 'Overdue',
  paid: 'Paid',
};

const STATUS_VARIANT: Record<PortalInvoice['status'], BadgeProps['variant']> = {
  'awaiting-po': 'warning',
  sent: 'secondary',
  overdue: 'destructive',
  paid: 'success',
};

const STATIC_FILTERS: readonly FilterDefinition[] = [
  {
    key: 'status',
    label: 'Status',
    allLabel: 'All invoices',
    options: [
      { value: 'outstanding', label: 'Outstanding' },
      { value: 'overdue', label: 'Overdue' },
      { value: 'awaiting-po', label: 'Awaiting your PO' },
      { value: 'paid', label: 'Paid' },
    ],
  },
  {
    key: 'kind',
    label: 'Type',
    allLabel: 'All types',
    options: [
      { value: 'base', label: 'Pickup' },
      { value: 'additional-charges', label: 'Additional charges' },
    ],
  },
];

function columns(prefix: string): readonly DataTableColumn<PortalInvoice>[] {
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
        <span className="block text-xs text-muted-foreground">
          {row.kind === 'base' ? 'Pickup' : 'Additional charges'}
        </span>
      </span>
    ),
  },
  {
    id: 'status',
    header: 'Status',
    priority: 'secondary',
    cell: (row) => <Badge variant={STATUS_VARIANT[row.status]}>{STATUS_LABELS[row.status]}</Badge>,
  },
  {
    id: 'siteName',
    header: 'Site',
    priority: 'detail',
    cell: (row) => (
      <span className="block">
        <span className="block truncate">{row.siteName ?? '—'}</span>
        {row.jobId !== null && (
          <Link
            to={`/portal/jobs/${row.jobId}`}
            className="focus-ring rounded font-mono text-xs text-primary underline-offset-4 hover:underline"
          >
            pickup #{row.jobNumber}
          </Link>
        )}
      </span>
    ),
  },
  {
    id: 'poNumber',
    header: 'Your PO',
    priority: 'detail',
    cell: (row) =>
      row.poNumber ? (
        <span className="font-mono text-xs">{row.poNumber}</span>
      ) : (
        <Badge variant="outline">None</Badge>
      ),
  },
  {
    id: 'poNumber',
    header: 'PO / job reference',
    priority: 'detail',
    cell: (row) => row.poNumber ?? <span className="text-muted-foreground">—</span>,
  },
  {
    id: 'issuedOn',
    header: 'Issued / due',
    sortKey: 'issuedOn',
    priority: 'detail',
    cell: (row) => (
      <span className="block">
        <span className="tabular-nums">{formatDate(row.issuedOn, 'Not yet issued')}</span>
        {row.dueOn !== null && (
          <span className="block text-xs text-muted-foreground tabular-nums">
            due {formatDate(row.dueOn)}
          </span>
        )}
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

export function PortalInvoicesPage() {
  const toast = useToast();
  const controller = useListQuery({ filterKeys: FILTER_KEYS, defaultPageSize: 20 });
  const { data, error, isPending, isFetching, refetch } = usePortalInvoices(controller.query);
  const requestPdf = usePortalInvoicePdf();
  const downloads = useInvoiceDownloads();
  // Carried on the scope: the portal cannot read office settings, but the
  // customer has to quote the same number back when they pay.
  const prefix = usePortalScope().data?.invoiceNumberPrefix ?? '';

  const [selected, setSelected] = useState<string[]>([]);

  const rows = data?.data ?? [];
  const outstanding = rows.filter((row) => row.status === 'sent' || row.status === 'overdue');
  const overdue = rows.filter((row) => row.status === 'overdue');
  const cents = (list: readonly PortalInvoice[]) =>
    list.reduce((sum, row) => sum + Math.round(Number(row.totalIncGst) * 100), 0);

  const download = async () => {
    // Reserved before the await — see `useInvoiceDownloads`.
    const deliver = downloads.begin();

    try {
      const summary = deliver(await requestPdf.mutateAsync(selected));

      if (summary.delivered === 0) {
        /*
         * Deliberately not the office's wording. A customer cannot act on
         * "no invoice template is configured", so they are told who can.
         */
        toast.error(
          'Those invoices could not be prepared',
          'Please contact PlastaGo and we will send them to you.',
        );
        return;
      }

      setSelected([]);
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-display text-xl font-semibold tracking-tight">Invoices</h1>
        <p className="text-sm text-muted-foreground">
          Every invoice with its purchase order and the pickup it belongs to. Download any of them
          as a PDF.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          label="Outstanding"
          value={formatMoney((cents(outstanding) / 100).toFixed(2))}
          hint={`${String(outstanding.length)} invoice${outstanding.length === 1 ? '' : 's'} on this page`}
          isPending={isPending}
        />
        <StatCard
          label="Overdue"
          value={formatMoney((cents(overdue) / 100).toFixed(2))}
          hint="Past 7-day terms"
          tone={overdue.length > 0 ? 'alert' : 'default'}
          isPending={isPending}
        />
        <StatCard
          label="Payment terms"
          value="7 days"
          hint="EFT against your purchase order"
          isPending={isPending}
        />
      </div>

      <Card className="overflow-hidden p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search invoice number, PO, reference or site…"
          filters={STATIC_FILTERS}
          actions={
            selected.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                {requestPdf.isPending && <Spinner label="Preparing" />}
                <span className="text-xs text-muted-foreground">{selected.length} selected</span>
                <Button size="sm" disabled={requestPdf.isPending} onClick={() => void download()}>
                  <DownloadIcon aria-hidden />
                  Download PDFs
                </Button>
              </div>
            ) : undefined
          }
        />

        <DataTable
          caption="Your invoices"
          columns={columns(prefix)}
          rows={rows}
          getRowId={(row) => row.id}
          isPending={isPending}
          isFetching={isFetching && !isPending}
          error={error}
          onRetry={() => void refetch()}
          sort={controller.sort}
          onToggleSort={controller.toggleSort}
          isFiltered={controller.isFiltered}
          onClearFilters={controller.clearFilters}
          selectedIds={selected}
          onSelectionChange={setSelected}
          empty={{
            icon: ReceiptIcon,
            title: 'No invoices yet',
            description: 'Invoices are issued when a pickup is completed.',
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

      <Alert variant="info" title="Why some pickups have two invoices">
        The pickup itself is invoiced on completion against your original purchase order. Anything
        raised on site afterwards — contamination, extra load time — needs its own PO, so it is
        invoiced separately. That way the first invoice is never held up waiting for a second
        approval.
      </Alert>

      {downloads.dialog}
    </div>
  );
}
