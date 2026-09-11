import {
  CALL_UP_KIND_LABELS,
  CALL_UP_REVIEW_REASON_LABELS,
  CALL_UP_SOURCE_LABELS,
  CALL_UP_STATE_LABELS,
  type CallUp,
} from '@plastago/shared';
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
import { CheckCircle2Icon, RefreshCwIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn, FilterDefinition } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { PageHeader } from '@/components/page-header';
import { AgeBadge } from '@/components/queues/age-badge';
import { useCallUpReject, useCallUpRetry, useCallUps } from '@/features/queues/queries';
import { describeError } from '@/lib/error-message';
import { formatDate, formatDateTime } from '@/lib/format';

/**
 * Call-ups that arrived and could not be applied (M2.12b).
 *
 * ── Why this screen is the point of the pipeline, not an edge case ────────
 * The call-up reader is built to refuse to guess: a message naming a purchase
 * order nobody has on file is not a booking, and inventing one would put a truck
 * on a road for work that was never ordered. Every one of those refusals lands
 * here with a reason on it.
 *
 * Without this screen the refusal is worse than a guess. A builder has told us a
 * date, the system has stored it correctly, and nobody can see it — so the job
 * silently never happens and there is no trace of why. That is exactly the
 * failure the queue exists to prevent.
 *
 * ── Why retry rather than a booking form ──────────────────────────────────
 * Every reason a call-up queues is a fixable data problem OUTSIDE the message:
 * the order had not been confirmed yet, its suburb was missing from the places
 * table, two accounts shared a PO number. Once that is sorted the email is
 * perfectly good. Retrying re-decides against the world as it now is; the
 * alternative is reading a date off this row and typing it into a form, which is
 * the retyping the whole pipeline exists to remove.
 */
const FILTER_KEYS = ['state'] as const;

const STATE_FILTER: readonly FilterDefinition[] = [
  {
    key: 'state',
    label: 'State',
    allLabel: 'All call-ups',
    options: [
      { value: 'needs-review', label: CALL_UP_STATE_LABELS['needs-review'] },
      { value: 'applied', label: CALL_UP_STATE_LABELS.applied },
      { value: 'rejected', label: CALL_UP_STATE_LABELS.rejected },
    ],
  },
];

/**
 * Matt reads these by COLOUR, not by wording (24:07): *"it's in green, it's been
 * rescheduled… blue is a brand new notification. There are red ones which are
 * like job cancellations."*
 *
 * So the badge is mapped to the colours he already recognises rather than to
 * what the words would suggest — green for a reschedule reads oddly as
 * "success", and matching his mental model beats matching ours.
 */
const KIND_VARIANT = {
  new: 'default',
  reschedule: 'success',
  cancel: 'destructive',
} as const;

