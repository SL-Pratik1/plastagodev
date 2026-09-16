import { JOB_STATUS_LABELS, JOB_STATUSES, type JobListItem } from '@plastago/shared';
import { Badge, Card, Pagination, buttonVariants } from '@plastago/ui';
import { BriefcaseIcon, PlusIcon } from 'lucide-react';
import { Link } from 'react-router';
import type { ZoneOption } from '@/services/types';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn, FilterDefinition } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { JobInvoiceBadge, JobStatusBadge, UrgentBadge } from '@/components/domain-badges';
import { PageHeader } from '@/components/page-header';
import {
  useAccountOptions,
  useBuilderOptions,
  useDriverOptions,
  useZoneOptions,
} from '@/features/lookups/queries';
import { useJobList } from '@/features/jobs/queries';
import { useAuth } from '@/features/auth/auth-context';
import { formatDate, formatMoney } from '@/lib/format';

/**
 * Job list (M2.2 · F6) — their #2 daily screen.
 *
 * ── The filters are the ones they actually ask for ─────────────────────────
 * §M2.2's own example is *"show me every unallocated job with a ready date in
 * the next 3 days in the Newcastle zone"* — which is three filters at once, so
 * the bar carries status, driver (including an explicit "Unallocated"), zone and
 * a relative ready-date window. The date filter is phrased the way the question
 * is asked ("next 3 days", "overdue") rather than as two date pickers, because
 * nobody types 2026-08-28 when they mean tomorrow.
 *
 * All of it lives in the URL, so that exact view is a link someone can send.
 */
const FILTER_KEYS = [
  'status',
  'account',
  'builder',
  'driver',
  'zone',
  'readyWindow',
  'invoiceStatus',
  'risk',
] as const;

/**
 * The filter bar, with the loaded zones spliced into position.
 *
 * Inserted where the constant used to declare it — after Ready date, before
 * Invoice — rather than appended to the end. The order of a filter bar is a
 * design decision, and letting it depend on which lists happen to be loaded
 * would move controls around under somebody's cursor. Same reasoning, same
 * shape, as `customers.tsx:filtersWith`.
 *
 * ⚠️ Archived zones are OFFERED here, unlike on a form. This grid is mostly
 * history: work booked in a zone the office has since retired is exactly what
 * somebody filtering by zone is looking for.
 */
function filtersWithZones(zones: readonly ZoneOption[]): FilterDefinition[] {
  const zoneFilter: FilterDefinition = {
    key: 'zoneId',
    label: 'Zone',
    allLabel: 'All zones',
    options: zones.map((zone) => ({
      value: zone.value,
      label: zone.archived ? `${zone.label} (retired)` : zone.label,
    })),
  };

  const index = STATIC_FILTERS.findIndex((filter) => filter.key === 'invoiceStatus');
  return [...STATIC_FILTERS.slice(0, index), zoneFilter, ...STATIC_FILTERS.slice(index)];
}

const STATIC_FILTERS: readonly FilterDefinition[] = [
  {
    key: 'status',
    label: 'Status',
    allLabel: 'All statuses',
    options: JOB_STATUSES.map((status) => ({ value: status, label: JOB_STATUS_LABELS[status] })),
  },
  {
    key: 'readyWindow',
    label: 'Ready date',
    allLabel: 'Any ready date',
    options: [
      { value: 'overdue', label: 'Overdue' },
      { value: 'today', label: 'Today' },
      { value: 'next-3', label: 'Next 3 days' },
      { value: 'next-7', label: 'Next 7 days' },
      { value: 'last-7', label: 'Last 7 days' },
      { value: 'last-30', label: 'Last 30 days' },
    ],
  },
  {
    key: 'invoiceStatus',
    label: 'Invoice',
    allLabel: 'Any invoice state',
    options: [
      { value: 'not-invoiced', label: 'Not invoiced' },
      { value: 'awaiting-po', label: 'Awaiting PO' },
      { value: 'invoiced', label: 'Invoiced' },
      { value: 'paid', label: 'Paid' },
    ],
  },
  {
    key: 'risk',
    label: 'Risk',
    allLabel: 'All jobs',
    options: [{ value: 'at-risk', label: 'At risk only' }],
  },
];

