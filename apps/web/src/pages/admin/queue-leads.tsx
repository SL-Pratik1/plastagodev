import {
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  type LeadListItem,
  type LeadStatus,
} from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  Pagination,
  buttonVariants,
  type BadgeProps,
} from '@plastago/ui';
import { PlusIcon, SproutIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { ZoneOption } from '@/services/types';
import { DataTable } from '@/components/data-table/data-table';
import { useZoneOptions } from '@/features/lookups/queries';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn, FilterDefinition } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { PageHeader } from '@/components/page-header';
import { AgeBadge } from '@/components/queues/age-badge';
import { StatCard } from '@/components/stat-card';
import { ConvertLeadDialog } from '@/features/queues/components/convert-lead-dialog';
import { useLeadList, useLeadStats } from '@/features/queues/queries';
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

/**
 * The filter bar, with the loaded zones spliced back where they were.
 *
 * See `jobs.tsx:filtersWithZones` for why the position is fixed. The sentinel
 * stays LAST inside the built list, so it keeps its place at the bottom of the
 * dropdown rather than drifting to wherever the zones happen to end.
 */
function filtersWithZones(zones: readonly ZoneOption[]): FilterDefinition[] {
  const zoneFilter: FilterDefinition = {
    key: 'zoneId',
    label: 'Zone',
    allLabel: 'All areas',
    options: [
      ...zones.map((zone) => ({
        value: zone.value,
        label: zone.archived ? `${zone.label} (retired)` : zone.label,
      })),
      // A lead outside every serviced zone is not a data gap — it is a lead we
      // probably cannot service, and that is worth being able to filter for.
      { value: 'none', label: 'Outside the service area' },
    ],
  };

  const index = STATIC_FILTERS.findIndex((filter) => filter.key === 'owner');
  return [...STATIC_FILTERS.slice(0, index), zoneFilter, ...STATIC_FILTERS.slice(index)];
}

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
          {row.zoneLabel === null ? (
            <span className="text-warning">Outside service area</span>
          ) : (
            row.zoneLabel
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

/**
 * Whether this enquiry became a customer — and the way to make it one.
 *
 * ── Why converting lives in the grid and not only on the lead ─────────────
 * A.4 was reachable from one place: open the lead, then press Convert. But the
 * question "which of these still need an account?" is a question about the
 * LIST, and answering it meant opening each row in turn to find out. The column
 * answers it at a glance, and puts the action next to the answer.
 *
 * ⚠️ No capability guard on the button. Reaching this page requires
 * `leads:manage`, which only Operations and the Super Admin hold — the same two
 * roles the API's `CONVERTER_ROLES` allows — so a guard here could never be
 * false. If that matrix ever widens, the check belongs here and in the service.
 */
function accountColumn(onConvert: (lead: LeadListItem) => void): DataTableColumn<LeadListItem> {
  return {
    id: 'account',
    header: 'Account',
    priority: 'secondary',
    className: 'w-36',
    cell: (row) => {
      if (row.convertedAccountId !== null) {
        return (
          <Link
            to={`/admin/customers/${row.convertedAccountId}`}
            className="focus-ring inline-flex rounded underline-offset-4 hover:underline"
          >
            <Badge variant="success">Converted</Badge>
          </Link>
        );
      }

      /*
       * A lost enquiry gets no button. Converting one is not forbidden — the
       * API would allow it — but offering it here invites an account for a
       * builder who already said no, and reviving a lead is a decision made on
       * the lead itself, by moving it back down the pipeline first. The detail
       * page hides Convert for lost leads on the same grounds.
       */
      if (row.status === 'lost') {
        return <span className="text-xs text-muted-foreground">Not converted</span>;
      }

      return (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            onConvert(row);
          }}
        >
          <SproutIcon aria-hidden />
          Convert
        </Button>
      );
    },
  };
}

