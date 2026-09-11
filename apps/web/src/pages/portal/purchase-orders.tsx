import { CALL_UP_REVIEW_REASON_LABELS, type AwaitingCallUp } from '@plastago/shared';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Skeleton,
  Spinner,
  Textarea,
  useToast,
} from '@plastago/ui';
import { CalendarCheckIcon, CalendarPlusIcon } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { usePortalAwaitingCallUp, usePortalCallUp } from '@/features/portal/queries';
import { describeError } from '@/lib/error-message';
import { formatDate } from '@/lib/format';

/**
 * Orders waiting for a date, and the button that books one (M2.12b).
 *
 * ── Why the customer has this screen at all ───────────────────────────────
 * Matt, 29:03 and 30:40: *"sometimes that call-up email fails and the site
 * supervisor needs to book the job himself… he can log into his portal and that
 * PO that we got will be sitting there on his account and he can go call this up
 * for the 21st because this email is not coming to us."*
 *
 * The builders' own systems drop these notices. When they do, the work still
 * has to happen — and without this screen the only route left is a phone call to
 * an office that does not know the job exists either.
 *
 * ── Why it asks for a date and nothing else ───────────────────────────────
 * Everything else is already on the purchase order. A supervisor cannot answer
 * an area or a bag allowance and should never be asked: the booking form exists
 * for work that has no order behind it, and this is the opposite of that case.
 *
 * ── Why it is not the booking form with an order attached ─────────────────
 * Because the two are different jobs. Booking asks *"what do you need?"*; this
 * says *"we already know — when?"* Folding them together would put seventeen
 * fields in front of somebody whose answer is one date.
 */
export function PortalPurchaseOrdersPage(): React.JSX.Element {
  const { data, error, isPending, refetch } = usePortalAwaitingCallUp({ page: 1, pageSize: 50 });

  const callUp = usePortalCallUp();
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
      setDateError('Pick the day the site will be ready.');
      return;
    }

    try {
      const outcome = await callUp.mutateAsync({
        purchaseOrderId: target.purchaseOrderId,
        request: { readyDate, note: note.trim() },
      });

      /*
       * ⚠️ Told the truth about which of two things happened.
       *
       * A call-up the system cannot resolve is recorded and sent to the office,
       * not booked. Saying "booked" either way is how a supervisor waits at a
       * site for a truck that was never scheduled.
       */
      if (outcome.state === 'applied') {
        toast.success(
          `Booked for ${formatDate(readyDate)}`,
          `Pickup ${outcome.jobNumber === null ? '' : `#${String(outcome.jobNumber)} `}is on our run sheet.`,
        );
      } else {
        toast.info(
          'Sent to our office',
          outcome.reason
            ? `${CALL_UP_REVIEW_REASON_LABELS[outcome.reason]}. We will call you to confirm.`
            : 'We will confirm the date with you shortly.',
        );
      }

      setTarget(null);
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const header = (
    <PageHeader
      title="Waiting on a date"
      description="Purchase orders you have sent us that are not booked in yet. If your system’s call-up email has not reached us, give us the date here."
    />
  );

  if (error) {
    return (
      <div className="space-y-4">
        {header}
        <ErrorState
          title="Could not load your purchase orders"
          description="Try again in a moment."
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  if (isPending) {
    return (
      <div className="space-y-4">
        {header}
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    );
  }

  const rows = data?.data ?? [];

  return (
    <div className="space-y-4">
      {header}

      {rows.length === 0 ? (
        <EmptyState
          icon={CalendarCheckIcon}
          title="Everything is booked in"
          description="Every purchase order you have sent us has a pickup against it. Anything new will appear here until it has a date."
        />
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <Card key={row.purchaseOrderId}>
              <CardHeader className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="text-base">
                    {row.lotNumber ? `Lot ${row.lotNumber}` : (row.addressLine ?? row.poNumber)}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {[row.addressLine, row.suburb].filter(Boolean).join(', ') || '—'}
                  </p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    PO {row.poNumber}
                  </p>
                </div>

                {/*
                  An order whose suburb is outside our zones cannot be priced, so
                  booking it here would only raise a query. Saying so up front
                  beats a button that quietly does not do what it says.
                */}
                {row.serviceable ? (
                  <Button type="button" size="sm" onClick={() => open(row)}>
                    <CalendarPlusIcon aria-hidden className="size-4" />
                    Give us a date
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    Call our office to book this one
                  </span>
                )}
              </CardHeader>

              <CardContent>
                <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted-foreground">Board</dt>
                    <dd className="font-medium">
                      {/* Null is a real answer on a fixed-price order (Matt, 31:04). */}
                      {row.expectedAreaM2 === null
                        ? 'Fixed price'
                        : `${row.expectedAreaM2.toLocaleString('en-AU')} m²`}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Bags allowed</dt>
                    <dd className="font-medium">
                      {row.bagAllowance === null ? '—' : row.bagAllowance}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Site supervisor</dt>
                    <dd className="font-medium">{row.siteSupervisorName ?? '—'}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={target !== null}
        onClose={() => setTarget(null)}
        title={target ? `When is ${target.lotNumber ? `Lot ${target.lotNumber}` : 'the site'} ready?` : 'Give us a date'}
        description={target ? `PO ${target.poNumber}` : undefined}
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
          <Alert variant="info" title="We already have the rest">
            The board, the bag allowance and your PO number all come from the order you sent us —
            there is nothing else to fill in.
          </Alert>

          <Field
            id="portal-call-up-date"
            label="Ready date"
            required
            error={dateError ?? undefined}
            hint="The day the site is clear for our truck."
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

          <Field id="portal-call-up-note" label="Anything we should know?">
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
