import {
  EXCEPTION_REASONS,
  EXCEPTION_REASON_LABELS,
  FUTILE_OUTCOME_LABELS,
  ZONES,
  ZONE_LABELS,
  type ExceptionReason,
  type FutileReviewItem,
} from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  Input,
  Pagination,
  Select,
  Spinner,
  Textarea,
  useToast,
} from '@plastago/ui';
import { CalendarClockIcon, CheckCircle2Icon, MapPinIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn, FilterDefinition } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { DetailList } from '@/components/detail-list';
import { PageHeader } from '@/components/page-header';
import { AgeBadge } from '@/components/queues/age-badge';
import { EvidenceGrid } from '@/components/queues/evidence-grid';
import { useAccountOptions, useDriverOptions } from '@/features/lookups/queries';
import { useFutileDecide, useFutileList, useFutileReview } from '@/features/queues/queries';
import { describeError } from '@/lib/error-message';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { useNow } from '@/lib/use-now';

/**
 * Futile pickup review (M2.6) — their #4 daily screen.
 *
 * ── The one thing this screen must get right ──────────────────────────────
 * **Both outcomes charge the $120.** Matt was unambiguous, and it is the fact
 * most likely to be softened by a well-meaning UI: a "Cancel job" button that
 * looks like a refund, or a fee shown only on the reschedule path. So the fee is
 * stated in the header, on every row, and again inside the decision dialog above
 * both buttons — never as a consequence the user discovers afterwards.
 *
 * ── Why the default sort is oldest-first ──────────────────────────────────
 * Every other grid in this console is newest-first. This one is not, because the
 * queue's failure mode is age: TransVirtual has this exact screen today and one
 * entry has sat on it since 28 August 2025. Newest-first would put that entry on
 * the last page, which is precisely how it got there.
 */
const FILTER_KEYS = ['outcome', 'reason', 'account', 'driver', 'zone', 'age'] as const;

const STATIC_FILTERS: readonly FilterDefinition[] = [
  {
    key: 'outcome',
    label: 'Decision',
    allLabel: 'Actioned and not',
    options: [
      { value: 'pending', label: 'Awaiting decision' },
      { value: 'rescheduled', label: 'Rescheduled' },
      { value: 'cancelled', label: 'Cancelled' },
    ],
  },
  {
    key: 'reason',
    label: 'Reason',
    allLabel: 'Any reason',
    options: EXCEPTION_REASONS.map((reason) => ({
      value: reason,
      label: EXCEPTION_REASON_LABELS[reason],
    })),
  },
  {
    key: 'zone',
    label: 'Zone',
    allLabel: 'All zones',
    options: ZONES.map((zone) => ({ value: zone, label: ZONE_LABELS[zone] })),
  },
  {
    key: 'age',
    label: 'Waiting',
    allLabel: 'Any age',
    options: [
      { value: 'today', label: 'Today' },
      { value: 'this-week', label: 'This week' },
      { value: 'over-week', label: 'More than a week' },
      { value: 'over-month', label: 'More than a month' },
    ],
  },
];

