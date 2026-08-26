import {
  DRIVER_TRANSITION_LABELS,
  LOAD_TYPE_LABELS,
  type DriverJob,
  type DriverTransition,
} from '@plastago/shared';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  Dialog,
  ErrorState,
  Field,
  Skeleton,
  Spinner,
  Textarea,
  buttonVariants,
  useToast,
} from '@plastago/ui';
import {
  CameraIcon,
  CheckCircle2Icon,
  CircleSlashIcon,
  ClockIcon,
  MapPinIcon,
  MessageSquareIcon,
  NavigationIcon,
  PhoneIcon,
  ScaleIcon,
  ShieldAlertIcon,
  TriangleAlertIcon,
  TruckIcon,
  ZapIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ActionButton } from '@/components/driver/action-button';
import { missingRequiredPhotos } from '@/components/driver/photo-rules';
import {
  useCompleteJob,
  useDriverJob,
  useSendDriverMessage,
  useUpdateStatus,
} from '@/features/run/queries';
import { currentPosition } from '@/services/mock/create-mock-services';

/**
 * One job (M4.1) and its status actions (M4.2).
 *
 * ── One screen, not two ───────────────────────────────────────────────────
 * §13.2 lists "job detail" and "status actions" separately, and on a desktop they
 * would be. On a phone on site they are not: the driver needs the address, the
 * gate code and the button in the same thumb reach, because the sequence is
 * *read → act*, once, standing at a fence. Splitting them would add a navigation
 * between reading the gate code and tapping Arrived.
 *
 * ── The action is always singular ─────────────────────────────────────────
 * Exactly one primary button, decided by the status. A grid of every possible
 * transition is how a driver taps Complete before Arrived — which silently
 * destroys the on-site duration the Extra Load Time charge is computed from
 * (M6.7).
 */
export function JobDetailPage() {
  const { jobId } = useParams();
  const { data: job, error, isPending, refetch } = useDriverJob(jobId);

  if (error) {
    return (
      <ErrorState
        title="Could not open this job"
        description="You may be out of coverage. Go back to your run and try again."
        onRetry={() => void refetch()}
      />
    );
  }

  if (isPending || !job) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    );
  }

  return <JobScreen key={job.jobId} job={job} />;
}

/** The single next action for a status. `null` when the job is finished. */
function nextTransition(job: DriverJob): DriverTransition | null {
  switch (job.status) {
    case 'assigned':
      return 'acknowledged';
    case 'acknowledged':
      return 'in-transit';
    case 'in-transit':
      return 'arrived';
    case 'arrived':
      return 'completed';
    default:
      return null;
  }
}

