import { EXPIRY_STATE_LABELS, type DriverListItem } from '@plastago/shared';
import { Alert, Badge, Card, Pagination } from '@plastago/ui';
import { IdCardIcon } from 'lucide-react';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn, FilterDefinition } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { ExpiryBadge } from '@/components/domain-badges';
import { PageHeader } from '@/components/page-header';
import { useDriverList } from '@/features/fleet/queries';
import { formatDate, formatMobile, formatRelative } from '@/lib/format';

/**
 * Drivers (M9.8 · F53).
 *
 * ── Sorted by what is expiring, not alphabetically ─────────────────────────
 * They already have this module in TransVirtual and do not maintain it, so
 * **the reminder is the feature, not the register**. Anything expired or inside
 * its reminder window floats to the top, and the expiry column is the one the
 * eye lands on.
 *
 * Chain of Responsibility under the HVNL makes licence currency an *operator*
 * obligation, not just the driver's — which is why this list belongs to the
 * office rather than to each driver.
 */
const FILTER_KEYS = ['status', 'expiry', 'vehicle'] as const;

const FILTERS: readonly FilterDefinition[] = [
  {
    key: 'status',
    label: 'Status',
    allLabel: 'All drivers',
    options: [
      { value: 'active', label: 'Active' },
      { value: 'inactive', label: 'Inactive' },
    ],
  },
  {
    key: 'expiry',
    label: 'Credentials',
    allLabel: 'Any credential state',
    options: [
      { value: 'expired', label: 'Expired' },
      { value: 'due-soon', label: 'Expiring within a month' },
      { value: 'valid', label: 'All valid' },
    ],
  },
  {
    key: 'vehicle',
    label: 'Vehicle',
    allLabel: 'Any vehicle',
    options: [
      { value: 'assigned', label: 'Has a vehicle' },
      { value: 'unassigned', label: 'No vehicle' },
    ],
  },
];

const COLUMNS: readonly DataTableColumn<DriverListItem>[] = [
  {
    id: 'name',
    header: 'Driver',
    sortKey: 'name',
    priority: 'primary',
    cell: (row) => (
      <span className="block">
        <span className="font-medium">{row.name}</span>
        <span className="block text-xs text-muted-foreground">{formatMobile(row.mobile)}</span>
      </span>
    ),
  },
  {
    id: 'status',
    header: 'Status',
    priority: 'secondary',
    cell: (row) => (
      <Badge variant={row.active ? 'success' : 'outline'}>
        {row.active ? 'Active' : 'Inactive'}
      </Badge>
    ),
  },
  {
    id: 'nextExpiry',
    header: 'Next expiry',
    sortKey: 'nextExpiryOn',
    priority: 'secondary',
    cell: (row) => (
      <span className="flex flex-col gap-1">
        <ExpiryBadge state={row.nextExpiryState} />
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatDate(row.nextExpiryOn)}
        </span>
      </span>
    ),
  },
  {
    id: 'vehicle',
    header: 'Vehicle',
    priority: 'detail',
    cell: (row) =>
      row.vehicleRego === null ? (
        <span className="text-muted-foreground">Unassigned</span>
      ) : (
        <span className="block">
          <span className="font-mono text-xs">{row.vehicleRego}</span>
          <span className="block text-xs text-muted-foreground">{row.vehicleLabel}</span>
        </span>
      ),
  },
  {
    id: 'jobsToday',
    header: 'Today',
    sortKey: 'jobsToday',
    numeric: true,
    priority: 'detail',
    className: 'w-24',
    cell: (row) => (
      <span className="tabular-nums">
        {row.jobsToday}/{row.dailyJobCapacity}
      </span>
    ),
  },
  {
    id: 'sync',
    header: 'Device',
    priority: 'detail',
    cell: (row) =>
      row.lastSyncAt === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <span className="flex flex-col gap-0.5">
          <Badge variant={row.pendingSyncActions > 0 ? 'warning' : 'success'}>
            {row.pendingSyncActions > 0 ? `${String(row.pendingSyncActions)} queued` : 'In sync'}
          </Badge>
          <span className="text-xs text-muted-foreground">{formatRelative(row.lastSyncAt)}</span>
        </span>
      ),
  },
];

export function AdminDriversPage() {
  const controller = useListQuery({ filterKeys: FILTER_KEYS });
  const { data, error, isPending, isFetching, refetch } = useDriverList(controller.query);

  const expiring = (data?.data ?? []).filter((driver) => driver.nextExpiryState !== 'valid');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Drivers"
        description="Licences, tickets and training with expiry reminders — plus the metrics that feed costing."
      />

      {expiring.length > 0 && (
        <Alert variant="warning" title="Credentials need attention">
          {expiring.length === 1
            ? '1 driver has a credential expired or expiring within the month.'
            : `${String(expiring.length)} drivers have a credential expired or expiring within the month.`}{' '}
          Licence currency is an operator obligation under the Heavy Vehicle National Law, not just
          the driver’s.
        </Alert>
      )}

      <Card className="overflow-hidden p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search name, mobile or vehicle…"
          filters={FILTERS}
        />

        <DataTable
          caption="Drivers"
          columns={COLUMNS}
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
          rowHref={(row) => `/admin/drivers/${row.id}`}
          empty={{
            icon: IdCardIcon,
            title: 'No drivers yet',
            description: 'Drivers appear here once they have a user account with the driver role.',
          }}
        />

        {data && (
          <Pagination
            page={data.meta.page}
            pageSize={data.meta.pageSize}
            total={data.meta.total}
            onPageChange={controller.setPage}
            onPageSizeChange={controller.setPageSize}
            pageSizeOptions={[5, 10, 15, 20]}
            disabled={isFetching}
          />
        )}
      </Card>

      <p className="text-xs text-muted-foreground">
        Sorted with anything expired or expiring first — {EXPIRY_STATE_LABELS.expired.toLowerCase()}
        , then {EXPIRY_STATE_LABELS['due-soon'].toLowerCase()}. This list exists to be chased.
      </p>
    </div>
  );
}