export function AdminQueueFutilePage() {
  const toast = useToast();
  const controller = useListQuery({ filterKeys: FILTER_KEYS });
  const { data, error, isPending, isFetching, refetch } = useFutileList(controller.query);
  const accounts = useAccountOptions();
  const drivers = useDriverOptions();

  const [reviewingId, setReviewingId] = useState<string | null>(null);

  const filters: readonly FilterDefinition[] = [
    ...STATIC_FILTERS,
    { key: 'account', label: 'Customer', allLabel: 'All customers', options: accounts.data ?? [] },
    { key: 'driver', label: 'Driver', allLabel: 'All drivers', options: drivers.data ?? [] },
  ];

  const columns: readonly DataTableColumn<FutileReviewItem>[] = [
    {
      id: 'jobNumber',
      header: 'Job',
      sortKey: 'jobNumber',
      priority: 'primary',
      cell: (row) => (
        <span className="block">
          <Link
            to={`/admin/jobs/${row.jobId}`}
            className="focus-ring rounded font-mono font-medium text-primary underline-offset-4 hover:underline"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            #{row.jobNumber}
          </Link>
          <span className="block text-xs text-muted-foreground">{row.accountName}</span>
        </span>
      ),
    },
    {
      id: 'site',
      header: 'Site',
      priority: 'detail',
      cell: (row) => (
        <span className="block">
          <span className="block">{row.siteName}</span>
          <span className="block text-xs text-muted-foreground">
            {row.suburb} · {row.builderName}
          </span>
        </span>
      ),
    },
    {
      id: 'reason',
      header: 'Reason',
      priority: 'secondary',
      cell: (row) => (
        <span className="block">
          <Badge variant="outline">{EXCEPTION_REASON_LABELS[row.reason]}</Badge>
          {row.photoCount > 0 && (
            <span className="mt-1 block text-xs text-muted-foreground">
              {row.photoCount} photo{row.photoCount === 1 ? '' : 's'}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'driverName',
      header: 'Driver',
      sortKey: 'driverName',
      priority: 'detail',
      cell: (row) => row.driverName ?? <span className="text-muted-foreground">Unassigned</span>,
    },
    {
      id: 'markedAt',
      header: 'Marked futile',
      sortKey: 'markedAt',
      priority: 'secondary',
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-2">
          <AgeBadge since={row.markedAt} muted={row.outcome !== 'pending'} />
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatDateTime(row.markedAt)}
          </span>
        </span>
      ),
    },
    {
      id: 'feeExGst',
      header: 'Fee',
      numeric: true,
      priority: 'detail',
      cell: (row) => formatMoney(row.feeExGst),
    },
    {
      id: 'action',
      header: 'Decision',
      priority: 'secondary',
      className: 'w-40',
      cell: (row) =>
        row.outcome === 'pending' ? (
          <Button
            size="sm"
            onClick={() => {
              setReviewingId(row.id);
            }}
          >
            Review
          </Button>
        ) : (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <CheckCircle2Icon aria-hidden className="size-3.5 text-success" />
            {FUTILE_OUTCOME_LABELS[row.outcome]}
          </span>
        ),
    },
  ];

  const pending = data?.data.filter((row) => row.outcome === 'pending').length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Futile review"
        description="Every pickup a driver could not complete lands here with its reason, photos and GPS fix. Reschedule it or cancel it — the $120 futile fee applies either way."
        badge={
          data && data.meta.total > 0 ? (
            <Badge variant={pending > 0 ? 'warning' : 'secondary'}>
              {data.meta.total} in queue
            </Badge>
          ) : undefined
        }
      />

      <Card className="overflow-hidden p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search job number, customer, site or driver…"
          filters={filters}
        />

        <DataTable
          caption="Futile pickups awaiting review"
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
            title: 'Nothing waiting',
            description:
              'Every futile pickup has been actioned. This is what the queue should look like.',
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

      <Alert variant="info" title="Why the fee applies either way">
        The truck was dispatched, the driver attended, and the slot is gone. Rescheduling books a
        new pickup; cancelling closes the job. Neither reverses the cost that has already been
        incurred — which is why the charge is raised at the moment the driver marks it, not at the
        moment the office decides.
      </Alert>

      <FutileDecisionDialog
        id={reviewingId}
        onClose={() => {
          setReviewingId(null);
        }}
        onDecided={(outcome, jobNumber) => {
          setReviewingId(null);
          toast.success(
            outcome === 'rescheduled'
              ? `Job #${String(jobNumber)} rescheduled`
              : `Job #${String(jobNumber)} cancelled`,
            'The $120 futile fee stays on the job and will be invoiced with it.',
          );
        }}
      />
    </div>
  );
}

/* ── The decision ─────────────────────────────────────────────────────────── */

interface FutileDecisionDialogProps {
  id: string | null;
  onClose: () => void;
  onDecided: (outcome: 'rescheduled' | 'cancelled', jobNumber: number) => void;
}

