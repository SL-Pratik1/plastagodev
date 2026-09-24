import {
  CHARGE_CODES,
  CHARGE_CODE_LABELS,
  type ChargeApprovalItem,
  type ChargeDecisionOutcome,
} from '@plastago/shared';
import {
  Alert,
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
import { CheckCircle2Icon, ClipboardCheckIcon, ImageIcon, MapPinIcon, XIcon } from 'lucide-react';
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
import { useApprovalDecide, useApprovalDetail, useApprovalList } from '@/features/queues/queries';
import { describeError } from '@/lib/error-message';
import { formatDateTime, formatMoney } from '@/lib/format';

/**
 * Additional service approvals (M2.7) — their #3 daily screen.
 *
 * ── Why bulk approve exists but bulk reject does not ──────────────────────
 * Approving twelve routine contamination charges in one action is the job.
 * Refusing twelve is not: each one overrules a driver who stood on the site and
 * photographed what they saw, and "you were all wrong" is not a judgement this
 * screen should be able to make in a single click. So a rejection is per charge
 * and carries a required reason.
 *
 * ⚠️ The reason is a RECORD, not a message. There is no driver notification
 * channel in this product — `notificationService` reaches accounts and the
 * office, and nothing else — so nobody is told automatically. The reason is
 * stored against the charge and shown on the job’s Charges tab, which is where
 * anyone asking "why was this refused?" a month later will look. Whoever
 * rejects it tells the driver themselves. The copy on this screen used to
 * promise delivery that does not happen; see the note on the field below.
 *
 * ── The commercial argument, on the screen ────────────────────────────────
 * ~2 contamination charges a week at $90 is ~$9k a year moving through here, and
 * several are currently weeks old. So the header shows what is sitting in the
 * queue in dollars, not just in rows — a count of 14 does not make anyone open
 * it, and $1,260 does.
 */
const FILTER_KEYS = [
  'code',
  'account',
  'driver',
  'po',
  'evidence',
  'age',
  'approvalState',
] as const;

const STATIC_FILTERS: readonly FilterDefinition[] = [
  {
    key: 'code',
    label: 'Charge',
    allLabel: 'Any charge',
    options: CHARGE_CODES.map((code) => ({ value: code, label: CHARGE_CODE_LABELS[code] })),
  },
  {
    key: 'po',
    label: 'PO policy',
    allLabel: 'Any policy',
    options: [
      { value: 'required', label: 'PO required to invoice' },
      { value: 'not-required', label: 'No PO needed' },
    ],
  },
  {
    key: 'evidence',
    label: 'Evidence',
    allLabel: 'With and without',
    options: [
      { value: 'with-photos', label: 'Has photos' },
      { value: 'no-photos', label: 'No photos' },
    ],
  },
  /*
   * ── The decision, which this queue had no way to ask about ──────────────
   * Approving a charge removed it from the only screen that lists charges, so
   * "what did we approve this week, and on what evidence?" could not be
   * answered from the queue that approved it — and that question gets asked
   * when a builder is disputing money already committed.
   *
   * ⚠️ `allLabel` is NOT "any": leaving this filter alone means `pending`, not
   * everything. The queue is a worklist first and the nav badge counts pending,
   * so a default of "all" would put decided rows into a table that offers bulk
   * approve. "Actioned and not" is the explicit opt-in.
   */
  {
    key: 'approvalState',
    label: 'Decision',
    allLabel: 'Awaiting decision',
    options: [
      { value: 'any', label: 'Actioned and not' },
      { value: 'approved', label: 'Approved' },
      { value: 'rejected', label: 'Rejected' },
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
      { value: 'over-month', label: 'More than a month' },
    ],
  },
];

const COLUMNS: readonly DataTableColumn<ChargeApprovalItem>[] = [
  {
    id: 'description',
    header: 'Charge',
    priority: 'primary',
    cell: (row) => (
      <span className="block">
        <span className="block font-medium">{CHARGE_CODE_LABELS[row.code]}</span>
        <span className="block text-xs text-muted-foreground">{row.description}</span>
      </span>
    ),
  },
  {
    id: 'jobNumber',
    header: 'Job',
    sortKey: 'jobNumber',
    priority: 'detail',
    cell: (row) => (
      <span className="block">
        <Link
          to={`/admin/jobs/${row.jobId}`}
          className="focus-ring rounded font-mono text-primary underline-offset-4 hover:underline"
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
    sortKey: 'accountName',
    priority: 'detail',
    cell: (row) => (
      <span className="block">
        <span className="block">{row.accountName}</span>
        {/*
          Only a finished job is invoiced on approval, so only there is Awaiting
          PO the next stop. This said so on every row, including jobs still on
          a truck, where approving puts nothing in the queue yet.
        */}
        {row.poRequired && (
          <span className="block text-xs text-warning">
            {row.jobFinished
              ? 'Approving sends this to Awaiting PO'
              : 'Goes to Awaiting PO when the job is invoiced'}
          </span>
        )}
      </span>
    ),
  },
  {
    id: 'raisedBy',
    header: 'Raised by',
    priority: 'secondary',
    cell: (row) => (
      <span className="block">
        <span className="block text-sm">{row.raisedBy ?? 'System'}</span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {row.photoCount > 0 ? (
            <>
              <ImageIcon aria-hidden className="size-3" />
              {row.photoCount} photo{row.photoCount === 1 ? '' : 's'}
            </>
          ) : (
            'No evidence attached'
          )}
        </span>
      </span>
    ),
  },
  {
    id: 'raisedAt',
    header: 'Waiting',
    sortKey: 'raisedAt',
    priority: 'secondary',
    cell: (row) => (
      <span className="flex flex-wrap items-center gap-2">
        <AgeBadge since={row.raisedAt} />
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatDateTime(row.raisedAt)}
        </span>
      </span>
    ),
  },
  /*
   * Only meaningful once the Decision filter is off "Awaiting decision" — but
   * shown always rather than conditionally, because a column that appears and
   * disappears moves every other column under the reader's cursor. A pending
   * row simply says so.
   */
  {
    id: 'approvalState',
    header: 'Decision',
    priority: 'secondary',
    cell: (row) =>
      row.approvalState === 'pending' ? (
        <span className="text-xs text-muted-foreground">Awaiting decision</span>
      ) : (
        <Badge variant={row.approvalState === 'approved' ? 'success' : 'destructive'}>
          {row.approvalState === 'approved' ? 'Approved' : 'Rejected'}
        </Badge>
      ),
  },
  {
    id: 'amountExGst',
    header: 'Amount ex GST',
    sortKey: 'amountExGst',
    numeric: true,
    priority: 'secondary',
    cell: (row) => formatMoney(row.amountExGst),
  },
];

export function AdminQueueApprovalsPage() {
  const toast = useToast();
  const controller = useListQuery({ filterKeys: FILTER_KEYS, defaultPageSize: 20 });
  const { data, error, isPending, isFetching, refetch } = useApprovalList(controller.query);
  const accounts = useAccountOptions();
  const drivers = useDriverOptions();

  const [selected, setSelected] = useState<string[]>([]);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [confirmingBulk, setConfirmingBulk] = useState(false);

  const decide = useApprovalDecide();

  const filters: readonly FilterDefinition[] = [
    ...STATIC_FILTERS,
    { key: 'account', label: 'Customer', allLabel: 'All customers', options: accounts.data ?? [] },
    { key: 'driver', label: 'Raised by', allLabel: 'Anyone', options: drivers.data ?? [] },
  ];

  // Money on the visible page. Deliberately not the whole queue: the service
  // returns one page, and a total that silently covered rows the user cannot see
  // would be a different number every time they paged.
  const pageValueCents = (data?.data ?? []).reduce(
    (sum, row) => sum + Math.round(Number(row.amountExGst) * 100),
    0,
  );
  /*
   * ── Only pending rows can be bulk-approved ──────────────────────────────
   * With the Decision filter set to "Actioned and not", the table can hold rows
   * that were decided weeks ago. Select-all then covers them, and the button
   * would ask the server to approve charges that are already approved.
   *
   * The API refuses them anyway — `approvalState: 'pending'` is part of its
   * filter, which is why it answers with a COUNT rather than throwing — so this
   * is not what keeps the data right. It is what stops the office being told
   * "12 charges approved" when four of them were somebody else's decision from
   * last month, and stops the total beside the button counting money nobody is
   * about to commit.
   */
  const rows = data?.data ?? [];
  const pendingSelected = selected.filter((id) =>
    rows.some((row) => row.id === id && row.approvalState === 'pending'),
  );

  const selectedValueCents = rows
    .filter((row) => pendingSelected.includes(row.id))
    .reduce((sum, row) => sum + Math.round(Number(row.amountExGst) * 100), 0);

  const approveSelected = async () => {
    try {
      const outcome = await decide.mutateAsync({
        ids: pendingSelected,
        decision: { decision: 'approve', note: '' },
      });
      announceApproval(
        toast,
        `${String(outcome.changed)} charge${outcome.changed === 1 ? '' : 's'} approved`,
        outcome,
      );
      setSelected([]);
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    } finally {
      setConfirmingBulk(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Approvals"
        description="Charges raised on site by drivers — contamination, extra load time — with their photo evidence. Nothing here can be invoiced until it is approved."
        badge={
          data && data.meta.total > 0 ? (
            <Badge variant="warning">{data.meta.total} awaiting approval</Badge>
          ) : undefined
        }
      />

      <Card className="overflow-hidden p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search job number, customer, site or driver…"
          filters={filters}
          actions={
            pendingSelected.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                {decide.isPending && <Spinner label="Working" />}
                <span className="text-xs text-muted-foreground">
                  {pendingSelected.length} selected ·{' '}
                  <span className="font-medium text-foreground tabular-nums">
                    {formatMoney((selectedValueCents / 100).toFixed(2))}
                  </span>
                </span>
                <Button
                  size="sm"
                  disabled={decide.isPending}
                  onClick={() => {
                    setConfirmingBulk(true);
                  }}
                >
                  <CheckCircle2Icon aria-hidden />
                  Approve
                </Button>
              </div>
            ) : data && data.meta.total > 0 ? (
              <span className="text-xs text-muted-foreground">
                {formatMoney((pageValueCents / 100).toFixed(2))} ex GST on this page
              </span>
            ) : undefined
          }
        />

        <DataTable
          caption="Charges awaiting office approval"
          columns={[
            ...COLUMNS,
            {
              id: 'action',
              header: 'Review',
              priority: 'secondary',
              className: 'w-28',
              cell: (row) => (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setReviewingId(row.id);
                  }}
                >
                  Evidence
                </Button>
              ),
            },
          ]}
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
          selectedIds={selected}
          onSelectionChange={setSelected}
          /*
           * The copy follows the filter. "Every driver-raised charge has been
           * actioned" is true of an empty pending queue and a lie on an empty
           * "Rejected" view — where it would tell the office nothing was ever
           * refused, on a screen that is only showing refusals.
           */
          empty={{
            icon: ClipboardCheckIcon,
            title:
              controller.query.filters?.approvalState === undefined
                ? 'Nothing to approve'
                : 'Nothing matches that filter',
            description:
              controller.query.filters?.approvalState === undefined
                ? 'Every driver-raised charge has been actioned.'
                : 'No charges here with that decision. Try "Actioned and not".',
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

      <Alert variant="info" title="What approving actually does">
        An approved charge on a finished job is invoiced straight away. On an account that requires
        a purchase order it goes on its own invoice in the Awaiting PO queue — it never holds up the
        base invoice for the job, which is the whole point of the two-invoice workflow. Otherwise it
        joins the job’s invoice, ready to send. A job still under way is billed when it is invoiced.
      </Alert>

      <Dialog
        open={confirmingBulk}
        onClose={() => {
          setConfirmingBulk(false);
        }}
        title={`Approve ${String(pendingSelected.length)} charge${pendingSelected.length === 1 ? '' : 's'}?`}
        description={`${formatMoney((selectedValueCents / 100).toFixed(2))} ex GST becomes billable. Finished jobs are invoiced now — charges on PO-required accounts go to the Awaiting PO queue.`}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmingBulk(false);
              }}
              disabled={decide.isPending}
            >
              Cancel
            </Button>
            <Button onClick={() => void approveSelected()} disabled={decide.isPending}>
              {decide.isPending && <Spinner label="Approving" />}
              Approve charges
            </Button>
          </>
        }
      />

      <ChargeEvidenceDialog
        id={reviewingId}
        onClose={() => {
          setReviewingId(null);
        }}
        onDecided={(decision, amount, outcome) => {
          setReviewingId(null);
          setSelected((current) => current.filter((id) => id !== reviewingId));
          if (decision === 'approve') {
            announceApproval(toast, `${formatMoney(amount)} approved`, outcome);
          } else {
            toast.success(
              'Charge rejected',
              'Your reason is saved on the job. Let the driver know.',
            );
          }
        }}
      />
    </div>
  );
}

