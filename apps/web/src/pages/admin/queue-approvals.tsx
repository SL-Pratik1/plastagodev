import { CHARGE_CODES, CHARGE_CODE_LABELS, type ChargeApprovalItem } from '@plastago/shared';
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
 * Approving twelve routine contamination charges in one action is the job. But a
 * rejection tells a driver their charge was refused, and "you were all wrong,
 * see attached: nothing" is not a message this system should be able to send in
 * one click. Rejection is per charge and carries a required reason, because the
 * driver reads it.
 *
 * ── The commercial argument, on the screen ────────────────────────────────
 * ~2 contamination charges a week at $90 is ~$9k a year moving through here, and
 * several are currently weeks old. So the header shows what is sitting in the
 * queue in dollars, not just in rows — a count of 14 does not make anyone open
 * it, and $1,260 does.
 */
const FILTER_KEYS = ['code', 'account', 'driver', 'po', 'evidence', 'age'] as const;

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
        {row.poRequired && (
          <span className="block text-xs text-warning">Approving sends this to Awaiting PO</span>
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
  const selectedValueCents = (data?.data ?? [])
    .filter((row) => selected.includes(row.id))
    .reduce((sum, row) => sum + Math.round(Number(row.amountExGst) * 100), 0);

  const approveSelected = async () => {
    try {
      const changed = await decide.mutateAsync({
        ids: selected,
        decision: { decision: 'approve', note: '' },
      });
      toast.success(
        `${String(changed)} charge${changed === 1 ? '' : 's'} approved`,
        'Charges on PO-required accounts have moved to the Awaiting PO queue.',
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
            selected.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                {decide.isPending && <Spinner label="Working" />}
                <span className="text-xs text-muted-foreground">
                  {selected.length} selected ·{' '}
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
          empty={{
            icon: ClipboardCheckIcon,
            title: 'Nothing to approve',
            description: 'Every driver-raised charge has been actioned.',
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
        An approved charge becomes billable. On an account that requires a purchase order it moves
        to the Awaiting PO queue and is invoiced separately — it never holds up the base invoice for
        the job, which is the whole point of the two-invoice workflow.
      </Alert>

      <Dialog
        open={confirmingBulk}
        onClose={() => {
          setConfirmingBulk(false);
        }}
        title={`Approve ${String(selected.length)} charge${selected.length === 1 ? '' : 's'}?`}
        description={`${formatMoney((selectedValueCents / 100).toFixed(2))} ex GST becomes billable. Charges on PO-required accounts will move to the Awaiting PO queue rather than being invoiced now.`}
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
        onDecided={(decision, amount) => {
          setReviewingId(null);
          setSelected((current) => current.filter((id) => id !== reviewingId));
          if (decision === 'approve') {
            toast.success(
              `${formatMoney(amount)} approved`,
              'The charge is now billable on this job.',
            );
          } else {
            toast.success('Charge rejected', 'The driver will see your reason on their next sync.');
          }
        }}
      />
    </div>
  );
}

/* ── Evidence and the per-charge decision ─────────────────────────────────── */

interface ChargeEvidenceDialogProps {
  id: string | null;
  onClose: () => void;
  onDecided: (decision: 'approve' | 'reject', amountExGst: string) => void;
}

function ChargeEvidenceDialog({ id, onClose, onDecided }: ChargeEvidenceDialogProps) {
  const toast = useToast();
  const { data: charge, isPending, error } = useApprovalDetail(id ?? undefined);
  const decide = useApprovalDecide();

  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);

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
      setNoteError('Tell the driver why — they see this, and “no” on its own is not reviewable.');
      return;
    }

    try {
      await decide.mutateAsync({ ids: [charge.id], decision: { decision, note: note.trim() } });
      const amount = charge.amountExGst;
      setRejecting(false);
      setNote('');
      setNoteError(null);
      onDecided(decision, amount);
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
          {rejecting ? (
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
              Approving moves the charge to the Awaiting PO queue. It will be invoiced separately
              once the PO arrives — the base invoice for job #{charge.jobNumber} is not held up.
            </Alert>
          )}

          <div>
            <h3 className="mb-2 text-sm font-semibold">Evidence from site</h3>
            <EvidenceGrid photos={charge.photos} />
          </div>

          {rejecting && (
            <Field
              id="reject-note"
              label="Why is this being rejected?"
              required
              hint="The driver sees this on their next sync. Be specific enough that they can do it differently next time."
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
