import type { ChangeRequestItem } from '@plastago/shared';
import {
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  Pagination,
  Spinner,
  Textarea,
  useToast,
} from '@plastago/ui';
import { CalendarSyncIcon, CheckCircle2Icon, InboxIcon, XCircleIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn, FilterDefinition } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { PageHeader } from '@/components/page-header';
import { AgeBadge } from '@/components/queues/age-badge';
import { useAccountOptions } from '@/features/lookups/queries';
import { useChangeRequestDecide, useChangeRequestList } from '@/features/queues/queries';
import { describeError } from '@/lib/error-message';
import { formatDate, formatDateTime } from '@/lib/format';

/**
 * Change requests raised from the portal (M5.4).
 *
 * ── Why this screen exists ────────────────────────────────────────────────
 * Because the other end of it already did. The portal refuses a direct edit the
 * moment a pickup reaches a run sheet and points the customer at "Request a
 * change" — telling them *"Request sent to the office. We will confirm by phone
 * or text."* The rows were written to `changerequests` and read by nothing: no
 * screen, no queue, no notification. It was the only way a customer could reach
 * anybody after allocation, and it went nowhere.
 *
 * The model was always shaped for this — `state`, `resolvedBy`, `resolutionNote`
 * and an index commented *"the office's worklist: everything open, oldest
 * first"*. So this finishes a design rather than adding one.
 *
 * ── Deciding does NOT move the job ────────────────────────────────────────
 * Accepting a reschedule records the answer and tells the customer; the office
 * then moves the job through the normal reschedule path. Applying it from here
 * would be a second, quieter way to move a pickup — without the business-day
 * window, the SLA clock or the run — and the two would drift apart. The row
 * links to the job so that is one click, not a search.
 *
 * ── Oldest first, and not sortable by newest ──────────────────────────────
 * Same reason as the futile queue: a worklist worked newest-first is one where
 * the oldest row is never touched. Here the oldest row is the customer who has
 * been waiting longest for an answer they were promised.
 */
const FILTER_KEYS = ['account', 'kind', 'age'] as const;

const STATIC_FILTERS: readonly FilterDefinition[] = [
  {
    key: 'kind',
    label: 'Asking for',
    allLabel: 'Any request',
    options: [
      { value: 'reschedule', label: 'A different date' },
      { value: 'cancel', label: 'To cancel' },
      { value: 'other', label: 'Something else' },
    ],
  },
  {
    key: 'age',
    label: 'Waiting',
    allLabel: 'Any age',
    options: [
      { value: 'today', label: 'Today' },
      { value: 'this-week', label: 'This week' },
      { value: 'over-week', label: 'More than a week' },
    ],
  },
];

/** The customer's ask, in the office's words. */
function describeKind(row: ChangeRequestItem): string {
  if (row.kind === 'cancel') return 'Cancel the pickup';
  if (row.kind === 'reschedule') {
    return row.requestedDate ? `Move to ${formatDate(row.requestedDate)}` : 'Move it';
  }
  return 'Something else';
}

