import type { PortalSite } from '@plastago/shared';
import { Badge, Card, Pagination, buttonVariants } from '@plastago/ui';
import { BuildingIcon, ConstructionIcon, ForkliftIcon, PlusCircleIcon } from 'lucide-react';
import { Link } from 'react-router';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn, FilterDefinition } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { usePortalSites } from '@/features/portal/queries';
import { formatDate } from '@/lib/format';

/**
 * Your sites (M5.3 · W87, W98 and M5.6 · F46, W92).
 *
 * ── Why the customer maintains this and not the office ────────────────────
 * Because both sides are motivated by the same outcome. Access notes, gate hours
 * and crane windows are what stop a driver arriving at a locked gate — and a
 * futile pickup costs PlastaGo a truck run and costs the customer $120. The site
 * supervisor is also the only person who knows when the gate code changes.
 *
 * The lot number is shown as prominently as the street number on purpose: their
 * current booking form literally pleads *"Please use both Lot and Street Number
 * where possible"*, because drivers get lost in greenfield estates where street
 * numbers do not exist yet.
 */
const FILTER_KEYS = ['activity', 'induction', 'crane'] as const;

const STATIC_FILTERS: readonly FilterDefinition[] = [
  {
    key: 'activity',
    label: 'Activity',
    allLabel: 'All sites',
    options: [
      { value: 'active', label: 'Has a pickup booked' },
      { value: 'quiet', label: 'Nothing booked' },
    ],
  },
  {
    key: 'induction',
    label: 'Induction',
    allLabel: 'Any',
    options: [
      { value: 'required', label: 'Induction required' },
      { value: 'not-required', label: 'No induction' },
    ],
  },
  {
    key: 'crane',
    label: 'Crane',
    allLabel: 'Any',
    options: [
      { value: 'yes', label: 'Crane available' },
      { value: 'no', label: 'No crane' },
    ],
  },
];

const COLUMNS: readonly DataTableColumn<PortalSite>[] = [
  {
    id: 'name',
    header: 'Site',
    sortKey: 'name',
    priority: 'primary',
    cell: (row) => (
      <span className="block min-w-0">
        <span className="block truncate font-medium">{row.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {row.suburb} {row.postcode}
          {row.builderName ? ` · ${row.builderName}` : ''}
        </span>
      </span>
    ),
  },
  {
    id: 'openJobCount',
    header: 'Booked',
    sortKey: 'openJobCount',
    numeric: true,
    priority: 'secondary',
    cell: (row) =>
      row.openJobCount > 0 ? (
        <Badge variant="default">
          {row.openJobCount} pickup{row.openJobCount === 1 ? '' : 's'}
        </Badge>
      ) : (
        <span className="text-xs text-muted-foreground">None</span>
      ),
  },
  {
    id: 'access',
    header: 'Access',
    priority: 'secondary',
    cell: (row) => (
      <span className="flex flex-wrap items-center gap-1.5">
        {row.inductionRequired && (
          <Badge variant="warning">
            <ConstructionIcon aria-hidden className="size-3" />
            Induction
          </Badge>
        )}
        {row.craneAvailable && (
          <Badge variant="outline">
            <ForkliftIcon aria-hidden className="size-3" />
            Crane
          </Badge>
        )}
        {!row.inductionRequired && !row.craneAvailable && (
          <span className="text-xs text-muted-foreground">Open access</span>
        )}
      </span>
    ),
  },
  {
    id: 'gateHours',
    header: 'Gate hours',
    priority: 'detail',
    cell: (row) => row.gateHours ?? <span className="text-muted-foreground">Not set</span>,
  },
  {
    id: 'accessNotes',
    header: 'Access notes',
    priority: 'detail',
    cell: (row) =>
      row.accessNotes ? (
        <span className="line-clamp-2 text-sm">{row.accessNotes}</span>
      ) : (
        // Not a neutral blank: an empty access note is the single most common
        // reason a driver rings the office from outside a gate.
        <span className="text-xs text-warning">None — worth adding</span>
      ),
  },
  {
    id: 'totalJobCount',
    header: 'Pickups to date',
    numeric: true,
    priority: 'detail',
    cell: (row) => (
      <span className="block">
        <span className="block tabular-nums">{row.totalJobCount}</span>
        {row.lastJobAt !== null && (
          <span className="block text-xs text-muted-foreground">
            last {formatDate(row.lastJobAt)}
          </span>
        )}
      </span>
    ),
  },
];

export function PortalSitesPage() {
  const controller = useListQuery({ filterKeys: FILTER_KEYS, defaultPageSize: 25 });
  const { data, error, isPending, isFetching, refetch } = usePortalSites(controller.query);

  const missingNotes = (data?.data ?? []).filter((site) => !site.accessNotes).length;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight">Sites</h1>
          <p className="text-sm text-muted-foreground">
            Typed once, reused on every booking. Keeping the access notes current is what stops a
            driver waiting at a gate.
          </p>
        </div>
        <Link to="/portal/book" className={buttonVariants({ variant: 'outline' })}>
          <PlusCircleIcon aria-hidden />
          Book a pickup
        </Link>
      </header>

      <Card className="overflow-hidden p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search site name, lot number or suburb…"
          filters={STATIC_FILTERS}
          actions={
            missingNotes > 0 ? (
              <span className="text-xs text-warning">
                {missingNotes} site{missingNotes === 1 ? '' : 's'} without access notes
              </span>
            ) : undefined
          }
        />

        <DataTable
          caption="Your sites"
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
          rowHref={(row) => `/portal/sites/${row.id}`}
          empty={{
            icon: BuildingIcon,
            title: 'No sites yet',
            description:
              'Sites are set up when your account is created. Call the office on 1300 395 438 to add one.',
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
    </div>
  );
}
