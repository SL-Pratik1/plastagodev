import {
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  ZONES,
  ZONE_LABELS,
  type LeadListItem,
  type LeadStatus,
} from '@plastago/shared';
import { Alert, Badge, Card, Pagination, type BadgeProps } from '@plastago/ui';
import { SproutIcon } from 'lucide-react';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn, FilterDefinition } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { PageHeader } from '@/components/page-header';
import { AgeBadge } from '@/components/queues/age-badge';
import { StatCard } from '@/components/stat-card';
import { useLeadList } from '@/features/queues/queries';
import { formatArea, formatDate, formatMobile } from '@/lib/format';

/**
 * The onboarding queue (M5 · Journey A · A.3).
 *
 * ── This is the first CRM capability PlastaGo has ever had ────────────────
 * A.3's own framing, and the reason it is nearly free: it is one more queue in a
 * console that already has four. Its real value is that it finally makes *"how
 * many enquiries did we get and how many converted?"* answerable — which is why
 * the counters above the grid are conversion counters, not row counts.
 *
 * ── Deliberately low volume ───────────────────────────────────────────────
 * ~1.6 new companies a month (53 accounts in 38 months). A queue built for
 * hundreds would be the wrong shape: the work here is a handful of real
 * relationships, each one a sales decision Matt makes on the phone. So the grid
 * is small, and every row carries enough to have that phone call from — volume,
 * suburbs, frequency, and how they found PlastaGo.
 */
const FILTER_KEYS = ['status', 'source', 'zone', 'owner', 'age'] as const;

const STATUS_VARIANT: Record<LeadStatus, BadgeProps['variant']> = {
  new: 'warning',
  contacted: 'secondary',
  quoted: 'default',
  won: 'success',
  lost: 'outline',
};

const STATIC_FILTERS: readonly FilterDefinition[] = [
  {
    key: 'status',
    label: 'Status',
    allLabel: 'Any status',
    options: LEAD_STATUSES.map((status) => ({ value: status, label: LEAD_STATUS_LABELS[status] })),
  },
  {
    key: 'source',
    label: 'Source',
    allLabel: 'Any source',
    options: LEAD_SOURCES.map((source) => ({ value: source, label: LEAD_SOURCE_LABELS[source] })),
  },
  {
    key: 'zone',
    label: 'Zone',
    allLabel: 'All areas',
    options: [
      ...ZONES.map((zone) => ({ value: zone, label: ZONE_LABELS[zone] })),
      // A lead outside the three zones is not a data gap — it is a lead we
      // probably cannot service, and that is worth being able to filter for.
      { value: 'none', label: 'Outside the service area' },
    ],
  },
  {
    key: 'owner',
    label: 'Owner',
    allLabel: 'Anyone',
    options: [
      { value: 'unassigned', label: 'Unassigned' },
      { value: 'Matthew Browne', label: 'Matthew Browne' },
      { value: 'Priya Raman', label: 'Priya Raman' },
    ],
  },
  {
    key: 'age',
    label: 'Enquired',
    allLabel: 'Any time',
    options: [
      { value: 'today', label: 'Today' },
      { value: 'this-week', label: 'This week' },
      { value: 'over-week', label: 'More than a week' },
      { value: 'over-month', label: 'More than a month' },
    ],
  },
];