export function AdminQueueChangeRequestsPage() {
  const toast = useToast();
  const controller = useListQuery({ filterKeys: FILTER_KEYS });
  const { data, error, isPending, isFetching, refetch } = useChangeRequestList(controller.query);
  const accounts = useAccountOptions();
  const decide = useChangeRequestDecide();

  const [deciding, setDeciding] = useState<ChangeRequestItem | null>(null);
  const [outcome, setOutcome] = useState<'actioned' | 'declined'>('actioned');
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);

  const filters: readonly FilterDefinition[] = [
    ...STATIC_FILTERS,
    { key: 'account', label: 'Customer', allLabel: 'All customers', options: accounts.data ?? [] },
  ];

  const open = (row: ChangeRequestItem, next: 'actioned' | 'declined') => {
    setDeciding(row);
    setOutcome(next);
    setNote('');
    setNoteError(null);
  };

  const close = () => {
    setDeciding(null);
    setNoteError(null);
  };

  const submit = async () => {
    if (!deciding) return;

    /*
     * A decline must carry a reason, and unlike a rejected charge this one
     * genuinely reaches the person who asked — it is the body of their
     * notification and it shows on their pickup.
     */
    if (outcome === 'declined' && note.trim().length === 0) {
      setNoteError('The customer reads this — say why the change cannot be made.');
      return;
    }

    try {
      await decide.mutateAsync({ id: deciding.id, decision: { outcome, note: note.trim() } });
      toast.success(
        outcome === 'actioned'
          ? `Accepted — #${String(deciding.jobNumber)}`
          : `Declined — #${String(deciding.jobNumber)}`,
        outcome === 'actioned'
          ? 'The customer has been told. Move the pickup itself from the job.'
          : 'The customer has been told, with your reason.',
      );
      close();
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const columns: readonly DataTableColumn<ChangeRequestItem>[] = [
    {
      id: 'jobNumber',
      header: 'Pickup',
      priority: 'primary',
      cell: (row) => (
        <span className="block">
          <Link
            to={`/admin/jobs/${row.jobId}`}
            className="focus-ring rounded font-mono font-medium text-primary underline-offset-4 hover:underline"
          >
            #{row.jobNumber}
          </Link>
          <span className="block text-xs text-muted-foreground">
            {row.siteName}, {row.suburb}
          </span>
        </span>
      ),
    },
    {
      id: 'accountName',
      header: 'Customer',
      priority: 'detail',
      cell: (row) => (
        <span className="block">
          <span className="block">{row.accountName}</span>
          <span className="block text-xs text-muted-foreground">{row.requestedByName}</span>
        </span>
      ),
    },
    {
      id: 'kind',
      header: 'Asking for',
      priority: 'primary',
      cell: (row) => (
        <span className="block">
          <Badge variant={row.kind === 'cancel' ? 'destructive' : 'secondary'}>
            {describeKind(row)}
          </Badge>
          <span className="mt-1 block text-xs text-muted-foreground">{row.note}</span>
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Where it is now',
      priority: 'secondary',
      cell: (row) => (
        <span className="block">
          <span className="block text-sm capitalize">{row.status.replace('-', ' ')}</span>
          <span className="block text-xs text-muted-foreground">
            {row.driverName ?? 'No driver yet'} · ready {formatDate(row.readyDate)}
          </span>
        </span>
      ),
    },
    {
      id: 'requestedAt',
      header: 'Waiting',
      priority: 'secondary',
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-2">
          <AgeBadge since={row.requestedAt} />
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatDateTime(row.requestedAt)}
          </span>
        </span>
      ),
    },
    {
      id: 'action',
      header: 'Answer',
      priority: 'secondary',
      className: 'w-52',
      cell: (row) => (
        <span className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => {
              open(row, 'actioned');
            }}
          >
            Accept
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              open(row, 'declined');
            }}
          >
            Decline
          </Button>
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Change requests"
        description="What customers have asked for on pickups already scheduled with a driver. They cannot change these themselves, so this is the only way they can reach us — every row is somebody waiting on an answer."
        badge={
          data && data.meta.total > 0 ? (
            <Badge variant="warning">{data.meta.total} waiting</Badge>
          ) : undefined
        }
      />

      <Card className="overflow-hidden p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search pickup, site, customer or who asked…"
          filters={filters}
        />

        <DataTable
          caption="Change requests raised from the customer portal"
          columns={columns}
          rows={data?.data ?? []}
          getRowId={(row) => row.id}
          isPending={isPending}
          isFetching={isFetching && !isPending}
          error={error}
          onRetry={() => void refetch()}
          isFiltered={controller.isFiltered}
          onClearFilters={controller.clearFilters}
          empty={{
            icon: InboxIcon,
            title: 'Nothing waiting on an answer',
            description: 'Every change a customer has asked for has been answered.',
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

      <Dialog
        open={deciding !== null}
        onClose={close}
        title={
          outcome === 'actioned'
            ? `Accept this change for #${String(deciding?.jobNumber ?? 0)}?`
            : `Decline this change for #${String(deciding?.jobNumber ?? 0)}?`
        }
        description={
          outcome === 'actioned'
            ? 'This records your answer and tells the customer. It does not move the pickup — do that from the job itself, so the collection window and the run stay right.'
            : 'The customer is told, and reads your reason on the pickup.'
        }
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              variant={outcome === 'declined' ? 'destructive' : 'default'}
              disabled={decide.isPending}
              onClick={() => void submit()}
            >
              {decide.isPending && <Spinner label="Saving" />}
              {outcome === 'actioned' ? (
                <CheckCircle2Icon aria-hidden />
              ) : (
                <XCircleIcon aria-hidden />
              )}
              {outcome === 'actioned' ? 'Accept request' : 'Decline request'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {deciding && (
            <p className="flex items-start gap-2 rounded-lg bg-secondary/60 p-3 text-sm">
              <CalendarSyncIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>
                <span className="block font-medium">{describeKind(deciding)}</span>
                <span className="block text-xs text-muted-foreground">
                  {deciding.requestedByName} at {deciding.accountName} — “{deciding.note}”
                </span>
              </span>
            </p>
          )}

          <Field
            id="change-request-note"
            label={outcome === 'actioned' ? 'Anything to tell them' : 'Why can it not be done?'}
            required={outcome === 'declined'}
            error={noteError ?? undefined}
            hint="The customer reads this on their pickup, and in their notification."
          >
            {(control) => (
              <Textarea
                {...control}
                rows={3}
                value={note}
                placeholder={
                  outcome === 'actioned'
                    ? 'Moved to Thursday, same driver.'
                    : 'The truck is already loaded for this run.'
                }
                onChange={(event) => {
                  setNote(event.target.value);
                  setNoteError(null);
                }}
              />
            )}
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
