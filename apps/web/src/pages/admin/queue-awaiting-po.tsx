import type { AwaitingPoItem } from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  Input,
  Pagination,
  Spinner,
  useToast,
} from '@plastago/ui';
import { CheckCircle2Icon, MailIcon, SendIcon, WalletIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn, FilterDefinition } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { PageHeader } from '@/components/page-header';
import { AgeBadge } from '@/components/queues/age-badge';
import { useRecordPo } from '@/features/invoices/queries';
import { useAccountOptions } from '@/features/lookups/queries';
import { useAwaitingPoChase, useAwaitingPoList } from '@/features/queues/queries';
import { describeError } from '@/lib/error-message';
import { formatDateTime, formatMoney, formatRelative } from '@/lib/format';

/**
 * Approved charges awaiting a purchase order (M7.3).
 *
 * ── This is the workflow that does not exist today ────────────────────────
 * M7.3's own words: *"the workflow that doesn't exist today, and where money
 * currently leaks."* Charges get approved, the account requires a PO, and then
 * nothing happens — nobody owns the asking. So this screen is built around the
 * asking rather than around the invoice:
 *
 *  • **Who to chase and how** is a column, not something to go and look up.
 *  • **Chase count and last-chased** are recorded, so "I'll ring them" becomes a
 *    fact rather than an intention.
 *  • **Never-chased sorts above oldest.** Money nobody has asked for yet is the
 *    most recoverable money in the queue.
 *
 * ── Recording the PO uses the invoice service, not a queue mutation ───────
 * There is one write path for "this invoice now has a PO". A second one here
 * would be a second thing for the backend to keep consistent.
 */
const FILTER_KEYS = ['account', 'chased', 'age'] as const;