function JobScreen({ job }: { job: DriverJob }) {
  const toast = useToast();
  const navigate = useNavigate();

  const updateStatus = useUpdateStatus();
  const completeJob = useCompleteJob();
  const sendMessage = useSendDriverMessage();

  const [completeOpen, setCompleteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [messageOpen, setMessageOpen] = useState(false);
  const [messageBody, setMessageBody] = useState('');

  const transition = nextTransition(job);
  const finished = ['completed', 'admin-complete'].includes(job.status);
  const failed = job.status === 'futile' || job.status === 'cancelled';

  const missingPhotos = missingRequiredPhotos(job.photos, job.requiredPhotos);
  const needsWeights = job.capturedAreaM2 === null;
  const needsRiskForm = job.riskAssessmentRequired && job.riskAssessmentDoneAt === null;

  /*
   * What has to be true before "Complete job" can be tapped.
   *
   * Blocked, not warned. Every item here is evidence that defends a charge or a
   * legal obligation, and "the driver meant to go back and do it" is exactly how
   * a $90 contamination charge becomes undisputable-in-theory and unpaid in fact.
   */
  const completionBlockers = [
    needsRiskForm ? 'the site risk assessment' : null,
    needsWeights ? 'the m² collected' : null,
    missingPhotos.length > 0
      ? `${String(missingPhotos.length)} required photo${missingPhotos.length === 1 ? '' : 's'}`
      : null,
  ].filter((item): item is string => item !== null);

  const advance = async (to: DriverTransition) => {
    // Position is best-effort and never blocks: a driver in a basement car park
    // still has to be able to move the job on (M4.2).
    const position = await currentPosition();

    try {
      await updateStatus.mutateAsync({
        jobId: job.jobId,
        input: { transition: to, occurredAt: new Date().toISOString(), position },
      });

      // M4.8b — arriving is what pops the risk assessment. Matt described the
      // sequence precisely, and the form appearing on its own is the mechanism.
      if (to === 'arrived' && job.riskAssessmentRequired) {
        toast.info('Site risk assessment required', 'Domaine need this before you start.');
        await navigate(`/jobs/${job.jobId}/risk-assessment`);
        return;
      }

      toast.success(
        to === 'arrived' ? 'On site — clock started' : DRIVER_TRANSITION_LABELS[to],
        position === null ? 'No GPS fix — the time is still recorded.' : undefined,
      );
    } catch {
      toast.error('Could not save that', 'Try again — nothing was lost.');
    }
  };

  const complete = async () => {
    const position = await currentPosition();
    try {
      await completeJob.mutateAsync({
        jobId: job.jobId,
        input: { occurredAt: new Date().toISOString(), position, note: note.trim() },
      });
      setCompleteOpen(false);
      setNote('');
      toast.success('Job complete', 'Queued for the office. You can keep working.');
      await navigate('/');
    } catch {
      toast.error('Could not save that', 'Try again — nothing was lost.');
    }
  };

  const send = async () => {
    if (messageBody.trim().length === 0) return;
    try {
      await sendMessage.mutateAsync({ jobId: job.jobId, body: messageBody.trim() });
      setMessageBody('');
      setMessageOpen(false);
      toast.success('Sent to the office', 'They will see it against this job.');
    } catch {
      toast.error('Could not send that', 'It stays on this phone — try again.');
    }
  };

  const mapsHref = `https://www.google.com/maps/dir/?api=1&destination=${String(job.latitude)},${String(job.longitude)}`;

  return (
    <div className="space-y-4">
      <Link
        to="/"
        className="focus-ring inline-block rounded text-sm text-muted-foreground underline-offset-4"
      >
        ← Run sheet
      </Link>

      <header className="space-y-1.5">
        <p className="text-xs text-muted-foreground">
          Job {job.sequence} · #{job.jobNumber}
        </p>
        <h1 className="font-display text-lg leading-tight font-semibold">{job.siteName}</h1>
        <p className="text-sm text-muted-foreground">
          {job.addressLine}, {job.suburb} {job.postcode}
        </p>
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {job.urgent && (
            <Badge variant="warning">
              <ZapIcon aria-hidden className="size-3" />
              Urgent
            </Badge>
          )}
          {job.lotNumber !== null && <Badge variant="outline">Lot {job.lotNumber}</Badge>}
          {job.inductionRequired && <Badge variant="secondary">Induction</Badge>}
          {job.craneAvailable && <Badge variant="secondary">Crane on site</Badge>}
        </div>
      </header>

      {/* ── Navigate and call, the two things needed on approach ──────── */}
      <div className="grid grid-cols-2 gap-2">
        <a href={mapsHref} className={`${buttonVariants({ size: 'lg' })} min-h-14`}>
          <NavigationIcon aria-hidden />
          Navigate
        </a>
        {job.siteContactMobile !== null ? (
          <a
            href={`tel:${job.siteContactMobile}`}
            className={`${buttonVariants({ variant: 'outline', size: 'lg' })} min-h-14`}
          >
            <PhoneIcon aria-hidden />
            {job.siteContactName ?? 'Call site'}
          </a>
        ) : (
          <a
            href="tel:1300395438"
            className={`${buttonVariants({ variant: 'outline', size: 'lg' })} min-h-14`}
          >
            <PhoneIcon aria-hidden />
            Office
          </a>
        )}
      </div>

      {job.siteContactMobile === null && (
        <p className="text-xs text-muted-foreground">
          No site contact on this job — ring the office if you need someone on site.
        </p>
      )}

      {/* ── What the driver needs to read before getting out ──────────── */}
      <Card>
        <CardContent className="space-y-3 py-4 text-sm">
          {job.accessNotes ? (
            <p className="rounded-lg bg-muted p-3 leading-snug">
              <span className="block text-xs font-semibold text-muted-foreground uppercase">
                Access
              </span>
              {job.accessNotes}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">No access notes on this site.</p>
          )}

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Expected</dt>
              <dd className="font-medium">{job.expectedAreaM2.toLocaleString('en-AU')} m²</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Load</dt>
              <dd className="font-medium">
                {job.loadType === 'bagged' ? `${String(job.bagCount)} bags` : 'Hand load'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Customer</dt>
              <dd className="truncate font-medium">{job.accountName}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Builder</dt>
              <dd className="truncate font-medium">{job.builderName || '—'}</dd>
            </div>
            {job.gateHours !== null && (
              <div className="col-span-2">
                <dt className="text-xs text-muted-foreground">Gate hours</dt>
                <dd className="font-medium">{job.gateHours}</dd>
              </div>
            )}
            {job.customerReference !== null && (
              <div className="col-span-2">
                <dt className="text-xs text-muted-foreground">Their reference</dt>
                <dd className="font-medium">{job.customerReference}</dd>
              </div>
            )}
          </dl>

          {job.notes && (
            <p className="border-t border-border pt-3 text-sm leading-snug">{job.notes}</p>
          )}

          {job.arrivedAt !== null && (
            <p className="flex items-center gap-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
              <ClockIcon aria-hidden className="size-3.5 shrink-0" />
              On site since{' '}
              {new Date(job.arrivedAt).toLocaleTimeString('en-AU', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
              })}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Messages from the office (M8.6 · W102) ────────────────────── */}
      {job.messages.length > 0 && (
        <Card>
          <CardContent className="space-y-2 py-4">
            {job.messages.map((message) => (
              <div
                key={message.id}
                className={
                  message.fromDriver
                    ? 'ml-6 rounded-lg border border-primary/30 bg-primary/5 p-2.5'
                    : 'rounded-lg border border-border p-2.5'
                }
              >
                <p className="text-sm leading-snug">{message.body}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {message.fromDriver ? 'You' : message.author} ·{' '}
                  {new Date(message.at).toLocaleTimeString('en-AU', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                  })}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* ── M4.8b — the form the builder demands before work starts ───── */}
      {needsRiskForm && (
        <Alert variant="warning" title="Site risk assessment required here">
          <p>
            {job.accountName} require the risk assessment on their portal before you start. It takes
            about a minute and works with no signal.
          </p>
          <Link
            to={`/jobs/${job.jobId}/risk-assessment`}
            className={buttonVariants({ size: 'sm' })}
          >
            <ShieldAlertIcon aria-hidden />
            Fill it in
          </Link>
        </Alert>
      )}

      {/* ── The single next action ────────────────────────────────────── */}
      {!finished && !failed && (
        <div className="space-y-2">
          {transition !== null && transition !== 'completed' && (
            <ActionButton
              label={DRIVER_TRANSITION_LABELS[transition]}
              hint={
                transition === 'arrived'
                  ? 'Starts the on-site clock and, where needed, the risk form'
                  : undefined
              }
              icon={transition === 'arrived' ? MapPinIcon : TruckIcon}
              pending={updateStatus.isPending}
              onClick={() => void advance(transition)}
            />
          )}

          {job.status === 'arrived' && (
            <>
              <ActionButton
                label="Photos"
                hint={
                  missingPhotos.length === 0
                    ? `${String(job.photos.length)} taken — all required shots done`
                    : `${String(missingPhotos.length)} still needed: ${missingPhotos.map((slot) => slot.label.toLowerCase()).join(', ')}`
                }
                icon={CameraIcon}
                tone={missingPhotos.length === 0 ? 'neutral' : 'warning'}
                onClick={() => void navigate(`/jobs/${job.jobId}/photos`)}
              />

              <ActionButton
                label={needsWeights ? 'Enter what you collected' : 'Weights recorded'}
                hint={
                  needsWeights
                    ? job.capturesWeight
                      ? 'Square metres, and the crane scale if it is bagged'
                      : 'Square metres — this customer does not record weight'
                    : `${String(job.capturedAreaM2 ?? 0)} m²${job.craneScaleKg !== null ? ` · ${String(job.craneScaleKg)} kg` : ''}`
                }
                icon={ScaleIcon}
                tone={needsWeights ? 'warning' : 'neutral'}
                onClick={() => void navigate(`/jobs/${job.jobId}/weights`)}
              />

              <ActionButton
                label="Complete job"
                hint={
                  completionBlockers.length > 0
                    ? `Still needed: ${completionBlockers.join(', ')}`
                    : 'Everything captured — send it to the office'
                }
                icon={CheckCircle2Icon}
                disabled={completionBlockers.length > 0}
                onClick={() => {
                  setCompleteOpen(true);
                }}
              />
            </>
          )}

          {/* The exception branches. Available from the moment the driver is en
              route, because "site closed" is discovered on arrival, not before. */}
          {(job.status === 'in-transit' || job.status === 'arrived') && (
            <div className="grid grid-cols-2 gap-2 pt-1">
              <ActionButton
                label="Can't collect"
                icon={CircleSlashIcon}
                tone="danger"
                onClick={() => void navigate(`/jobs/${job.jobId}/futile`)}
              />
              <ActionButton
                label="Contaminated"
                icon={TriangleAlertIcon}
                tone="warning"
                onClick={() => void navigate(`/jobs/${job.jobId}/contamination`)}
              />
            </div>
          )}
        </div>
      )}

      {finished && (
        <Alert variant="success" title="Job complete">
          Sent to the office with your photos, times and position. Nothing else to do here.
        </Alert>
      )}

      {job.status === 'futile' && (
        <Alert variant="destructive" title="Marked as could not collect">
          The office will review it. A $120 futile fee applies to the customer either way.
        </Alert>
      )}

      <button
        type="button"
        onClick={() => {
          setMessageOpen(true);
        }}
        className="focus-ring flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-border text-sm font-medium text-muted-foreground"
      >
        <MessageSquareIcon aria-hidden className="size-4" />
        Message the office about this job
      </button>

      {/* ── M4.10 — a plain note on completion (F41 is out of scope) ──── */}
      <Dialog
        open={completeOpen}
        onClose={() => {
          setCompleteOpen(false);
        }}
        title={`Complete job #${String(job.jobNumber)}?`}
        description="This goes to the office with your photos, times and position."
        footer={
          <>
            <button
              type="button"
              className="focus-ring min-h-12 rounded-lg px-4 text-sm text-muted-foreground"
              onClick={() => {
                setCompleteOpen(false);
              }}
              disabled={completeJob.isPending}
            >
              Not yet
            </button>
            <button
              type="button"
              className={`${buttonVariants({ size: 'lg' })} min-h-12`}
              onClick={() => void complete()}
              disabled={completeJob.isPending}
            >
              {completeJob.isPending && <Spinner label="Saving" />}
              Complete job
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Collected</dt>
              <dd className="font-medium">
                {job.capturedAreaM2 === null
                  ? '—'
                  : `${job.capturedAreaM2.toLocaleString('en-AU')} m²`}
              </dd>
            </div>
            {job.craneScaleKg !== null && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Crane scale</dt>
                <dd className="font-medium">{job.craneScaleKg} kg</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Load</dt>
              <dd className="font-medium">{LOAD_TYPE_LABELS[job.loadType].split(' —')[0]}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Photos</dt>
              <dd className="font-medium">{job.photos.length}</dd>
            </div>
          </dl>

          <Field
            id="complete-note"
            label="Anything worth recording?"
            hint="Optional. Extra time, access problems, anything the office should know."
          >
            {(control) => (
              <Textarea
                {...control}
                rows={3}
                maxLength={1000}
                value={note}
                placeholder="Bag was half buried in mud — needed 20 extra minutes."
                onChange={(event) => {
                  setNote(event.target.value);
                }}
              />
            )}
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={messageOpen}
        onClose={() => {
          setMessageOpen(false);
        }}
        title="Message the office"
        description="It lands on this job, so whoever picks it up has the context."
        footer={
          <>
            <button
              type="button"
              className="focus-ring min-h-12 rounded-lg px-4 text-sm text-muted-foreground"
              onClick={() => {
                setMessageOpen(false);
              }}
              disabled={sendMessage.isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`${buttonVariants({ size: 'lg' })} min-h-12`}
              onClick={() => void send()}
              disabled={sendMessage.isPending || messageBody.trim().length === 0}
            >
              {sendMessage.isPending && <Spinner label="Sending" />}
              Send
            </button>
          </>
        }
      >
        <Field id="driver-message" label="What do you need to tell them?">
          {(control) => (
            <Textarea
              {...control}
              rows={4}
              maxLength={500}
              value={messageBody}
              placeholder="Gate is locked and nobody is answering. Waiting out front."
              onChange={(event) => {
                setMessageBody(event.target.value);
              }}
            />
          )}
        </Field>
      </Dialog>
    </div>
  );
}
