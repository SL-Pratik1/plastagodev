import { EXCEPTION_REASONS, EXCEPTION_REASON_LABELS, type ExceptionReason } from '@plastago/shared';
import {
  Alert,
  ErrorState,
  Field,
  Skeleton,
  Spinner,
  Textarea,
  buttonVariants,
  cn,
  useToast,
} from '@plastago/ui';
import { CameraIcon, CircleSlashIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useAddPhoto, useDriverJob, useMarkFutile } from '@/features/run/queries';
import { currentPosition } from '@/lib/geolocation';

/**
 * Could not collect (M4.6 · W27).
 *
 * ── This is the money loop, and the form is built like it ──────────────────
 * The customer certified at booking that the job was ready and accessible
 * (M5.2). A photo, a GPS fix and a timestamp at the point of failure turn a
 * disputed phone call into an invoice line that survives challenge — so:
 *
 *  • **The reason is structured, never free text.** M2.5: it has to be reportable
 *    at month end (*"14 delays: 6 × site not ready, 4 × access blocked…"*) and
 *    chargeable where the customer certified otherwise.
 *  • **At least one photo is required**, and the submit button stays disabled
 *    until there is one. This is the single guard on the whole screen, because a
 *    futile charge with no picture is the one the customer wins.
 *  • **The fee is stated before the tap**, not discovered afterwards. The driver
 *    is about to cost the customer money and should know that is what they are
 *    doing.
 */

/** The five the doc names, in the order a driver meets them. */
const DRIVER_REASONS: readonly ExceptionReason[] = [
  'site-not-ready',
  'access-blocked',
  'nobody-on-site',
  'site-closed',
  'crane-unavailable',
];

export function JobFutilePage() {
  const { jobId } = useParams();
  const { data: job, error, isPending, refetch } = useDriverJob(jobId);

  if (error) {
    return (
      <ErrorState
        title="Could not open this job"
        description="Go back to your run and try again."
        onRetry={() => void refetch()}
      />
    );
  }

  if (isPending || !job) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  return <FutileForm key={job.jobId} job={job} />;
}

function FutileForm({ job }: { job: NonNullable<ReturnType<typeof useDriverJob>['data']> }) {
  const toast = useToast();
  const navigate = useNavigate();
  const markFutile = useMarkFutile();
  const addPhoto = useAddPhoto();

  const [reason, setReason] = useState<ExceptionReason | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  // Photos taken on this visit that are evidence of the failure, not of a
  // collection. Any photo on the job counts — the driver may already have shot
  // the front of the site before discovering the problem.
  const evidence = job.photos;

  const takePhoto = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';

    const submit = async (blob: Blob) => {
      setCapturing(true);
      try {
        await addPhoto.mutateAsync({
          jobId: job.jobId,
          slot: null,
          caption: 'Could not collect — evidence',
          blob,
        });
        setError(null);
      } catch {
        toast.error('Could not save that photo', 'Try again.');
      } finally {
        setCapturing(false);
      }
    };

    /*
     * Only a file the driver actually chose.
     *
     * This used to fall back to a stub blob — on `change` with no file, and
     * again on a 400ms timer after `click()` — so the demo could show the flow
     * without a camera. On a phone that timer ALWAYS wins: the camera app takes
     * seconds to open, and 400ms later a 22-byte text file has already been
     * filed as the evidence photo. The guard below then counts it, the office
     * approves the charge "by looking at the picture", and the picture is not an
     * image of anything.
     *
     * Cancelling the picker now does nothing at all, which is the honest
     * outcome — the driver is asked again for the photo, rather than handed a
     * receipt for one that does not exist.
     */
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      void submit(file);
    });
    input.click();
  };

  const submit = async () => {
    if (reason === null) {
      setError('Choose what stopped you — it has to be one of these, not free text.');
      return;
    }
    if (evidence.length === 0) {
      setError('Take at least one photo. Without it the charge does not stand up.');
      return;
    }

    setError(null);
    const position = await currentPosition();

    try {
      await markFutile.mutateAsync({
        jobId: job.jobId,
        input: {
          occurredAt: new Date().toISOString(),
          position,
          reason,
          note: note.trim(),
          photoIds: evidence.map((photo) => photo.id),
        },
      });
      toast.success('Reported', 'The office will review it. You can move on.');
      await navigate('/');
    } catch {
      toast.error('Could not save that', 'Try again — nothing was lost.');
    }
  };

  return (
    <div className="space-y-4">
      <Link
        to={`/jobs/${job.jobId}`}
        className="focus-ring inline-block rounded text-sm text-muted-foreground underline-offset-4"
      >
        ← Job #{job.jobNumber}
      </Link>

      <header>
        <h1 className="font-display text-lg font-semibold tracking-tight">Could not collect</h1>
        <p className="text-sm text-muted-foreground">
          {job.siteName}, {job.suburb}
        </p>
      </header>

      {/* No figure — Matt, 7:52. The consequence, not the price. */}
      <Alert variant="warning" title="This will be charged to the customer">
        They confirmed at booking that the job would be ready and a truck could get to it. Your
        photo, position and the time are what make the charge stand up.
      </Alert>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">What stopped you?</legend>
        <div className="space-y-2">
          {DRIVER_REASONS.map((option) => (
            <label
              key={option}
              className={cn(
                'focus-within:ring-ring/50 flex min-h-14 cursor-pointer items-center rounded-xl border px-4 text-sm focus-within:ring-2',
                reason === option
                  ? 'border-destructive bg-destructive/10 font-semibold'
                  : 'border-border bg-card',
              )}
            >
              <input
                type="radio"
                name="futile-reason"
                className="sr-only"
                checked={reason === option}
                onChange={() => {
                  setReason(option);
                  setError(null);
                }}
              />
              {EXCEPTION_REASON_LABELS[option]}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="rounded-xl border border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium">
              Photos <span className="text-muted-foreground">({evidence.length})</span>
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Show what you found. A locked gate, the board still on the wall, cars across the
              access.
            </p>
          </div>
          <button
            type="button"
            onClick={takePhoto}
            disabled={capturing}
            className={`${buttonVariants({ variant: 'outline' })} min-h-12 shrink-0`}
          >
            {capturing ? <Spinner label="Saving" /> : <CameraIcon aria-hidden />}
            Take
          </button>
        </div>
      </div>

      <Field
        id="futile-note"
        label="Anything else"
        hint="Optional. Who you spoke to, what they said."
      >
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            maxLength={500}
            value={note}
            placeholder="Rang Dave twice, no answer. Gate padlocked and no other access."
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        )}
      </Field>

      {error !== null && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={markFutile.isPending || reason === null || evidence.length === 0}
        className={cn(
          'focus-ring flex min-h-16 w-full items-center justify-center gap-2 rounded-xl bg-destructive text-base font-semibold text-destructive-foreground',
          (markFutile.isPending || reason === null || evidence.length === 0) && 'opacity-50',
        )}
      >
        {markFutile.isPending ? <Spinner label="Saving" /> : <CircleSlashIcon aria-hidden />}
        Report — could not collect
      </button>

      {EXCEPTION_REASONS.length > 0 && (
        <p className="text-center text-xs text-muted-foreground">
          Not sure? Ring the office on{' '}
          <a href="tel:1300395438" className="underline underline-offset-4">
            1300 395 438
          </a>{' '}
          before you leave.
        </p>
      )}
    </div>
  );
}