/**
 * Says where an approval's money went.
 *
 * ── Why the toast names invoices ──────────────────────────────────────────
 * It used to announce that charges "have moved to the Awaiting PO queue"
 * whatever had happened — and nothing had moved: approving flipped a flag, and
 * the charge dropped out of every list. Approving now bills, and the office is
 * told what it produced: which invoice, and whether it waits on a PO. A charge
 * that could not be billed yet is said plainly, as a warning rather than a
 * success, because that is money somebody still has to act on.
 */
function announceApproval(
  toast: ReturnType<typeof useToast>,
  title: string,
  outcome: ChargeDecisionOutcome,
): void {
  const lines = outcome.invoices.map((invoice) => {
    const where =
      invoice.status === 'awaiting-po'
        ? 'waiting for a PO in Awaiting PO'
        : 'ready to send from Invoices';
    return invoice.change === 'created'
      ? `Invoice #${String(invoice.invoiceNumber)} raised for job #${String(invoice.jobNumber)} — ${where}.`
      : `Added to invoice #${String(invoice.invoiceNumber)} for job #${String(invoice.jobNumber)} — ${where}.`;
  });

  if (outcome.awaitingJobCompletion.length > 0) {
    const jobs = outcome.awaitingJobCompletion
      .map((jobNumber) => `#${String(jobNumber)}`)
      .join(', ');
    lines.push(
      `Job ${jobs} ${outcome.awaitingJobCompletion.length === 1 ? 'is' : 'are'} still under way — billed when invoiced.`,
    );
  }

  const failures = outcome.notInvoiced.map(
    (miss) => `Job #${String(miss.jobNumber)}: ${miss.reason}`,
  );

  // Three lines is what fits in a toast; the rest are on the Invoices screen.
  const shown = [...failures, ...lines];
  const detail =
    shown.length > 3
      ? `${shown.slice(0, 3).join(' ')} And ${String(shown.length - 3)} more.`
      : shown.join(' ') || 'The charge is now billable on this job.';

  if (failures.length > 0) toast.warning(title, detail);
  else toast.success(title, detail);
}

