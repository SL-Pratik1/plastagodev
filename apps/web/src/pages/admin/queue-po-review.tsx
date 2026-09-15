import {
  PO_REVIEW_REASONS,
  PO_REVIEW_REASON_LABELS,
  PO_REVIEW_STATE_LABELS,
  type PoExtractionItem,
  type PoReviewState,
} from '@plastago/shared';
import { Alert, Badge, Card, Pagination, type BadgeProps } from '@plastago/ui';
import { FileScanIcon, PaperclipIcon } from 'lucide-react';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn, FilterDefinition } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { PageHeader } from '@/components/page-header';
import { AgeBadge } from '@/components/queues/age-badge';
import { usePoReviewList } from '@/features/queues/queries';
import { formatDateTime } from '@/lib/format';

/**
 * Purchase orders extracted from email, waiting to be checked (M2.12 · I6 + I8).
 *
 * ── Every order is read by a person ───────────────────────────────────────
 * M2.12's first design rule is **never silently guess**, and nothing here ever
 * auto-attached: every extraction has always landed in this queue. What used to
 * sit beside each one was a confidence score, and it has been removed — it
 * reported the model's opinion of itself, and a high number invited confirming
 * an order without opening the document it came from. The PDF is the check.
 *
 * ── The reason column is the whole triage ─────────────────────────────────
 * "No matching account" needs someone who knows the business. "PO number already
 * used" is probably a resend and takes four seconds. "Not checked yet" is simply
 * the ordinary case. Collapsing those into one "needs review" state would make
 * every item look equally expensive.
 */
const FILTER_KEYS = ['state', 'reason', 'age'] as const;

const STATE_VARIANT: Record<PoReviewState, BadgeProps['variant']> = {
  'needs-review': 'warning',
  confirmed: 'success',
  rejected: 'outline',
};

const STATIC_FILTERS: readonly FilterDefinition[] = [
  {
    key: 'state',
    label: 'State',
    allLabel: 'Reviewed and not',
    options: [
      { value: 'needs-review', label: 'Needs review' },
      { value: 'confirmed', label: 'Confirmed' },
      { value: 'rejected', label: 'Rejected' },
    ],
  },
  {
    key: 'reason',
    label: 'Why it is here',
    allLabel: 'Any reason',
    options: PO_REVIEW_REASONS.map((reason) => ({
      value: reason,
      label: PO_REVIEW_REASON_LABELS[reason],
    })),
  },

  {
    key: 'age',
    label: 'Received',
    allLabel: 'Any time',
    options: [
      { value: 'today', label: 'Today' },
      { value: 'this-week', label: 'This week' },
      { value: 'over-week', label: 'More than a week' },
    ],
  },
];

