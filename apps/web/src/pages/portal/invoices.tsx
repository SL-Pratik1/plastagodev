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
import { usePortalInvoicePdf, usePortalInvoices } from '@/features/portal/queries';
import { describeError } from '@/lib/error-message';
import { formatDate, formatMoney } from '@/lib/format';

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

const COLUMNS: readonly DataTableColumn<PortalInvoice>[] = [
  {
    id: 'invoiceNumber',
    header: 'Invoice',
    sortKey: 'invoiceNumber',
    priority: 'primary',
    cell: (row) => (
      <span className="block">
        <span className="font-mono font-medium">#{row.invoiceNumber}</span>
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
    id: 'reference',
    header: 'Your reference',
    priority: 'detail',
    cell: (row) => row.reference ?? <span className="text-muted-foreground">—</span>,
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

export function PortalInvoicesPage() {
  const toast = useToast();
  const controller = useListQuery({ filterKeys: FILTER_KEYS, defaultPageSize: 25 });
  const { data, error, isPending, isFetching, refetch } = usePortalInvoices(controller.query);
  const requestPdf = usePortalInvoicePdf();

  const [selected, setSelected] = useState<string[]>([]);

  const rows = data?.data ?? [];
  const outstanding = rows.filter((row) => row.status === 'sent' || row.status === 'overdue');
  const overdue = rows.filter((row) => row.status === 'overdue');
  const cents = (list: readonly PortalInvoice[]) =>
    list.reduce((sum, row) => sum + Math.round(Number(row.totalIncGst) * 100), 0);

  const download = async () => {
    try {
      await requestPdf.mutateAsync(selected);
      toast.success(
        `${String(selected.length)} PDF${selected.length === 1 ? '' : 's'} on the way`,
        'They will appear in your downloads shortly.',
      );
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

      <div className="grid gap-3 sm:grid-cols-3">
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
          columns={COLUMNS}
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
    </div>
  );
}
