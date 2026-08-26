import {
  AUDIT_ACTION_LABELS,
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  AUDIT_ENTITY_LABELS,
  ROLE_LABELS,
  type AuditEntry,
} from '@plastago/shared';
import { Alert, Badge, Card, Drawer, Pagination, Skeleton, buttonVariants } from '@plastago/ui';
import { ScrollTextIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn, FilterDefinition } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { DetailList } from '@/components/detail-list';
import { PageHeader } from '@/components/page-header';
import { useAuditEntry, useAuditList } from '@/features/audit/queries';
import { useUserOptionsFromAudit } from '@/features/audit/use-actor-options';
import { formatDateTime, formatRelative } from '@/lib/format';

/**
 * The audit log (M1.6).
 *
 * ── Why it exists ─────────────────────────────────────────────────────────
 * "Who changed what, when, from what value to what value — immutable." Today a
 * shared mailbox and a shared page password mean there is **zero
 * accountability**, so *"who changed job 61402's ready date from 12 Aug to 19
 * Aug?"* cannot be answered at all. This screen makes it one search.
 *
 * ── Read-only, structurally ───────────────────────────────────────────────
 * The collection is append-only, fed by Change Streams. There is no edit or
 * delete affordance here and no mutation in the service behind it — an audit log
 * you can change is not an audit log.
 *
 * ── The detail is a drawer, not a page ────────────────────────────────────
 * Auditing is a scanning activity: you run down the list looking for the entry
 * that explains something. A full page navigation per row would mean losing the
 * list and your scroll position on every guess.
 */
const FILTER_KEYS = ['actor', 'action', 'entity', 'window'] as const;

const STATIC_FILTERS: readonly FilterDefinition[] = [
  {
    key: 'window',
    label: 'When',
    allLabel: 'All time',
    options: [
      { value: 'today', label: 'Today' },
      { value: 'last-24h', label: 'Last 24 hours' },
      { value: 'last-7d', label: 'Last 7 days' },
      { value: 'last-30d', label: 'Last 30 days' },
    ],
  },
  {
    key: 'action',
    label: 'Action',
    allLabel: 'Any action',
    options: AUDIT_ACTIONS.map((action) => ({ value: action, label: AUDIT_ACTION_LABELS[action] })),
  },
  {
    key: 'entity',
    label: 'Record type',
    allLabel: 'Any record',
    options: AUDIT_ENTITIES.map((entity) => ({
      value: entity,
      label: AUDIT_ENTITY_LABELS[entity],
    })),
  },
];

const DESTRUCTIVE_ACTIONS = new Set(['deleted', 'suspended', 'rejected', 'sign-in-failed']);

export function AdminAuditLogPage() {
  const controller = useListQuery({ filterKeys: FILTER_KEYS, defaultPageSize: 25 });
  const { data, error, isPending, isFetching, refetch } = useAuditList(controller.query);
  const actors = useUserOptionsFromAudit();

  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useAuditEntry(openId);

  const filters: readonly FilterDefinition[] = [
    ...STATIC_FILTERS,
    { key: 'actor', label: 'Who', allLabel: 'Anyone', options: actors },
  ];

  const columns: readonly DataTableColumn<AuditEntry>[] = [
    {
      id: 'at',
      header: 'When',
      sortKey: 'at',
      priority: 'primary',
      cell: (row) => (
        <span className="block">
          <span className="tabular-nums">{formatDateTime(row.at)}</span>
          <span className="block text-xs text-muted-foreground">{formatRelative(row.at)}</span>
        </span>
      ),
    },
    {
      id: 'actorName',
      header: 'Who',
      sortKey: 'actorName',
      priority: 'detail',
      cell: (row) => (
        <span className="block">
          <span>{row.actorName}</span>
          {row.actorRole && (
            <span className="block text-xs text-muted-foreground">
              {ROLE_LABELS[row.actorRole]}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'action',
      header: 'Action',
      priority: 'secondary',
      cell: (row) => (
        <Badge variant={DESTRUCTIVE_ACTIONS.has(row.action) ? 'destructive' : 'secondary'}>
          {AUDIT_ACTION_LABELS[row.action]}
        </Badge>
      ),
    },
    {
      id: 'entity',
      header: 'Record',
      sortKey: 'entity',
      priority: 'detail',
      cell: (row) => (
        <span className="block">
          <span className="text-xs text-muted-foreground">{AUDIT_ENTITY_LABELS[row.entity]}</span>
          <span className="block">{row.entityLabel}</span>
        </span>
      ),
    },
    {
      id: 'summary',
      header: 'What changed',
      priority: 'detail',
      cell: (row) => (
        <span className="block">
          <span className="text-muted-foreground">{row.summary}</span>
          {row.changes.length > 0 && (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {row.changes
                .slice(0, 2)
                .map((change) => `${change.field}: ${change.from ?? '—'} → ${change.to ?? '—'}`)
                .join(' · ')}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'open',
      header: 'Detail',
      className: 'w-20',
      cell: (row) => (
        <button
          type="button"
          onClick={() => {
            setOpenId(row.id);
          }}
          className="focus-ring rounded text-xs font-medium text-primary underline-offset-4 hover:underline"
        >
          View
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        description="Who changed what, when, and from which value to which — append-only."
      />

      <Card className="overflow-hidden p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search person, record or change…"
          filters={filters}
        />

        <DataTable
          caption="Audit log"
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
          empty={{
            icon: ScrollTextIcon,
            title: 'No entries',
            description: 'Every state change is recorded here as it happens.',
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

      <Alert variant="neutral" title="Append-only, by design">
        Entries are written by the database as records change, not by the application deciding to
        log something — so nothing can be edited, deleted, or quietly missed. Sign-ins are here too,
        which is what makes “what happened around 4pm?” answerable in one place.
      </Alert>

      <Drawer
        open={openId !== null}
        onClose={() => {
          setOpenId(null);
        }}
        title="Audit entry"
        description={detail.data ? formatDateTime(detail.data.at) : undefined}
        size="lg"
      >
        {detail.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : detail.data ? (
          <div className="space-y-5">
            <DetailList
              columns={1}
              items={[
                { label: 'Who', value: detail.data.actorName },
                {
                  label: 'Role',
                  value: detail.data.actorRole ? ROLE_LABELS[detail.data.actorRole] : 'System',
                },
                { label: 'Action', value: AUDIT_ACTION_LABELS[detail.data.action] },
                {
                  label: 'Record',
                  value: `${AUDIT_ENTITY_LABELS[detail.data.entity]} — ${detail.data.entityLabel}`,
                },
                { label: 'Summary', value: detail.data.summary },
                ...(detail.data.device ? [{ label: 'Device', value: detail.data.device }] : []),
              ]}
            />

            {detail.data.changes.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Field changes
                </p>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {detail.data.changes.map((change) => (
                    <li key={change.field} className="p-3 text-sm">
                      <p className="font-medium">{change.field}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                        <span className="rounded bg-destructive/10 px-1.5 py-0.5 font-mono text-destructive">
                          {change.from ?? 'not set'}
                        </span>
                        <span aria-hidden className="text-muted-foreground">
                          →
                        </span>
                        <span className="rounded bg-success/10 px-1.5 py-0.5 font-mono text-success">
                          {change.to ?? 'cleared'}
                        </span>
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {detail.data.href && (
              <Link
                to={detail.data.href}
                onClick={() => {
                  setOpenId(null);
                }}
                className={buttonVariants({ variant: 'outline', className: 'w-full' })}
              >
                Open the record
              </Link>
            )}
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
