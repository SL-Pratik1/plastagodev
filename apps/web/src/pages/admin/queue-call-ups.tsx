import { CALL_UP_REVIEW_REASON_LABELS, type AwaitingCallUp } from '@plastago/shared';
import {
  Alert,
  Button,
  Card,
  Dialog,
  Field,
  Input,
  Pagination,
  Spinner,
  Textarea,
  useToast,
} from '@plastago/ui';
import { CalendarClockIcon, CalendarPlusIcon, MapPinOffIcon } from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { PageHeader } from '@/components/page-header';
import { AgeBadge } from '@/components/queues/age-badge';
import { useAwaitingCallUps, useCallUpOrder } from '@/features/queues/queries';
import { describeError } from '@/lib/error-message';
import { isServiceError } from '@/services/service-error';
import { formatDateTime } from '@/lib/format';

/**
 * Purchase orders waiting for a date (M2.12b).
 *
 * ── Why this screen exists ────────────────────────────────────────────────
 * Matt, 21:30, describing what should happen after a purchase order arrives:
 * *"that job should be sitting there waiting for a call-up date to happen."*
 *
 * Before this there was nowhere to see them. A confirmed order with no job is
 * invisible: it is not on the board, because it has no date, and it is not in
 * the review queue, because it was reviewed. So the work is known, agreed and
 * unbookable — and nobody can tell whether a builder has gone quiet or the
 * office has missed something.
 *
 * ── Why the call-up is a date and nothing else ────────────────────────────
 * Everything else about the job is already on the order. Matt's fallback case
 * (30:40) is a supervisor doing this himself on a phone — *"he can go call this
 * up for the 21st"* — so the form is one date, because the area and the bag
 * allowance are questions he cannot answer and must not be asked.
 *
 * ── Why the outcome is reported rather than assumed ───────────────────────
 * Calling up an order does not always book it. If the order's suburb is not one
 * we service the job cannot be priced, and the call-up goes to the office queue
 * instead. A bare "done" would leave somebody believing a truck is coming.
 */