const COLUMNS: readonly DataTableColumn<LeadListItem>[] = [
  {
    id: 'companyName',
    header: 'Company',
    sortKey: 'companyName',
    priority: 'primary',
    cell: (row) => (
      <span className="block min-w-0">
        <span className="block truncate font-medium">{row.companyName}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {row.contactName} · {row.email}
        </span>
      </span>
    ),
  },
  {
    id: 'status',
    header: 'Status',
    sortKey: 'status',
    priority: 'secondary',
    cell: (row) => (
      <span className="block">
        <Badge variant={STATUS_VARIANT[row.status]}>{LEAD_STATUS_LABELS[row.status]}</Badge>
        {row.convertedAccountId !== null && (
          <span className="mt-1 block text-xs text-success">Account created</span>
        )}
      </span>
    ),
  },
  {
    id: 'area',
    header: 'Where',
    priority: 'detail',
    cell: (row) => (
      <span className="block">
        <span className="block text-sm">
          {row.zone === null ? (
            <span className="text-warning">Outside service area</span>
          ) : (
            ZONE_LABELS[row.zone]
          )}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{row.suburbs}</span>
      </span>
    ),
  },
  {
    id: 'typicalVolumeM2',
    header: 'Volume',
    sortKey: 'typicalVolumeM2',
    numeric: true,
    priority: 'detail',
    cell: (row) => (
      <span className="block">
        <span className="block">{formatArea(row.typicalVolumeM2)}</span>
        <span className="block text-xs text-muted-foreground">{row.expectedFrequency}</span>
      </span>
    ),
  },
  {
    id: 'contact',
    header: 'Phone',
    priority: 'detail',
    cell: (row) =>
      row.mobile ? (
        <a
          href={`tel:${row.mobile}`}
          className="focus-ring rounded tabular-nums text-primary underline-offset-4 hover:underline"
        >
          {formatMobile(row.mobile)}
        </a>
      ) : (
        <span className="text-muted-foreground">Email only</span>
      ),
  },
  {
    id: 'ownerName',
    header: 'Owner',
    priority: 'detail',
    cell: (row) => row.ownerName ?? <Badge variant="warning">Unassigned</Badge>,
  },
  {
    id: 'createdAt',
    header: 'Enquired',
    sortKey: 'createdAt',
    priority: 'secondary',
    cell: (row) => {
      const closed = row.status === 'won' || row.status === 'lost';
      return (
        <span className="block">
          <AgeBadge since={row.createdAt} warnDays={2} alarmDays={7} muted={closed} />
          <span className="mt-1 block text-xs text-muted-foreground tabular-nums">
            {formatDate(row.createdAt)}
          </span>
        </span>
      );
    },
  },
];

export function AdminQueueLeadsPage() {
  const controller = useListQuery({ filterKeys: FILTER_KEYS, defaultPageSize: 20 });
  const { data, error, isPending, isFetching, refetch } = useLeadList(controller.query);

  // Computed from the visible page only, and labelled as such — a "conversion
  // rate" that silently covered a different set of rows than the grid below it
  // would be the most quotable wrong number on the screen.
  const rows = data?.data ?? [];
  const open = rows.filter((row) => !['won', 'lost'].includes(row.status)).length;
  const won = rows.filter((row) => row.status === 'won').length;
  const closed = rows.filter((row) => ['won', 'lost'].includes(row.status)).length;
  const conversion = closed === 0 ? null : Math.round((won / closed) * 100);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leads"
        description="Enquiries from the public form and the phone. Nothing here is a job — a lead becomes bookable only once an account exists, with a rate card and terms agreed."
        badge={open > 0 ? <Badge variant="warning">{open} open</Badge> : undefined}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Open on this page" value={String(open)} hint="New, contacted or quoted" />
        <StatCard label="Won" value={String(won)} hint="Converted to an account" />
        <StatCard
          label="Conversion"
          value={conversion === null ? '—' : `${String(conversion)}%`}
          hint={
            closed === 0
              ? 'Nothing closed yet on this page'
              : `${String(won)} of ${String(closed)} closed`
          }
        />
      </div>

      <Card className="overflow-hidden p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search company, contact, email or suburb…"
          filters={STATIC_FILTERS}
        />

        <DataTable
          caption="Leads and onboarding"
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
          rowHref={(row) => `/admin/queues/leads/${row.id}`}
          empty={{
            icon: SproutIcon,
            title: 'No enquiries yet',
            description:
              'Leads arrive from the public enquiry form on plastago.com.au and by phone.',
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

      <Alert variant="info" title="Why a lead is not a job">
        Nothing can be priced or scheduled until an account exists — pricing is a rate card, a zone
        and a PO policy, and none of those are known at enquiry time. Today leads arrive disguised
        as jobs because the public form has a free-text account field, and the office works out who
        they are afterwards. This queue is where that guessing stops.
      </Alert>
    </div>
  );
}