const STATIC_FILTERS: readonly FilterDefinition[] = [
  {
    key: 'chased',
    label: 'Chased',
    allLabel: 'Chased and not',
    options: [
      { value: 'no', label: 'Never chased' },
      { value: 'yes', label: 'Already chased' },
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

export function AdminQueueAwaitingPoPage() {
  const toast = useToast();
  const controller = useListQuery({ filterKeys: FILTER_KEYS });
  const { data, error, isPending, isFetching, refetch } = useAwaitingPoList(controller.query);
  const accounts = useAccountOptions();

  const [selected, setSelected] = useState<string[]>([]);
  const [confirmingChase, setConfirmingChase] = useState(false);
  const [recordingPoFor, setRecordingPoFor] = useState<AwaitingPoItem | null>(null);

  const chase = useAwaitingPoChase();

  const filters: readonly FilterDefinition[] = [
    ...STATIC_FILTERS,
    { key: 'account', label: 'Customer', allLabel: 'All customers', options: accounts.data ?? [] },
  ];

  const pageValueCents = (data?.data ?? []).reduce(
    (sum, row) => sum + Math.round(Number(row.totalExGst) * 100),
    0,
  );

  const runChase = async () => {
    try {
      const changed = await chase.mutateAsync(selected);
      toast.success(
        `${String(changed)} reminder${changed === 1 ? '' : 's'} sent`,
        'Emailed to each account’s billing contact and logged against the invoice.',
      );
      setSelected([]);
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    } finally {
      setConfirmingChase(false);
    }
  };

  const columns: readonly DataTableColumn<AwaitingPoItem>[] = [
    {
      id: 'invoiceNumber',
      header: 'Invoice',
      sortKey: 'invoiceNumber',
      priority: 'primary',
      cell: (row) => (
        <span className="block">
          <span className="font-mono font-medium">#{row.invoiceNumber}</span>
          <span className="block text-xs text-muted-foreground">Additional charges</span>
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
          <span className="block text-xs text-muted-foreground">{row.siteName}</span>
        </span>
      ),
    },
    {
      id: 'chargeSummary',
      header: 'What for',
      priority: 'detail',
      cell: (row) => (
        <span className="block">
          <span className="block text-sm">{row.chargeSummary}</span>
          <Link
            to={`/admin/jobs/${row.jobId}`}
            className="focus-ring rounded font-mono text-xs text-primary underline-offset-4 hover:underline"
          >
            job #{row.jobNumber}
          </Link>
        </span>
      ),
    },
    {
      id: 'contact',
      header: 'Who to chase',
      priority: 'detail',
      cell: (row) =>
        row.contactName ? (
          <span className="block">
            <span className="block text-sm">{row.contactName}</span>
            {row.contactEmail && (
              <a
                href={`mailto:${row.contactEmail}?subject=Purchase order for PlastaGo invoice ${String(row.invoiceNumber)}`}
                className="focus-ring flex items-center gap-1 rounded text-xs text-primary underline-offset-4 hover:underline"
              >
                <MailIcon aria-hidden className="size-3 shrink-0" />
                <span className="truncate">{row.contactEmail}</span>
              </a>
            )}
          </span>
        ) : (
          <span className="text-xs text-warning">No billing contact on the account</span>
        ),
    },
    {
      id: 'approvedAt',
      header: 'Waiting',
      sortKey: 'approvedAt',
      priority: 'secondary',
      cell: (row) => (
        <span className="block">
          <span className="flex flex-wrap items-center gap-2">
            <AgeBadge since={row.approvedAt} />
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatDateTime(row.approvedAt)}
            </span>
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {row.chaseCount === 0
              ? 'Never chased'
              : `Chased ${String(row.chaseCount)}× · last ${formatRelative(row.lastChasedAt)}`}
          </span>
        </span>
      ),
    },
    {
      id: 'totalExGst',
      header: 'Held ex GST',
      sortKey: 'totalExGst',
      numeric: true,
      priority: 'secondary',
      cell: (row) => formatMoney(row.totalExGst),
    },
    {
      id: 'action',
      header: 'PO',
      priority: 'secondary',
      className: 'w-32',
      cell: (row) => (
        <Button
          size="sm"
          onClick={() => {
            setRecordingPoFor(row);
          }}
        >
          Record PO
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Awaiting PO"
        description="Charges the customer has agreed to but cannot be invoiced until their purchase order arrives. Record the PO and the invoice releases."
        badge={
          data && data.meta.total > 0 ? (
            <Badge variant="warning">
              {formatMoney((pageValueCents / 100).toFixed(2))} held on this page
            </Badge>
          ) : undefined
        }
      />

      <Card className="overflow-hidden p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search invoice, job, customer or contact…"
          filters={filters}
          actions={
            selected.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                {chase.isPending && <Spinner label="Sending" />}
                <span className="text-xs text-muted-foreground">{selected.length} selected</span>
                <Button
                  size="sm"
                  disabled={chase.isPending}
                  onClick={() => {
                    setConfirmingChase(true);
                  }}
                >
                  <SendIcon aria-hidden />
                  Send reminder
                </Button>
              </div>
            ) : undefined
          }
        />

        <DataTable
          caption="Approved charges awaiting a purchase order"
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
          selectedIds={selected}
          onSelectionChange={setSelected}
          // Nobody to email means the reminder cannot go out — better to make
          // the row unselectable than to report "1 sent" and send nothing.
          selectableRow={(row) => row.contactEmail !== null}
          empty={{
            icon: CheckCircle2Icon,
            title: 'Nothing held up',
            description: 'Every approved charge either has its PO or does not need one.',
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

      <Alert variant="info" title="Why these are separate invoices">
        The base invoice for the job went out on completion against its original PO and is already
        earning. Only the additional charges — contamination, extra load time — need a second PO, so
        only they wait here. Cash for the pickup itself is never held up by a second approval.
      </Alert>

      <Dialog
        open={confirmingChase}
        onClose={() => {
          setConfirmingChase(false);
        }}
        title={`Send ${String(selected.length)} reminder${selected.length === 1 ? '' : 's'}?`}
        description="Each account’s billing contact gets an email asking for the purchase order, with the charges and the job reference. The chase is logged against the invoice."
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmingChase(false);
              }}
              disabled={chase.isPending}
            >
              Cancel
            </Button>
            <Button onClick={() => void runChase()} disabled={chase.isPending}>
              {chase.isPending && <Spinner label="Sending" />}
              Send reminders
            </Button>
          </>
        }
      />

      <RecordPoDialog
        item={recordingPoFor}
        onClose={() => {
          setRecordingPoFor(null);
        }}
        onRecorded={(invoiceNumber) => {
          setRecordingPoFor(null);
          toast.success(
            `Invoice #${String(invoiceNumber)} released`,
            'The purchase order is recorded and the invoice is ready to send.',
          );
        }}
      />
    </div>
  );
}

/* ── Recording the PO ─────────────────────────────────────────────────────── */

function RecordPoDialog({
  item,
  onClose,
  onRecorded,
}: {
  item: AwaitingPoItem | null;
  onClose: () => void;
  onRecorded: (invoiceNumber: number) => void;
}) {
  const toast = useToast();
  const recordPo = useRecordPo();
  const [poNumber, setPoNumber] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const close = () => {
    setPoNumber('');
    setFieldError(null);
    onClose();
  };

  const submit = async () => {
    if (!item) return;

    const trimmed = poNumber.trim();
    if (trimmed.length === 0) {
      setFieldError('Enter the purchase order number exactly as the customer issued it.');
      return;
    }
    if (trimmed.length > 60) {
      setFieldError('That is longer than any PO number we have seen — check for a pasted line.');
      return;
    }

    try {
      await recordPo.mutateAsync({ id: item.id, poNumber: trimmed });
      const invoiceNumber = item.invoiceNumber;
      setPoNumber('');
      setFieldError(null);
      onRecorded(invoiceNumber);
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <Dialog
      open={item !== null}
      onClose={close}
      title="Record purchase order"
      description={
        item
          ? `Invoice #${String(item.invoiceNumber)} · ${item.accountName} · ${formatMoney(item.totalIncGst)} inc GST`
          : undefined
      }
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={recordPo.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={recordPo.isPending}>
            {recordPo.isPending && <Spinner label="Saving" />}
            Record and release
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          id="po-number"
          label="Purchase order number"
          required
          hint="Copy it exactly — builders' accounts-payable systems match on it character for character."
          error={fieldError ?? undefined}
        >
          {(control) => (
            <Input
              {...control}
              value={poNumber}
              autoComplete="off"
              spellCheck={false}
              placeholder="29916613/096"
              className="font-mono"
              onChange={(event) => {
                setPoNumber(event.target.value);
                setFieldError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
              }}
            />
          )}
        </Field>

        {item && (
          <Alert variant="info" title="What this releases">
            {item.chargeSummary} on job #{item.jobNumber}. Once recorded the invoice leaves this
            queue and can be sent from the invoice list.
          </Alert>
        )}

        <p className="text-xs text-muted-foreground">
          <WalletIcon aria-hidden className="mr-1 inline size-3" />
          If the customer has emailed the PO instead, it may already be sitting in{' '}
          <Link
            to="/admin/queues/po-review"
            className="focus-ring rounded text-primary underline-offset-4 hover:underline"
          >
            PO review
          </Link>{' '}
          waiting to be matched.
        </p>
      </div>
    </Dialog>
  );
}