const COLUMNS: readonly DataTableColumn<JobListItem>[] = [
  {
    id: 'jobNumber',
    header: 'Job',
    sortKey: 'jobNumber',
    priority: 'primary',
    className: 'w-28',
    cell: (row) => (
      <span className="flex items-center gap-2">
        <span className="font-mono font-medium">#{row.jobNumber}</span>
        {row.serviceLevel === 'urgent' && <UrgentBadge />}
      </span>
    ),
  },
  {
    id: 'account',
    header: 'Account / builder',
    sortKey: 'accountName',
    priority: 'detail',
    cell: (row) => (
      <span className="block">
        <span className="font-medium">{row.accountName}</span>
        {/* M1.2 — the builder on site is not the party being invoiced. */}
        <span className="block text-xs text-muted-foreground">{row.builderName}</span>
      </span>
    ),
  },
  {
    /*
     * How the job reached us, and from whom.
     *
     * The office side of Matt's "booked by" column (18:15). The SOURCE is the
     * useful half here: a call-up email that failed and had to be booked by hand
     * is the pattern worth spotting, and it is invisible if only the name shows.
     */
    id: 'bookedBy',
    header: 'Booked by',
    sortKey: 'bookedByName',
    priority: 'detail',
    cell: (row) =>
      row.bookedByName === null ? (
        <span className="text-xs text-muted-foreground">—</span>
      ) : (
        <span className="block min-w-0">
          <span className="block truncate text-sm">{row.bookedByName}</span>
          <span className="block text-xs text-muted-foreground">
            {row.bookedBySource === 'portal'
              ? 'Portal'
              : row.bookedBySource === 'call-up'
                ? 'Call-up email'
                : 'Office'}
          </span>
        </span>
      ),
  },
  {
    id: 'site',
    header: 'Site',
    sortKey: 'siteName',
    priority: 'detail',
    cell: (row) => (
      <span className="block">
        <span>{row.siteName}</span>
        <span className="block text-xs text-muted-foreground">
          {row.suburb} · {row.zoneLabel}
        </span>
      </span>
    ),
  },
  {
    id: 'status',
    header: 'Status',
    sortKey: 'status',
    priority: 'secondary',
    cell: (row) => <JobStatusBadge status={row.status} />,
  },
  {
    id: 'readyDate',
    header: 'Ready / target',
    sortKey: 'readyDate',
    priority: 'detail',
    cell: (row) => (
      <span className="block">
        <span className="tabular-nums">{formatDate(row.readyDate)}</span>
        <span className="block text-xs text-muted-foreground tabular-nums">
          target {formatDate(row.targetDate)}
        </span>
      </span>
    ),
  },
  {
    id: 'driverName',
    header: 'Driver',
    sortKey: 'driverName',
    priority: 'detail',
    cell: (row) =>
      row.driverName === null ? (
        <Badge variant="outline">Unallocated</Badge>
      ) : (
        <span className="text-muted-foreground">{row.driverName}</span>
      ),
  },
  {
    id: 'expectedAreaM2',
    header: 'm²',
    sortKey: 'expectedAreaM2',
    numeric: true,
    priority: 'detail',
    className: 'w-20',
    cell: (row) => row.expectedAreaM2?.toLocaleString('en-AU') ?? '—',
  },
  {
    id: 'totalExGst',
    header: 'Total ex GST',
    sortKey: 'totalExGst',
    numeric: true,
    priority: 'detail',
    cell: (row) => formatMoney(row.totalExGst),
  },
  {
    id: 'invoiceStatus',
    header: 'Invoice',
    priority: 'secondary',
    cell: (row) => (
      <span className="flex flex-wrap items-center gap-1">
        <JobInvoiceBadge status={row.invoiceStatus} />
        {row.hasPendingCharges && <Badge variant="warning">Charges pending</Badge>}
      </span>
    ),
  },
];

export function AdminJobsPage() {
  const { can } = useAuth();
  const controller = useListQuery({ filterKeys: FILTER_KEYS, defaultSort: '-jobNumber' });
  const { data, error, isPending, isFetching, refetch } = useJobList(controller.query);

  /*
   * ── The Allocator's grid has no money in it (M1.5) ────────────────────────
   * Filtered from the shared column list rather than defined twice, so a new
   * column added below is automatically covered by the same rule — the failure
   * mode of two column arrays is that one of them quietly grows a price.
   *
   * The `invoiceStatus` column survives: "not invoiced / awaiting PO" is a
   * workflow state, not an amount, and it is how the office knows whether a job
   * is finished with. Only the amount goes.
   */
  const columns = can('pricing:view')
    ? COLUMNS
    : COLUMNS.filter((column) => column.id !== 'totalExGst');

  const accounts = useAccountOptions();
  const builders = useBuilderOptions();
  const drivers = useDriverOptions();

  /*
   * ⚠️ Falls back to an empty list rather than gating the grid on a spinner.
   *
   * The zone filter renders with only "All zones" until the register lands,
   * exactly as the Account and Driver filters beside it already do. One request
   * per session — the reference cache holds it for an hour — so this is a
   * first-paint concern on one screen, not a recurring one.
   */
  const zones = useZoneOptions().data ?? [];


  const filters: readonly FilterDefinition[] = [
    ...filtersWithZones(zones),
    {
      key: 'account',
      label: 'Account',
      allLabel: 'All accounts',
      options: accounts.data ?? [],
    },
    {
      key: 'builder',
      label: 'Builder',
      allLabel: 'All builders',
      options: builders.data ?? [],
    },
    {
      key: 'driver',
      label: 'Driver',
      allLabel: 'All drivers',
      // "Unallocated" belongs with the drivers, because that is where the eye
      // goes when the question is "who has this?".
      options: [{ value: 'unallocated', label: 'Unallocated' }, ...(drivers.data ?? [])],
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Jobs"
        description="Every pickup, past and future. Filter to the question you are asking and the URL keeps it."
        actions={
          can('jobs:create') ? (
            <Link to="/admin/jobs/new" className={buttonVariants()}>
              <PlusIcon aria-hidden />
              Create job
            </Link>
          ) : undefined
        }
      />

      <Card className="overflow-hidden p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search job number, account, site, reference or PO…"
          filters={filters}
        />

        <DataTable
          caption="Jobs"
          columns={columns}
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
          rowHref={(row) => `/admin/jobs/${row.id}`}
          empty={{
            icon: BriefcaseIcon,
            title: 'No jobs yet',
            description: 'Create the first job, or wait for a customer to book one.',
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

      <p className="text-xs text-muted-foreground">
        Job numbers continue the existing sequence — three years of consignment numbers are quoted
        in builders’ accounts-payable systems, so they never restart.
      </p>
    </div>
  );
}