const COLUMNS: readonly DataTableColumn<PoExtractionItem>[] = [
  {
    id: 'subject',
    header: 'Email',
    priority: 'primary',
    cell: (row) => (
      <span className="block min-w-0">
        <span className="block truncate font-medium">{row.subject}</span>
        <span className="block truncate text-xs text-muted-foreground">{row.fromAddress}</span>
      </span>
    ),
  },
  {
    id: 'attachment',
    header: 'Document',
    priority: 'detail',
    cell: (row) => (
      <span className="flex items-start gap-1.5">
        <PaperclipIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0">
          <span className="block truncate font-mono text-xs">{row.attachmentName}</span>
          <span className="block text-xs text-muted-foreground">
            {row.pageCount} page{row.pageCount === 1 ? '' : 's'}
          </span>
        </span>
      </span>
    ),
  },
  {
    id: 'poNumber',
    header: 'PO number',
    priority: 'secondary',
    cell: (row) =>
      row.poNumber ? (
        <span className="font-mono text-sm">{row.poNumber}</span>
      ) : (
        <Badge variant="destructive">Not legible</Badge>
      ),
  },
  {
    /*
     * What the order actually specifies.
     *
     * This column is the reason the extraction is worth running: the reviewer
     * can see the area, the bag allowance and the supervisor without opening the
     * PDF (Matt, 25:40: *"it should pull out of the purchase order"*). "Fixed
     * price" is a real answer, not a gap — Wisdom's orders carry no area at all
     * (31:04), and saying so stops anyone hunting for a number that is not
     * printed.
     */
    id: 'spec',
    header: 'What it specifies',
    priority: 'secondary',
    cell: (row) => (
      <span className="block min-w-0">
        <span className="block truncate text-sm">
          {row.extractedAreaM2 === null ? (
            <span className="text-muted-foreground">Fixed price — no m²</span>
          ) : (
            <>
              {row.extractedAreaM2.toLocaleString('en-AU')} m²
              {row.extractedBagAllowance !== null && ` · ${String(row.extractedBagAllowance)} bags`}
            </>
          )}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {row.extractedSupervisorName ?? 'No supervisor named'}
        </span>
      </span>
    ),
  },
  {
    id: 'match',
    header: 'Best match',
    sortKey: 'suggestedAccountName',
    priority: 'detail',
    cell: (row) => (
      <span className="block">
        <span className="block text-sm">
          {row.suggestedAccountName ?? <span className="text-muted-foreground">No account</span>}
        </span>
        <span className="block text-xs text-muted-foreground">
          {row.suggestedJobNumber === null
            ? 'No job matched'
            : `job #${String(row.suggestedJobNumber)}`}
        </span>
      </span>
    ),
  },
  {
    id: 'reason',
    header: 'Why it is here',
    priority: 'secondary',
    cell: (row) => <Badge variant="outline">{PO_REVIEW_REASON_LABELS[row.reason]}</Badge>,
  },
  {
    id: 'receivedAt',
    header: 'Received',
    sortKey: 'receivedAt',
    priority: 'secondary',
    cell: (row) => (
      <span className="block">
        <AgeBadge
          since={row.receivedAt}
          warnDays={2}
          alarmDays={5}
          muted={row.state !== 'needs-review'}
        />
        <span className="mt-1 block text-xs text-muted-foreground tabular-nums">
          {formatDateTime(row.receivedAt)}
        </span>
      </span>
    ),
  },
  {
    id: 'state',
    header: 'State',
    priority: 'detail',
    cell: (row) => (
      <Badge variant={STATE_VARIANT[row.state]}>{PO_REVIEW_STATE_LABELS[row.state]}</Badge>
    ),
  },
];

export function AdminQueuePoReviewPage() {
  const controller = useListQuery({ filterKeys: FILTER_KEYS });
  const { data, error, isPending, isFetching, refetch } = usePoReviewList(controller.query);

  const needsReview = data?.data.filter((row) => row.state === 'needs-review').length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="PO review"
        description="Purchase orders emailed by builders that the extraction pipeline would not attach on its own. Open one to see the document beside what was read from it."
        badge={
          needsReview > 0 ? <Badge variant="warning">{needsReview} to review</Badge> : undefined
        }
      />

      <Card className="overflow-hidden p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search PO number, sender, subject or account…"
          filters={STATIC_FILTERS}
        />

        <DataTable
          caption="Emailed purchase orders awaiting review"
          columns={COLUMNS}
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
          rowHref={(row) => `/admin/queues/po-review/${row.id}`}
          empty={{
            icon: FileScanIcon,
            title: 'Nothing to review',
            description:
              'Every purchase order that arrived was matched and attached automatically. That is the good outcome.',
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

      <Alert variant="info" title="What you are not seeing here">
        POs the pipeline matched confidently were attached without a human touch and never reached
        this queue. Only the ones it refused to guess at appear — a short list is the system
        working, not the system idle. Typing a PO in by hand from the job or the Awaiting PO queue
        always remains available, whether the pipeline is running or not.
      </Alert>
    </div>
  );
}