export function AdminQueueCallUpReviewPage(): React.JSX.Element {
  const controller = useListQuery({ filterKeys: FILTER_KEYS });

  /*
   * Defaults to what needs a human. The applied and rejected history is one
   * filter away, because *"when did that job get moved, and who moved it?"* is
   * a question this is the only record of.
   */
  const state = (controller.filters.state ?? 'needs-review') as
    | 'needs-review'
    | 'applied'
    | 'rejected'
    | undefined;

  const { data, error, isPending, isFetching, refetch } = useCallUps({
    ...controller.query,
    state: controller.filters.state === 'all' ? undefined : state,
  });

  const retry = useCallUpRetry();
  const reject = useCallUpReject();
  const toast = useToast();

  const [rejecting, setRejecting] = useState<CallUp | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);

  const runRetry = async (row: CallUp): Promise<void> => {
    try {
      const outcome = await retry.mutateAsync(row.id);

      /*
       * A retry can fail for a NEW reason — the order now exists but its suburb
       * is not serviced. Reporting "still needs review" with that reason is the
       * difference between one more fix and somebody retrying in a loop.
       */
      if (outcome.state === 'applied') {
        toast.success(
          `Booked as job #${String(outcome.jobNumber ?? 0)}`,
          `PO ${row.poNumber} is on the board.`,
        );
      } else {
        toast.info(
          'Still needs review',
          outcome.reason ? CALL_UP_REVIEW_REASON_LABELS[outcome.reason] : 'Nothing changed.',
        );
      }
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const runReject = async (): Promise<void> => {
    if (!rejecting) return;

    if (note.trim() === '') {
      setNoteError('Say why, in a few words.');
      return;
    }

    try {
      await reject.mutateAsync({ id: rejecting.id, note: note.trim() });
      toast.success('Set aside', `PO ${rejecting.poNumber} will not be booked from this message.`);
      setRejecting(null);
      setNote('');
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const columns: readonly DataTableColumn<CallUp>[] = [
    {
      id: 'poNumber',
      header: 'Purchase order',
      priority: 'primary',
      cell: (row) => (
        <span className="block">
          <span className="font-mono font-medium">{row.poNumber}</span>
          <span className="block text-xs text-muted-foreground">
            {/* Null on an unmatched call-up — the number is all we have. */}
            {row.accountName ?? 'No matching account'}
          </span>
        </span>
      ),
    },
    {
      id: 'kind',
      header: 'Notice',
      priority: 'primary',
      cell: (row) => (
        <span className="block">
          <Badge variant={KIND_VARIANT[row.kind]}>{CALL_UP_KIND_LABELS[row.kind]}</Badge>
          <span className="mt-1 block text-xs text-muted-foreground">
            {CALL_UP_SOURCE_LABELS[row.source]}
          </span>
        </span>
      ),
    },
    {
      id: 'date',
      header: 'Date asked for',
      priority: 'detail',
      cell: (row) => (
        <span className="block">
          {/* A cancellation names no date, and null is not "today". */}
          <span className="block text-sm">
            {row.readyDate === null ? '—' : formatDate(row.readyDate)}
          </span>
          {row.previousReadyDate !== null && (
            <span className="block text-xs text-muted-foreground">
              was {formatDate(row.previousReadyDate)}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'reason',
      header: 'Why it is here',
      priority: 'detail',
      cell: (row) => (
        <span className="block">
          <span className="block text-sm">
            {row.reason === null ? '—' : CALL_UP_REVIEW_REASON_LABELS[row.reason]}
          </span>
          {row.note !== '' && (
            <span className="block truncate text-xs text-muted-foreground" title={row.note}>
              {row.note}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'outcome',
      header: 'Outcome',
      priority: 'detail',
      cell: (row) =>
        row.jobNumber === null ? (
          <span className="text-xs text-muted-foreground">
            {CALL_UP_STATE_LABELS[row.state]}
          </span>
        ) : (
          <Link
            to={`/admin/jobs/${row.jobId ?? ''}`}
            className="focus-ring rounded font-mono text-xs text-primary underline-offset-4 hover:underline"
          >
            job #{row.jobNumber}
          </Link>
        ),
    },
    {
      id: 'received',
      header: 'Arrived',
      priority: 'detail',
      cell: (row) => (
        <span className="block">
          <AgeBadge since={row.receivedAt} />
          <span className="block text-xs text-muted-foreground">
            {formatDateTime(row.receivedAt)}
          </span>
        </span>
      ),
    },
    {
      id: 'actions',
      header: '',
      priority: 'primary',
      cell: (row) =>
        /*
         * An applied call-up has already produced or moved a job. Retrying would
         * book a second one, so the actions are simply absent rather than
         * present-and-refused.
         */
        row.state === 'needs-review' ? (
          <span className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={retry.isPending}
              onClick={() => void runRetry(row)}
            >
              <RefreshCwIcon aria-hidden className="size-4" />
              Try again
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setRejecting(row);
                setNote('');
                setNoteError(null);
              }}
            >
              <XIcon aria-hidden className="size-4" />
              Set aside
            </Button>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {row.resolvedBy === null ? '—' : row.resolvedBy}
          </span>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Call-ups to check"
        description="Dates builders have sent us that the system could not act on by itself. Fix what is missing — usually the purchase order or its suburb — then try again."
      />

      <Card className="p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search PO number or customer…"
          filters={STATE_FILTER}
        />

        <DataTable
          caption="Call-ups needing review"
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
            icon: CheckCircle2Icon,
            title: 'Nothing to check',
            description:
              'Every call-up that has arrived was applied on its own. Anything the system cannot match will appear here.',
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
        open={rejecting !== null}
        onClose={() => setRejecting(null)}
        title={rejecting ? `Set aside PO ${rejecting.poNumber}?` : 'Set aside'}
        description="The message stays on file — this records that no job will come from it."
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setRejecting(null)}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void runReject()} disabled={reject.isPending}>
              {reject.isPending ? <Spinner label="Saving" /> : <XIcon aria-hidden />}
              Set aside
            </Button>
          </>
        }
      >
        <Field
          id="call-up-reject-note"
          label="Why?"
          required
          error={noteError ?? undefined}
          hint="“Not a call-up”, “builder cancelled this months ago” — whatever the next person needs."
        >
          {(control) => (
            <Textarea
              {...control}
              rows={3}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
                setNoteError(null);
              }}
            />
          )}
        </Field>
      </Dialog>
    </div>
  );
}