/**
 * One dialog, two outcomes, and the evidence in front of you.
 *
 * ── Why the reason is a select and the note is optional ───────────────────
 * M2.5 is explicit: structured reason codes, never free text, *so they become
 * reportable and chargeable where the customer certified otherwise*. "14 delays:
 * 6 × site not ready" is only possible if nobody was allowed to type "site
 * wasn't ready lol". The note is the place for the detail that does not fit a
 * code, and it is genuinely optional — making it required teaches people to type
 * a full stop.
 */
function FutileDecisionDialog({ id, onClose, onDecided }: FutileDecisionDialogProps) {
  const toast = useToast();
  const { data: review, isPending, error } = useFutileReview(id ?? undefined);
  const decide = useFutileDecide();

  const [outcome, setOutcome] = useState<'rescheduled' | 'cancelled'>('rescheduled');
  const [newReadyDate, setNewReadyDate] = useState('');
  const [cancelReason, setCancelReason] = useState<ExceptionReason | ''>('');
  const [note, setNote] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Tomorrow is the earliest sensible reschedule: the truck has already been out
  // today, and a same-day rebooking is a phone call, not a queue decision.
  // `useNow` rather than a bare `Date.now()` — an impure read in a render body
  // is not React-Compiler safe, and a dialog left open past midnight would
  // otherwise keep offering yesterday's "tomorrow".
  const now = useNow(60_000);
  const earliest = new Date(now + 86_400_000).toISOString().slice(0, 10);

  const reset = () => {
    setOutcome('rescheduled');
    setNewReadyDate('');
    setCancelReason('');
    setNote('');
    setFieldError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const submit = async () => {
    if (!review) return;

    if (outcome === 'rescheduled') {
      if (!newReadyDate) {
        setFieldError('Choose the new ready date before rescheduling.');
        return;
      }
      if (newReadyDate < earliest) {
        setFieldError('The new ready date must be tomorrow or later.');
        return;
      }
    } else if (!cancelReason) {
      setFieldError('Choose a cancellation reason — cancellations are reported by reason.');
      return;
    }

    setFieldError(null);

    try {
      await decide.mutateAsync({
        id: review.id,
        decision: {
          outcome,
          newReadyDate: outcome === 'rescheduled' ? newReadyDate : null,
          cancelReason: outcome === 'cancelled' ? (cancelReason as ExceptionReason) : null,
          note: note.trim(),
        },
      });
      const jobNumber = review.jobNumber;
      reset();
      onDecided(outcome, jobNumber);
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <Dialog
      open={id !== null}
      onClose={close}
      size="lg"
      title={review ? `Futile pickup — job #${String(review.jobNumber)}` : 'Futile pickup'}
      description={
        review
          ? `${review.accountName} · ${review.siteName}, ${review.suburb}`
          : 'Loading the driver’s report…'
      }
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={decide.isPending}>
            Close
          </Button>
          <Button onClick={() => void submit()} disabled={!review || decide.isPending}>
            {decide.isPending && <Spinner label="Saving" />}
            {outcome === 'rescheduled' ? 'Reschedule pickup' : 'Cancel job'}
          </Button>
        </>
      }
    >
      {isPending && <Spinner label="Loading the driver’s report" />}

      {error !== null && error !== undefined && (
        <Alert variant="destructive" title={describeError(error).title}>
          {describeError(error).detail}
        </Alert>
      )}

      {review && (
        <div className="space-y-5">
          <DetailList
            columns={2}
            items={[
              {
                label: 'Reason given',
                value: <Badge variant="outline">{EXCEPTION_REASON_LABELS[review.reason]}</Badge>,
              },
              {
                label: 'Marked futile',
                value: (
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="tabular-nums">{formatDateTime(review.markedAt)}</span>
                    <AgeBadge since={review.markedAt} />
                  </span>
                ),
              },
              { label: 'Driver', value: review.driverName ?? 'Unassigned' },
              { label: 'Original ready date', value: formatDate(review.readyDate) },
              {
                label: 'Position when marked',
                value:
                  review.latitude !== null && review.longitude !== null ? (
                    <span className="flex items-center gap-1 tabular-nums">
                      <MapPinIcon aria-hidden className="size-3.5 text-muted-foreground" />
                      {review.latitude.toFixed(4)}, {review.longitude.toFixed(4)}
                    </span>
                  ) : (
                    'Not captured'
                  ),
              },
              { label: 'Futile fee', value: formatMoney(review.feeExGst) },
              ...(review.note
                ? [{ label: 'Driver’s note', value: review.note, wide: true as const }]
                : []),
            ]}
          />

          <div>
            <h3 className="mb-2 text-sm font-semibold">Evidence from site</h3>
            <EvidenceGrid photos={review.photos} />
          </div>

          {review.outcome !== 'pending' ? (
            <Alert
              variant="info"
              title={`Already ${FUTILE_OUTCOME_LABELS[review.outcome].toLowerCase()}`}
            >
              {review.decidedBy} actioned this on {formatDateTime(review.decidedAt)}.
              {review.decisionNote ? ` “${review.decisionNote}”` : ''}
            </Alert>
          ) : (
            <div className="space-y-4 rounded-lg border border-border p-4">
              <Alert variant="warning" title="The $120 futile fee applies either way">
                Rescheduling books a new pickup. Cancelling closes the job. Neither removes the
                charge — the truck already attended.
              </Alert>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">What happens to this job?</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  <OutcomeChoice
                    checked={outcome === 'rescheduled'}
                    onChange={() => {
                      setOutcome('rescheduled');
                      setFieldError(null);
                    }}
                    icon={CalendarClockIcon}
                    label="Reschedule"
                    hint="Back to the board on a new ready date"
                  />
                  <OutcomeChoice
                    checked={outcome === 'cancelled'}
                    onChange={() => {
                      setOutcome('cancelled');
                      setFieldError(null);
                    }}
                    icon={TriangleAlertIcon}
                    label="Cancel"
                    hint="The job is closed and will not be re-attempted"
                  />
                </div>
              </fieldset>

              {outcome === 'rescheduled' ? (
                <Field
                  id="futile-new-date"
                  label="New ready date"
                  required
                  hint="Tomorrow at the earliest — today's run has already gone out."
                  error={fieldError ?? undefined}
                >
                  {(control) => (
                    <Input
                      {...control}
                      type="date"
                      min={earliest}
                      value={newReadyDate}
                      onChange={(event) => {
                        setNewReadyDate(event.target.value);
                        setFieldError(null);
                      }}
                    />
                  )}
                </Field>
              ) : (
                <Field
                  id="futile-cancel-reason"
                  label="Cancellation reason"
                  required
                  hint="Reported by reason at month end, so it cannot be free text."
                  error={fieldError ?? undefined}
                >
                  {(control) => (
                    <Select
                      {...control}
                      value={cancelReason}
                      onChange={(event) => {
                        setCancelReason(event.target.value as ExceptionReason);
                        setFieldError(null);
                      }}
                    >
                      <option value="">Choose a reason…</option>
                      {EXCEPTION_REASONS.map((reason) => (
                        <option key={reason} value={reason}>
                          {EXCEPTION_REASON_LABELS[reason]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}

              <Field
                id="futile-note"
                label="Note"
                hint="Optional. Anything the reason code cannot capture — who you spoke to, what they said."
              >
                {(control) => (
                  <Textarea
                    {...control}
                    rows={3}
                    maxLength={500}
                    value={note}
                    placeholder="Called Sione — board goes in Thursday, rebooked for Friday."
                    onChange={(event) => {
                      setNote(event.target.value);
                    }}
                  />
                )}
              </Field>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function OutcomeChoice({
  checked,
  onChange,
  icon: Icon,
  label,
  hint,
}: {
  checked: boolean;
  onChange: () => void;
  icon: typeof CalendarClockIcon;
  label: string;
  hint: string;
}) {
  return (
    <label
      className={`focus-within:ring-ring/50 flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors focus-within:ring-2 ${
        checked ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
      }`}
    >
      <input
        type="radio"
        name="futile-outcome"
        className="sr-only"
        checked={checked}
        onChange={onChange}
      />
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}