export function AdminQueueCallUpsPage(): React.JSX.Element {
  const controller = useListQuery({ filterKeys: [] });
  const { data, error, isPending, isFetching, refetch } = useAwaitingCallUps(controller.query);

  const callUp = useCallUpOrder();
  const toast = useToast();

  const [target, setTarget] = useState<AwaitingCallUp | null>(null);
  const [readyDate, setReadyDate] = useState('');
  const [note, setNote] = useState('');
  const [dateError, setDateError] = useState<string | null>(null);

  const open = (row: AwaitingCallUp): void => {
    setTarget(row);
    setReadyDate('');
    setNote('');
    setDateError(null);
  };

  const submit = async (): Promise<void> => {
    if (!target) return;

    if (readyDate.trim() === '') {
      setDateError('Pick the day the site is ready.');
      return;
    }

    try {
      const outcome = await callUp.mutateAsync({
        purchaseOrderId: target.purchaseOrderId,
        request: { readyDate, note: note.trim() },
      });

      /*
       * Two different outcomes, said differently. A call-up that could not be
       * applied is not a failure — the record exists and the office queue has
       * it — but telling somebody "booked" when no job was created is how a
       * truck fails to turn up.
       */
      if (outcome.state === 'applied') {
        toast.success(
          `Booked as job #${String(outcome.jobNumber ?? 0)}`,
          `${target.accountName} · PO ${target.poNumber}`,
        );
      } else {
        toast.info(
          'Recorded, but not booked',
          outcome.reason
            ? CALL_UP_REVIEW_REASON_LABELS[outcome.reason]
            : 'It is in the call-up queue for review.',
        );
      }

      setTarget(null);
    } catch (caught) {
      /*
       * ⚠️ Put the server’s own message on the field.
       *
       * Without this the catch fell through to a toast reading "Check the
       * highlighted fields" — and nothing was highlighted, because the only
       * field error this dialog ever set was its own empty-date check. A
       * reviewer typing 2020 instead of 2026 pressed "Book it", got a toast
       * pointing at highlights that did not exist, and never saw the sentence
       * the API had already written for them: "Check the year. A job ready on
       * 2020-01-01 would be overdue the moment it is saved."
       */
      if (isServiceError(caught) && caught.fieldErrors.readyDate) {
        setDateError(caught.fieldErrors.readyDate);
        return;
      }

      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const columns: readonly DataTableColumn<AwaitingCallUp>[] = [
    {
      id: 'poNumber',
      header: 'Purchase order',
      priority: 'primary',
      cell: (row) => (
        <span className="block">
          <span className="font-mono font-medium">{row.poNumber}</span>
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
          <span className="block text-sm">
            {row.lotNumber ? `Lot ${row.lotNumber}` : (row.addressLine ?? '—')}
          </span>
          <span className="block text-xs text-muted-foreground">
            {[row.addressLine, row.suburb].filter(Boolean).join(', ') || '—'}
          </span>
        </span>
      ),
    },
    {
      id: 'figures',
      header: 'What was ordered',
      priority: 'detail',
      cell: (row) => (
        <span className="block text-sm">
          {/*
            Null is a real answer on a fixed-price order — the builder states no
            area (Matt, 31:04) — so it reads "fixed price" rather than "0 m²".
          */}
          <span className="block">
            {row.expectedAreaM2 === null
              ? 'Fixed price'
              : `${row.expectedAreaM2.toLocaleString('en-AU')} m²`}
          </span>
          <span className="block text-xs text-muted-foreground">
            {row.bagAllowance === null
              ? 'No bag allowance stated'
              : `${String(row.bagAllowance)} bag${row.bagAllowance === 1 ? '' : 's'} allowed`}
          </span>
        </span>
      ),
    },
    {
      id: 'supervisor',
      header: 'Site supervisor',
      priority: 'detail',
      cell: (row) =>
        row.siteSupervisorName ?? (
          <span className="text-xs text-muted-foreground">Not on the order</span>
        ),
    },
    {
      id: 'waiting',
      header: 'Waiting',
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
      id: 'action',
      header: '',
      priority: 'primary',
      cell: (row) =>
        /*
         * An order whose suburb we do not service cannot be priced, so calling
         * it up would only produce a queue item. Saying so here — before
         * anybody picks a date — is the difference between a fixable data
         * problem and a mysterious refusal.
         */
        row.serviceable ? (
          <Button type="button" size="sm" onClick={() => open(row)}>
            <CalendarPlusIcon aria-hidden className="size-4" />
            Call up
          </Button>
        ) : (
          <span className="flex items-center gap-1.5 text-xs text-warning">
            <MapPinOffIcon aria-hidden className="size-3.5 shrink-0" />
            {row.suburb ? `${row.suburb} is not a serviced suburb` : 'No suburb on the order'}
          </span>
        ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Waiting for a call-up"
        description="Purchase orders we have confirmed and nobody has given us a date for. A call-up email normally books these; this is where you do it by hand when one does not arrive."
      />

      {/*
        Toolbar, table and pagination share ONE card, as they do on every other
        queue. This screen used to render a bare table and read as a different
        product from the queue beside it in the same sidebar group.
      */}
      <Card className="overflow-hidden p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search PO number or customer…"
        />

        <DataTable
          caption="Purchase orders waiting for a call-up date"
          columns={columns}
          rows={data?.data ?? []}
          getRowId={(row) => row.purchaseOrderId}
          isPending={isPending}
          isFetching={isFetching && !isPending}
          error={error}
          onRetry={() => void refetch()}
          sort={controller.sort}
          onToggleSort={controller.toggleSort}
          isFiltered={controller.isFiltered}
          onClearFilters={controller.clearFilters}
          empty={{
            icon: CalendarClockIcon,
            title: 'Nothing waiting',
            description:
              'Every confirmed purchase order has a job against it. New orders appear here once they are confirmed in PO review.',
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
        open={target !== null}
        onClose={() => setTarget(null)}
        title={target ? `Call up PO ${target.poNumber}` : 'Call up'}
        description={
          target
            ? `${target.accountName} · ${[target.lotNumber ? `Lot ${target.lotNumber}` : null, target.suburb].filter(Boolean).join(', ')}`
            : undefined
        }
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void submit()} disabled={callUp.isPending}>
              {callUp.isPending ? <Spinner label="Booking" /> : <CalendarPlusIcon aria-hidden />}
              Book it
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Alert variant="info" title="Only the date is needed">
            The area, the bag allowance and the PO number all come from the order itself, so they
            cannot be mistyped here.
          </Alert>

          <Field
            id="call-up-ready-date"
            label="Ready date"
            required
            error={dateError ?? undefined}
            hint="The day the site is ready for us. The target date is worked out from it."
          >
            {(control) => (
              <Input
                {...control}
                type="date"
                value={readyDate}
                onChange={(event) => {
                  setReadyDate(event.target.value);
                  setDateError(null);
                }}
              />
            )}
          </Field>

          <Field
            id="call-up-note"
            label="Note"
            hint="Who called it in, or anything the driver should know."
          >
            {(control) => (
              <Textarea
                {...control}
                rows={2}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            )}
          </Field>

        </div>
      </Dialog>
    </div>
  );
}