export function AdminQueueLeadsPage() {
  const controller = useListQuery({ filterKeys: FILTER_KEYS, defaultPageSize: 20 });

  /*
   * ⚠️ Converted leads are shown, always — this grid is the whole pipeline.
   *
   * The API hides them by default, and for a while so did this page. It was the
   * wrong default in both directions: landing here showed a list with the wins
   * silently missing, and the one filter that names them — Won — returned an
   * empty grid with nothing on screen to explain it. A lead that became a
   * customer is the outcome the pipeline exists to produce; hiding the
   * successes is hiding the answer to "how are we doing".
   *
   * The Account column carries the distinction instead, which is where a reader
   * can actually see it.
   */
  const query = useMemo(
    () => ({
      ...controller.query,
      filters: { ...controller.query.filters, includeConverted: 'true' },
    }),
    [controller.query],
  );

  const { data, error, isPending, isFetching, refetch } = useLeadList(query);

  /*
   * ── Why these three numbers do not come from `rows` ──────────────────────
   * They used to, and it made them the most quotable wrong number on the
   * screen. The grid is paged and hides converted leads, so "Won" counted only
   * leads somebody had typed as won WITHOUT converting — the precise set that
   * are not wins — and a conversion rate that moved when you typed in the
   * search box is a rate nobody can repeat. Counted on the server now, across
   * every lead, whatever the grid is filtered to.
   */
  const stats = useLeadStats().data;
  const rows = data?.data ?? [];

  /*
   * The lead the convert dialog is open for, or null.
   *
   * Held as the ROW rather than an id: `ConvertLeadDialog` needs only a name, a
   * contact and a zone, all of which the row already carries, so opening it
   * costs no extra fetch.
   */
  const [converting, setConverting] = useState<LeadListItem | null>(null);

  // Built here, not at module scope, because the Account column has to reach
  // back into this component's state to open the dialog.
  const columns = useMemo(() => [...COLUMNS, accountColumn(setConverting)], []);
  const open = stats?.open ?? 0;
  const won = stats?.won ?? 0;
  const closed = (stats?.won ?? 0) + (stats?.lost ?? 0);
  const conversion = closed === 0 ? null : Math.round((won / closed) * 100);

  /*
   * ⚠️ Falls back to an empty list rather than gating the grid on a spinner.
   *
   * The zone filter renders with only "All zones" until the register lands,
   * exactly as the Account and Driver filters beside it already do. One request
   * per session — the reference cache holds it for an hour — so this is a
   * first-paint concern on one screen, not a recurring one.
   */
  const zones = useZoneOptions().data ?? [];


  return (
    <div className="space-y-6">
      <PageHeader
        title="Leads"
        description="Enquiries from the public form and the phone. Nothing here is a job — a lead becomes bookable only once an account exists, with a rate card and terms agreed."
        badge={open > 0 ? <Badge variant="warning">{open} open</Badge> : undefined}
        // No capability check on the action: reaching this page at all requires
        // `leads:manage`, so a guard here could never be false.
        actions={
          <Link to="/admin/queues/leads/new" className={buttonVariants()}>
            <PlusIcon aria-hidden />
            New lead
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Open" value={String(open)} hint="New, contacted or quoted" />
        <StatCard label="Won" value={String(won)} hint="Converted to an account" />
        <StatCard
          label="Conversion"
          value={conversion === null ? '—' : `${String(conversion)}%`}
          hint={closed === 0 ? 'Nothing closed yet' : `${String(won)} of ${String(closed)} closed`}
        />
      </div>

      <Card className="overflow-hidden p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search company, contact, email or suburb…"
          filters={filtersWithZones(zones)}
        />

        <DataTable
          caption="Leads and onboarding"
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
          rowHref={(row) => `/admin/queues/leads/${row.id}`}
          empty={{
            icon: SproutIcon,
            title: 'No enquiries yet',
            description:
              'Leads arrive from the public enquiry form on plastago.com.au. Took one by phone? Add it with “New lead”.',
          }}
        />

        {/*
          One dialog for the whole grid, not one per row: it is a single modal
          either way, and mounting twenty of them to show at most one is twenty
          forms' worth of state for no gain.
        */}
        {converting && (
          <ConvertLeadDialog
            lead={converting}
            open
            onClose={() => {
              setConverting(null);
            }}
          />
        )}

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
