import type { PortalJob } from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  buttonVariants,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DatePicker,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Select,
  Skeleton,
  Spinner,
  Textarea,
  useToast,
} from '@plastago/ui';
import {
  AwardIcon,
  CalendarIcon,
  CheckCircle2Icon,
  ImageIcon,
  MessageSquareIcon,
  PencilIcon,
  PhoneIcon,
  TruckIcon,
  ZapIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { DetailList } from '@/components/detail-list';
import { PickupStatusBadge, ReadinessBadge } from '@/components/portal/pickup-status';
import {
  usePortalCertifyReadiness,
  usePortalJob,
  usePortalRequestChange,
  usePortalScope,
  usePortalSetUrgency,
} from '@/features/portal/queries';
import { todayInSydney } from '@/lib/business-day';
import { describeError } from '@/lib/error-message';
import {
  formatArea,
  formatDate,
  formatDateTime,
  formatMoney,
  formatTime,
  formatWeight,
} from '@/lib/format';
import { useNow } from '@/lib/use-now';

/**
 * One pickup, from the customer's side (M5.7, M5.9 · W99).
 *
 * ── M5.9's promise: this beats a `mydat.info` link on a PDF ────────────────
 * The full completion record — square metres, recovered weight, driver, times
 * and *all* the site photos — on the same screen as the live status. Today the
 * customer gets a URL printed on an invoice.
 *
 * ── M5.4's rule decides what the buttons are ──────────────────────────────
 * A pickup can be edited freely until it is on a run sheet; after that a change
 * is a *request* that routes to the office. That rule is taken verbatim from the
 * client's own site map, and it is computed server-side (`editable`) so the
 * portal and the console cannot disagree about whether a truck has been
 * committed. The UI reads the flag; it does not re-derive it.
 */
export function PortalJobDetailPage() {
  const { jobId } = useParams();
  const { data: job, error, isPending, refetch } = usePortalJob(jobId);

  if (error) {
    const described = describeError(error);
    return (
      <div className="space-y-5">
        <BackLink />
        <ErrorState
          title={described.title}
          description={described.detail}
          onRetry={described.retryable ? () => void refetch() : undefined}
        />
      </div>
    );
  }

  if (isPending || !job) {
    return (
      <div className="space-y-5">
        <BackLink />
        <Skeleton className="h-8 w-52" />
        <Card className="p-5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-4 h-40 w-full" />
        </Card>
      </div>
    );
  }

  return <PickupDetail job={job} />;
}

function BackLink() {
  return (
    <Link
      to="/portal/jobs"
      className="focus-ring inline-block rounded text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
    >
      ← All pickups
    </Link>
  );
}

function PickupDetail({ job }: { job: PortalJob }) {
  const toast = useToast();
  const scope = usePortalScope();
  const now = useNow(300_000);

  const certify = usePortalCertifyReadiness();
  const setUrgency = usePortalSetUrgency();
  const requestChange = usePortalRequestChange();

  const [changeOpen, setChangeOpen] = useState(false);

  const canSeePricing = scope.data?.canSeePricing ?? false;
  const capturesWeight = scope.data?.capturesWeight ?? false;
  const isDone = job.status === 'completed' || job.status === 'admin-complete';
  const isClosed = isDone || job.status === 'cancelled' || job.status === 'futile';
  const atRisk = !isClosed && job.targetDate <= todayInSydney(now);

  const confirmReady = async () => {
    try {
      await certify.mutateAsync(job.id);
      toast.success(
        'Thanks — recorded',
        'Your confirmation is on the job with your name and the time.',
      );
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const toggleUrgency = async () => {
    const urgent = job.serviceLevel !== 'urgent';
    try {
      await setUrgency.mutateAsync({ id: job.id, urgent });
      toast.success(
        urgent ? 'Marked urgent' : 'Urgency removed',
        urgent
          ? 'The office has been alerted and will confirm what is possible.'
          : 'Back to a standard pickup.',
      );
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <div className="space-y-5">
      <BackLink />

      <header className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-display text-xl font-semibold tracking-tight">
              Pickup #{job.jobNumber}
            </h1>
            <p className="text-sm text-muted-foreground">
              {job.siteName}, {job.suburb}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {job.editable ? (
              <Link
                to={`/portal/jobs/${job.id}/edit`}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                <PencilIcon aria-hidden />
                Edit
              </Link>
            ) : !isClosed ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setChangeOpen(true);
                }}
              >
                <CalendarIcon aria-hidden />
                Request a change
              </Button>
            ) : null}

            {!isClosed && (
              <Button
                variant={job.serviceLevel === 'urgent' ? 'ghost' : 'outline'}
                size="sm"
                disabled={setUrgency.isPending}
                onClick={() => void toggleUrgency()}
              >
                {setUrgency.isPending && <Spinner label="Saving" />}
                <ZapIcon aria-hidden />
                {job.serviceLevel === 'urgent' ? 'Not urgent after all' : 'Mark urgent'}
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <PickupStatusBadge status={job.status} />
          {job.serviceLevel === 'urgent' && (
            <Badge variant="warning">
              <ZapIcon aria-hidden className="size-3" />
              Urgent
            </Badge>
          )}
          {!isClosed && <ReadinessBadge job={job} />}
        </div>
      </header>

      {/* ── The one prompt worth interrupting for ───────────────────────── */}
      {!isClosed && job.readinessCertifiedAt === null && (
        <Alert variant="warning" title="Please confirm this pickup is ready">
          <p>
            We send a truck on the strength of this confirmation. If the driver arrives and the
            board is not stacked, not reachable, or mixed with other waste, a $120 futile fee
            applies.
          </p>
          <Button size="sm" disabled={certify.isPending} onClick={() => void confirmReady()}>
            {certify.isPending && <Spinner label="Saving" />}
            <CheckCircle2Icon aria-hidden />
            Yes — ready, accessible and clean
          </Button>
        </Alert>
      )}

      {job.status === 'futile' && (
        <Alert variant="destructive" title="We could not collect this pickup">
          Our driver attended and was unable to collect. The photos below were taken on site. A $120
          futile fee applies whether the pickup is rebooked or cancelled — call the office on{' '}
          <a href="tel:1300395438" className="font-medium underline underline-offset-4">
            1300 395 438
          </a>{' '}
          if you think something is wrong.
        </Alert>
      )}

      {atRisk && (
        <Alert variant="info" title="This is at five business days from your ready date">
          We aim to collect within five business days. If this has become urgent, mark it urgent
          above or call the office.
        </Alert>
      )}

      {!job.editable && !isClosed && (
        <Alert variant="info" title="This pickup is scheduled with a driver">
          It is on a run sheet now, so changes go through the office rather than being applied
          directly. Use <strong>Request a change</strong> and we will confirm.
        </Alert>
      )}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {/* ── Progress ─────────────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Progress</CardTitle>
            </CardHeader>
            <CardContent>
              {job.steps.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Booked. We will update this as the pickup moves.
                </p>
              ) : (
                <ol className="relative space-y-4 border-l border-border pl-5">
                  {job.steps.map((step) => (
                    <li key={step.id} className="relative">
                      <span
                        aria-hidden
                        className="absolute top-1.5 -left-[1.4rem] size-2 rounded-full bg-brand-500 ring-2 ring-card"
                      />
                      <p className="text-sm font-medium">{step.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(step.at)}
                        {step.by !== null && ` · ${step.by}`}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>

          {/* ── Photos (M5.9) ────────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Site photos</CardTitle>
              <p className="text-xs text-muted-foreground">
                Taken by the driver on site, with the time and position recorded.
              </p>
            </CardHeader>
            <CardContent>
              {job.photos.length === 0 ? (
                <EmptyState
                  icon={ImageIcon}
                  title="No photos yet"
                  description="Photos are taken during the pickup and appear here once it is complete."
                />
              ) : (
                <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {job.photos.map((photo) => (
                    <li
                      key={photo.id}
                      className="overflow-hidden rounded-lg border border-border bg-muted/40"
                    >
                      <div className="grid aspect-4/3 place-items-center bg-muted text-muted-foreground">
                        <ImageIcon aria-hidden className="size-6" />
                        <span className="sr-only">Photograph: {photo.caption}</span>
                      </div>
                      <div className="space-y-0.5 p-2">
                        <p className="truncate text-xs font-medium">{photo.caption}</p>
                        <p className="text-[11px] text-muted-foreground tabular-nums">
                          {formatTime(photo.takenAt)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* ── Messages from the office (M2.11, customer-visible) ────── */}
          {job.messages.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <MessageSquareIcon aria-hidden className="size-4 text-muted-foreground" />
                  Messages
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-3">
                  {job.messages.map((message) => (
                    <li key={message.id} className="rounded-lg border border-border p-3">
                      <p className="text-sm">{message.body}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {message.fromCustomer ? 'You' : message.author} ·{' '}
                        {formatDateTime(message.at)}
                      </p>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent>
              <DetailList
                columns={1}
                items={[
                  { label: 'Ready date', value: formatDate(job.readyDate) },
                  {
                    label: 'Collect by',
                    value: (
                      <span className={atRisk ? 'font-medium text-destructive' : undefined}>
                        {formatDate(job.targetDate)}
                      </span>
                    ),
                  },
                  { label: 'Expected plasterboard', value: formatArea(job.expectedAreaM2) },
                  ...(capturesWeight
                    ? [
                        {
                          label: 'Recovered weight',
                          value: formatWeight(job.recoveredWeightKg, 'Measured on collection'),
                        },
                      ]
                    : []),
                  { label: 'Recycling bags', value: job.bagCount },
                  { label: 'PO / job reference', value: job.poNumber ?? '—' },
                  {
                    label: 'Driver',
                    value:
                      job.driverName === null ? (
                        'Not yet assigned'
                      ) : (
                        <span className="flex items-center gap-1.5">
                          <TruckIcon aria-hidden className="size-3.5 text-muted-foreground" />
                          {job.driverName}
                        </span>
                      ),
                  },
                  ...(job.readinessCertifiedAt !== null
                    ? [
                        {
                          label: 'Confirmed ready by',
                          value: `${job.readinessCertifiedBy ?? '—'} · ${formatDateTime(job.readinessCertifiedAt)}`,
                          wide: true as const,
                        },
                      ]
                    : []),
                  ...(canSeePricing && job.totalIncGst !== null
                    ? [{ label: 'Cost inc GST', value: formatMoney(job.totalIncGst) }]
                    : []),
                  ...(job.notes
                    ? [{ label: 'Your notes', value: job.notes, wide: true as const }]
                    : []),
                ]}
              />
            </CardContent>
          </Card>

          {/* M5.12 · F52 — the certificate, where a completed job earns one. */}
          {job.certificateReference !== null && (
            <Card className="border-success/35">
              <CardContent className="space-y-2 py-5">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <AwardIcon aria-hidden className="size-4 text-success" />
                  Certificate of Recycling
                </p>
                <p className="text-xs text-muted-foreground">
                  Reference <span className="font-mono">{job.certificateReference}</span> — download
                  it for Green Star or council reporting.
                </p>
                <Link
                  to="/portal/certificates"
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  Go to certificates
                </Link>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="py-5">
              <p className="text-sm font-medium">Something not right?</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                The office is open weekdays and can move a pickup at short notice.
              </p>
              <a
                href="tel:1300395438"
                className={`${buttonVariants({ variant: 'outline', size: 'sm' })} mt-3`}
              >
                <PhoneIcon aria-hidden />
                1300 395 438
              </a>
            </CardContent>
          </Card>
        </div>
      </div>

      <ChangeRequestDialog
        job={job}
        open={changeOpen}
        onClose={() => {
          setChangeOpen(false);
        }}
        onSent={() => {
          setChangeOpen(false);
          toast.success(
            'Request sent to the office',
            'We will confirm by phone or text. Nothing has changed on the pickup yet.',
          );
        }}
        mutation={requestChange}
      />
    </div>
  );
}

/* ── M5.4 — a change request, once the pickup is committed ────────────────── */

function ChangeRequestDialog({
  job,
  open,
  onClose,
  onSent,
  mutation,
}: {
  job: PortalJob;
  open: boolean;
  onClose: () => void;
  onSent: () => void;
  mutation: ReturnType<typeof usePortalRequestChange>;
}) {
  const toast = useToast();
  const now = useNow(300_000);
  const [kind, setKind] = useState<'reschedule' | 'cancel' | 'other'>('reschedule');
  const [requestedDate, setRequestedDate] = useState('');
  const [note, setNote] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const today = todayInSydney(now);

  const close = () => {
    setKind('reschedule');
    setRequestedDate('');
    setNote('');
    setFieldError(null);
    onClose();
  };

  const send = async () => {
    if (kind === 'reschedule' && !requestedDate) {
      setFieldError('Tell us the date you would prefer.');
      return;
    }
    if (note.trim().length === 0) {
      setFieldError('A short note helps the office sort this out in one call instead of two.');
      return;
    }

    setFieldError(null);
    try {
      await mutation.mutateAsync({
        id: job.id,
        input: {
          kind,
          requestedDate: kind === 'reschedule' ? requestedDate : null,
          note: note.trim(),
        },
      });
      setKind('reschedule');
      setRequestedDate('');
      setNote('');
      onSent();
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={`Request a change to pickup #${String(job.jobNumber)}`}
      description="This pickup is already scheduled with a driver, so the office needs to confirm any change."
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void send()} disabled={mutation.isPending}>
            {mutation.isPending && <Spinner label="Sending" />}
            Send request
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field id="change-kind" label="What do you need?">
          {(control) => (
            <Select
              {...control}
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as typeof kind);
                setFieldError(null);
              }}
            >
              <option value="reschedule">Move it to a different date</option>
              <option value="cancel">Cancel it</option>
              <option value="other">Something else</option>
            </Select>
          )}
        </Field>

        {kind === 'reschedule' && (
          <Field
            id="change-date"
            label="Preferred new date"
            required
            error={fieldError ?? undefined}
            hint="We will confirm what is possible on the day's run."
          >
            {(control) => (
              <DatePicker
                {...control}
                min={today}
                value={requestedDate}
                onChange={(event) => {
                  setRequestedDate(event.target.value);
                  setFieldError(null);
                }}
              />
            )}
          </Field>
        )}

        <Field
          id="change-note"
          label="Anything we should know"
          required
          error={kind === 'reschedule' ? undefined : (fieldError ?? undefined)}
          hint="The more specific, the fewer phone calls."
        >
          {(control) => (
            <Textarea
              {...control}
              rows={3}
              maxLength={500}
              value={note}
              placeholder="Concrete pour moved — the board will not be accessible until Thursday."
              onChange={(event) => {
                setNote(event.target.value);
                setFieldError(null);
              }}
            />
          )}
        </Field>

        <Alert variant="info" title="Nothing changes until we confirm">
          A truck is already committed to this pickup. Sending this request tells the office; it
          does not move the job on its own.
        </Alert>
      </div>
    </Dialog>
  );
}