/* ── Evidence and the per-charge decision ─────────────────────────────────── */

interface ChargeEvidenceDialogProps {
  id: string | null;
  onClose: () => void;
  onDecided: (
    decision: 'approve' | 'reject',
    amountExGst: string,
    outcome: ChargeDecisionOutcome,
  ) => void;
}

function ChargeEvidenceDialog({ id, onClose, onDecided }: ChargeEvidenceDialogProps) {
  const toast = useToast();
  const { data: charge, isPending, error, refetch } = useApprovalDetail(id ?? undefined);
  const decide = useApprovalDecide();

  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);

  /*
   * The Decision filter makes approved and rejected charges openable, and the
   * dialog offered Approve and Reject on them anyway — the server then refused
   * with a 409 that never said the charge had already been decided. A decided
   * charge is shown as such, with nothing left to press.
   */
  const decided = charge !== undefined && charge.approvalState !== 'pending';

  const close = () => {
    setRejecting(false);
    setNote('');
    setNoteError(null);
    onClose();
  };

  const run = async (decision: 'approve' | 'reject') => {
    if (!charge) return;

    // A rejection is a message to a person. An empty one is worse than none.
    if (decision === 'reject' && note.trim().length < 5) {
      setNoteError(
        'Say why — this is the only record of the decision, and “no” on its own is not reviewable.',
      );
      return;
    }

    try {
      const outcome = await decide.mutateAsync({
        ids: [charge.id],
        decision: { decision, note: note.trim() },
      });
      const amount = charge.amountExGst;
      setRejecting(false);
      setNote('');
      setNoteError(null);
      onDecided(decision, amount, outcome);
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
      title={charge ? CHARGE_CODE_LABELS[charge.code] : 'Charge'}
      description={
        charge
          ? `${formatMoney(charge.amountExGst)} ex GST · job #${String(charge.jobNumber)} · ${charge.accountName}`
          : 'Loading the driver’s evidence…'
      }
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={decide.isPending}>
            Close
          </Button>
          {decided ? null : rejecting ? (
            <Button
              variant="destructive"
              onClick={() => void run('reject')}
              disabled={!charge || decide.isPending}
            >
              {decide.isPending && <Spinner label="Rejecting" />}
              Reject charge
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setRejecting(true);
                }}
                disabled={!charge || decide.isPending}
              >
                <XIcon aria-hidden />
                Reject
              </Button>
              <Button onClick={() => void run('approve')} disabled={!charge || decide.isPending}>
                {decide.isPending && <Spinner label="Approving" />}
                <CheckCircle2Icon aria-hidden />
                Approve
              </Button>
            </>
          )}
        </>
      }
    >
      {isPending && <Spinner label="Loading evidence" />}

      {error !== null && error !== undefined && (
        <Alert variant="destructive" title={describeError(error).title}>
          {describeError(error).detail}
        </Alert>
      )}

      {charge && (
        <div className="space-y-5">
          {decided && (
            <Alert
              variant="info"
              title={
                charge.approvalState === 'rejected'
                  ? 'Already rejected'
                  : charge.approvalState === 'approved'
                    ? 'Already approved'
                    : 'Does not need approval'
              }
            >
              Nothing left to decide here. The decision and its reason are on{' '}
              <Link
                to={`/admin/jobs/${charge.jobId}?tab=charges`}
                className="font-medium underline underline-offset-4"
              >
                job #{charge.jobNumber}&rsquo;s Charges tab
              </Link>
              .
            </Alert>
          )}

          <DetailList
            columns={2}
            items={[
              { label: 'Description', value: charge.description, wide: true },
              {
                label: 'Quantity × rate',
                value: `${String(charge.quantity)} × ${formatMoney(charge.unitRate)}`,
              },
              { label: 'Amount ex GST', value: formatMoney(charge.amountExGst) },
              { label: 'Raised by', value: charge.raisedBy ?? 'System' },
              {
                label: 'Raised',
                value: (
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="tabular-nums">{formatDateTime(charge.raisedAt)}</span>
                    <AgeBadge since={charge.raisedAt} />
                  </span>
                ),
              },
              { label: 'Site', value: `${charge.siteName}, ${charge.suburb}` },
              {
                label: 'On-site duration',
                value:
                  charge.onSiteMinutes === null
                    ? 'Not recorded'
                    : `${String(charge.onSiteMinutes)} minutes`,
              },
              {
                label: 'Position when raised',
                value:
                  charge.latitude !== null && charge.longitude !== null ? (
                    <span className="flex items-center gap-1 tabular-nums">
                      <MapPinIcon aria-hidden className="size-3.5 text-muted-foreground" />
                      {charge.latitude.toFixed(4)}, {charge.longitude.toFixed(4)}
                    </span>
                  ) : (
                    'Not captured'
                  ),
              },
              ...(charge.note
                ? [{ label: 'Driver’s note', value: charge.note, wide: true as const }]
                : []),
            ]}
          />

          {charge.poRequired && (
            <Alert variant="warning" title="This account requires a purchase order">
              {charge.jobFinished ? (
                <>
                  Approving puts the charge on its own invoice in the Awaiting PO queue. It is sent
                  once the PO arrives — the base invoice for job #{charge.jobNumber} is not held up.
                </>
              ) : (
                <>
                  Job #{charge.jobNumber} is still under way, so approving does not invoice it yet.
                  It goes to the Awaiting PO queue when the job is invoiced.
                </>
              )}
            </Alert>
          )}

          <div>
            <h3 className="mb-2 text-sm font-semibold">Evidence from site</h3>
            <EvidenceGrid photos={charge.photos} onStale={refetch} />
          </div>

          {rejecting && (
            <Field
              id="reject-note"
              label="Why is this being rejected?"
              required
              // Not "the driver sees this" — they do not. Nothing is sent to a
              // driver anywhere in this product. Saying so here would be a promise
              // the system cannot keep, and the office would stop repeating it in
              // person believing the app had.
              hint="Saved against the charge and shown on the job, so the decision can be explained later. The driver is not notified — tell them yourself."
              error={noteError ?? undefined}
            >
              {(control) => (
                <Textarea
                  {...control}
                  rows={3}
                  maxLength={500}
                  value={note}
                  placeholder="Photos show clean board — no contamination visible in the bag."
                  onChange={(event) => {
                    setNote(event.target.value);
                    setNoteError(null);
                  }}
                />
              )}
            </Field>
          )}
        </div>
      )}
    </Dialog>
  );
}
