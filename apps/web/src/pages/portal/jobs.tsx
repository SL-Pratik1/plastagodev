import { PENDING_READINESS_STATUSES, type PortalJobListItem } from '@plastago/shared';
import { Badge, Card, Pagination, buttonVariants } from '@plastago/ui';
import { ClipboardListIcon, ImageIcon, PlusCircleIcon, ZapIcon } from 'lucide-react';
import { Link } from 'react-router';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn, FilterDefinition } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { PickupStatusBadge, ReadinessBadge } from '@/components/portal/pickup-status';
import { usePortalJobs, usePortalScope, usePortalSites } from '@/features/portal/queries';
import { formatArea, formatDate, formatMoney, formatWeight } from '@/lib/format';

/**
 * Pickups — live status and full history (M5.7 · F26, M5.8 · F18).
 *
 * ── One list, not two ─────────────────────────────────────────────────────
 * M5.7 (live status) and M5.8 (history) are the same list read at two moments,
 * and splitting them into separate screens would mean a supervisor has to know
 * which tab a pickup has moved to before they can find it. The default sort does
 * the work instead: open pickups first by soonest ready date, then history
 * newest-first — the order someone actually reads.
 *
 * ── The grid becomes cards below `md`, and that is the primary case ────────
 * Reusing `DataTable` gives the Customer Administrator a real table at a desk
 * and the site supervisor cards on a phone, from one column definition. Nothing
 * is dropped on the small layout; only its position changes.
 */
const FILTER_KEYS = ['state', 'site', 'urgent', 'readiness'] as const;

const STATIC_FILTERS: readonly FilterDefinition[] = [
  {
    key: 'state',
    label: 'Status',
    allLabel: 'All pickups',
    // Four plain answers rather than nine internal statuses — the customer asks
    // "is it coming, did it happen, did it fail".
    options: [
      { value: 'open', label: 'Coming up' },
      { value: 'completed', label: 'Completed' },
      { value: 'futile', label: 'Could not collect' },
      { value: 'cancelled', label: 'Cancelled' },
    ],
  },
  {
    key: 'readiness',
    label: 'Ready confirmed',
    allLabel: 'Confirmed and not',
    options: [
      { value: 'unconfirmed', label: 'Not yet confirmed' },
      { value: 'confirmed', label: 'Confirmed ready' },
    ],
  },
  {
    key: 'urgent',
    label: 'Urgency',
    allLabel: 'Any urgency',
    options: [
      { value: 'urgent', label: 'Urgent only' },
      { value: 'standard', label: 'Standard only' },
    ],
  },
];

export function PortalJobsPage() {
  const scope = usePortalScope();
  const controller = useListQuery({ filterKeys: FILTER_KEYS, defaultPageSize: 25 });
  const { data, error, isPending, isFetching, refetch } = usePortalJobs(controller.query);
  const sites = usePortalSites({ page: 1, pageSize: 200 });

  const canSeePricing = scope.data?.canSeePricing ?? false;
  const capturesWeight = scope.data?.capturesWeight ?? false;

  const filters: readonly FilterDefinition[] = [
    ...STATIC_FILTERS,
    // Only worth offering when there is more than one site to choose between —
    // a single-site supervisor gets a dropdown with one option otherwise.
    ...((sites.data?.data.length ?? 0) > 1
      ? [
          {
            key: 'site',
            label: 'Site',
            allLabel: 'All sites',
            options: (sites.data?.data ?? []).map((site) => ({
              value: site.id,
              label: `${site.name} — ${site.suburb}`,
            })),
          },
        ]
      : []),
  ];

  const columns: readonly DataTableColumn<PortalJobListItem>[] = [
    {
      id: 'readyDate',
      header: 'Ready date',
      sortKey: 'readyDate',
      priority: 'primary',
      cell: (row) => (
        <span className="block">
          <span className="block font-medium">{formatDate(row.readyDate)}</span>
          <span className="block text-xs text-muted-foreground">
            <span className="font-mono">#{row.jobNumber}</span>
            {row.reference !== null && ` · ${row.reference}`}
          </span>
        </span>
      ),
    },
    {
      id: 'siteName',
      header: 'Site',
      sortKey: 'siteName',
      priority: 'detail',
      cell: (row) => (
        <span className="block">
          <span className="block">{row.siteName}</span>
          <span className="block text-xs text-muted-foreground">{row.suburb}</span>
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      priority: 'secondary',
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <PickupStatusBadge status={row.status} />
          {row.serviceLevel === 'urgent' && (
            <Badge variant="warning">
              <ZapIcon aria-hidden className="size-3" />
              Urgent
            </Badge>
          )}
        </span>
      ),
    },
    {
      id: 'readiness',
      header: 'Ready',
      priority: 'secondary',
      // Only meaningful while the pickup is still ahead of us. On a completed
      // job it is history nobody needs, and it would crowd the row.
      cell: (row) =>
        PENDING_READINESS_STATUSES.includes(row.status) ? (
          <ReadinessBadge job={row} />
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: 'quantity',
      header: capturesWeight ? 'm² / recovered' : 'Plasterboard',
      sortKey: 'expectedAreaM2',
      numeric: true,
      priority: 'detail',
      cell: (row) => (
        <span className="block">
          <span className="block">{formatArea(row.expectedAreaM2)}</span>
          {capturesWeight && row.recoveredWeightKg !== null && (
            <span className="block text-xs text-muted-foreground">
              {formatWeight(row.recoveredWeightKg)} recovered
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'photos',
      header: 'Photos',
      priority: 'detail',
      cell: (row) =>
        row.photoCount > 0 ? (
          <span className="flex items-center gap-1 text-sm">
            <ImageIcon aria-hidden className="size-3.5 text-muted-foreground" />
            {row.photoCount}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    // The money column exists only for a role whose payload contains money.
    ...(canSeePricing
      ? [
          {
            id: 'totalIncGst',
            header: 'Cost inc GST',
            numeric: true,
            priority: 'detail' as const,
            cell: (row: PortalJobListItem) => formatMoney(row.totalIncGst),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight">Pickups</h1>
          <p className="text-sm text-muted-foreground">
            What is coming up, and everything we have collected for you.
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
          searchPlaceholder="Search by number, site, suburb or your reference…"
          filters={filters}
        />

        <DataTable
          caption="Your pickups"
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
          rowHref={(row) => `/portal/jobs/${row.id}`}
          empty={{
            icon: ClipboardListIcon,
            title: 'No pickups yet',
            description: 'Book your first pickup and it will appear here with live status.',
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
