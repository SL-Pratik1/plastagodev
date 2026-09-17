import type { DriverListItem } from '@plastago/shared';
import { Badge, Card, Pagination } from '@plastago/ui';
import { IdCardIcon } from 'lucide-react';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn, FilterDefinition } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { PageHeader } from '@/components/page-header';
import { useDriverList } from '@/features/fleet/queries';
import { formatMobile } from '@/lib/format';

/**
 * Drivers (M9.9 · F22).
 *
 * ── Why this is a roster and not a compliance register ─────────────────────
 * F53 framed this list around licence expiry — the reminder was meant to be the
 * feature. Nothing in the product could ever record a licence, so the expiry
 * column, its filter and its warning banner only ever reported on an empty
 * collection, which reads as "everybody is current" rather than "nothing was
 * ever entered". They were removed rather than left to reassure falsely; if
 * credential tracking comes back it needs a way to WRITE a credential first.
 *
 * The device column went the same way — device registration is never captured.
 */
const FILTER_KEYS = ['status', 'vehicle'] as const;

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
    id: 'vehicle',
    header: 'Vehicle',
    priority: 'secondary',
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
];

export function AdminDriversPage() {
  const controller = useListQuery({ filterKeys: FILTER_KEYS });
  const { data, error, isPending, isFetching, refetch } = useDriverList(controller.query);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Drivers"
        description="Who is on the road, what they drive, and the metrics that feed costing."
      />

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
    </div>
  );
}
