import { VEHICLE_TYPE_LABELS, VEHICLE_TYPES, type VehicleListItem } from '@plastago/shared';
import { Alert, Badge, Card, Pagination } from '@plastago/ui';
import { WrenchIcon } from 'lucide-react';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn, FilterDefinition } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { ExpiryBadge } from '@/components/domain-badges';
import { PageHeader } from '@/components/page-header';
import { useVehicleList } from '@/features/fleet/queries';
import { useAuth } from '@/features/auth/auth-context';
import { formatDate, formatMoney } from '@/lib/format';

/**
 * Vehicles (M9.7 · F43).
 *
 * ── Ordered by what is overdue ─────────────────────────────────────────────
 * Four of their five vehicles currently show service dates in the past, and they
 * have this module in TransVirtual and do not maintain it. So the list leads with
 * registration and service state, and anything expired sorts to the top.
 *
 * ── Cost per kilometre is the output, not an input ─────────────────────────
 * Matt: *"At 49,000 km it went in for a service… what it ends up doing is
 * calculating a cost per kilometre."* It is derived from the expense log and the
 * odometer readings on it, which is why the expense form asks for both.
 */
const FILTER_KEYS = ['status', 'type', 'registration', 'service', 'defects'] as const;

const FILTERS: readonly FilterDefinition[] = [
  {
    key: 'status',
    label: 'Status',
    allLabel: 'All vehicles',
    options: [
      { value: 'active', label: 'In service' },
      { value: 'inactive', label: 'Out of service' },
    ],
  },
  {
    key: 'type',
    label: 'Type',
    allLabel: 'Any type',
    options: VEHICLE_TYPES.map((type) => ({ value: type, label: VEHICLE_TYPE_LABELS[type] })),
  },
  {
    key: 'registration',
    label: 'Registration',
    allLabel: 'Any registration state',
    options: [
      { value: 'expired', label: 'Expired' },
      { value: 'due-soon', label: 'Due within 2 weeks' },
      { value: 'valid', label: 'Current' },
    ],
  },
  {
    key: 'service',
    label: 'Service',
    allLabel: 'Any service state',
    options: [
      { value: 'expired', label: 'Overdue' },
      { value: 'due-soon', label: 'Due soon' },
      { value: 'valid', label: 'Up to date' },
    ],
  },
  {
    key: 'defects',
    label: 'Defects',
    allLabel: 'Any',
    options: [
      { value: 'open', label: 'Has open defects' },
      { value: 'none', label: 'No open defects' },
    ],
  },
];

const COLUMNS: readonly DataTableColumn<VehicleListItem>[] = [
  {
    id: 'rego',
    header: 'Vehicle',
    sortKey: 'rego',
    priority: 'primary',
    cell: (row) => (
      <span className="block">
        <span className="font-mono font-medium">{row.rego}</span>
        <span className="block text-xs text-muted-foreground">{row.label}</span>
      </span>
    ),
  },
  {
    id: 'registration',
    header: 'Registration',
    sortKey: 'registrationExpiresOn',
    priority: 'secondary',
    cell: (row) => (
      <span className="flex flex-col gap-1">
        <ExpiryBadge state={row.registrationState} />
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatDate(row.registrationExpiresOn)}
        </span>
      </span>
    ),
  },
  {
    id: 'service',
    header: 'Next service',
    sortKey: 'nextServiceDueOn',
    priority: 'secondary',
    cell: (row) => (
      <span className="flex flex-col gap-1">
        <ExpiryBadge state={row.serviceState} />
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatDate(row.nextServiceDueOn)}
        </span>
      </span>
    ),
  },
  {
    id: 'driver',
    header: 'Driver',
    priority: 'detail',
    cell: (row) => (
      <span className="text-muted-foreground">{row.assignedDriverName ?? 'Unassigned'}</span>
    ),
  },
  {
    id: 'odometerKm',
    header: 'Odometer',
    sortKey: 'odometerKm',
    numeric: true,
    priority: 'detail',
    cell: (row) => `${row.odometerKm.toLocaleString('en-AU')} km`,
  },
  {
    id: 'costPerKm',
    header: 'Cost / km',
    sortKey: 'costPerKm',
    numeric: true,
    priority: 'detail',
    cell: (row) =>
      row.costPerKm === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        formatMoney(row.costPerKm)
      ),
  },
  {
    id: 'defects',
    header: 'Defects',
    numeric: true,
    priority: 'detail',
    className: 'w-24',
    cell: (row) =>
      row.openDefectCount === 0 ? (
        <span className="text-muted-foreground">0</span>
      ) : (
        <Badge variant="warning">{row.openDefectCount} open</Badge>
      ),
  },
];

export function AdminVehiclesPage() {
  const { can } = useAuth();
  const controller = useListQuery({ filterKeys: FILTER_KEYS, defaultPageSize: 25 });
  const { data, error, isPending, isFetching, refetch } = useVehicleList(controller.query);

  // Cost per km is the commercial half of F43 (it feeds the margin figure,
  // M6.8). The Allocator's W113 is maintenance scheduling, so the column goes
  // and so does the sentence in the header that promises it.
  const seesPricing = can('pricing:view');
  const columns = seesPricing ? COLUMNS : COLUMNS.filter((column) => column.id !== 'costPerKm');

  const rows = data?.data ?? [];
  const expiredRego = rows.filter((row) => row.registrationState === 'expired');
  const overdueService = rows.filter((row) => row.serviceState === 'expired');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Vehicles"
        description={
          seesPricing
            ? 'Odometer and expenses in, cost per kilometre out — plus a registration reminder that actually fires.'
            : 'Registration, servicing and driver-reported defects — with reminders that actually fire.'
        }
      />

      {(expiredRego.length > 0 || overdueService.length > 0) && (
        <Alert variant="destructive" title="Fleet needs attention">
          {expiredRego.length > 0 && (
            <p>
              {expiredRego.map((row) => row.rego).join(', ')} — registration has expired. The
              vehicle should not be on the road until it is renewed.
            </p>
          )}
          {overdueService.length > 0 && (
            <p>{overdueService.map((row) => row.rego).join(', ')} — service overdue.</p>
          )}
        </Alert>
      )}

      <Card className="overflow-hidden p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search rego, description or driver…"
          filters={FILTERS}
        />

        <DataTable
          caption="Vehicles"
          columns={columns}
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
          rowHref={(row) => `/admin/vehicles/${row.id}`}
          empty={{
            icon: WrenchIcon,
            title: 'No vehicles yet',
            description: 'Add the fleet to start tracking cost per kilometre.',
          }}
        />

        {data && (
          <Pagination
            page={data.meta.page}
            pageSize={data.meta.pageSize}
            total={data.meta.total}
            onPageChange={controller.setPage}
            onPageSizeChange={controller.setPageSize}
            pageSizeOptions={[10, 25, 50]}
            disabled={isFetching}
          />
        )}
      </Card>

      <p className="text-xs text-muted-foreground">
        Deliberately simple: an expense is a date, an odometer reading, a description and a price.
        No parts-and-labour breakdown — that was explicitly not wanted.
      </p>
    </div>
  );
}
