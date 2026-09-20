import {
  CONTAMINATION_EXTENTS,
  CONTAMINATION_EXTENT_LABELS,
  CONTAMINATION_TYPES,
  CONTAMINATION_TYPE_LABELS,
  type ContaminationExtent,
  type ContaminationType,
} from '@plastago/shared';
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
import { CameraIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useAddPhoto, useDriverJob, useMarkContaminated } from '@/features/driver/queries';
import { currentPosition } from '@/lib/geolocation';

/**
 * Contaminated load (M4.7 · W27, W32).
 *
 * ── The improvement over today is the two questions ───────────────────────
 * Currently this is a binary flag. Capturing *what* the contamination was and
 * *how much* makes it reportable and defensible — and it is what lets the office
 * identify repeat-offender sites rather than just absorbing the cost.
 *
 * The charge goes into the approvals queue (M2.7), where somebody looks at
 * the photo and says yes. That is why the photo is mandatory here: the approver's
 * entire decision is looking at the picture, and a charge with no picture is one
 * the customer disputes successfully.
 *
 * ── The job is not stopped ────────────────────────────────────────────────
 * Unlike futile, reporting contamination does not end the pickup — the driver
 * takes the load anyway and the charge rides along with it. So this returns to
 * the job rather than to the run sheet.
 */
export function DriverJobContaminationPage() {
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

  return <ContaminationForm key={job.jobId} job={job} />;
}

function ContaminationForm({ job }: { job: NonNullable<ReturnType<typeof useDriverJob>['data']> }) {
  const toast = useToast();
  const navigate = useNavigate();
  const markContaminated = useMarkContaminated();
  const addPhoto = useAddPhoto();

  const [type, setType] = useState<ContaminationType | null>(null);
  const [extent, setExtent] = useState<ContaminationExtent | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  const evidence = job.photos.filter((photo) => photo.caption.startsWith('Contamination'));

  const takePhoto = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';

    const submit = async (blob: Blob) => {
      setCapturing(true);
      try {
        // This screen tells the driver the position is part of what makes the
        // charge stand up, so the photo had better carry one when it can.
        const position = await currentPosition();

        await addPhoto.mutateAsync({
          jobId: job.jobId,
          slot: null,
          caption: 'Contamination — evidence',
          blob,
          position,
        });
        setError(null);
      } catch {
        // Photos are the one driver action that needs signal — see the note in
        // the photos screen. Saying so beats a bare "try again".
        toast.error('Could not upload that photo', 'Photos need signal. Try again in range.');
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
    if (type === null) {
      setError('What was in the load?');
      return;
    }
    if (extent === null) {
      setError('How much of the load was affected?');
      return;
    }
    if (evidence.length === 0) {
      setError('Photograph it. The office approves this charge by looking at the picture.');
      return;
    }

    setError(null);
    const position = await currentPosition();

    try {
      await markContaminated.mutateAsync({
        jobId: job.jobId,
        input: {
          occurredAt: new Date().toISOString(),
          position,
          type,
          extent,
          note: note.trim(),
          photoIds: evidence.map((photo) => photo.id),
        },
      });
      toast.success(
        'Reported',
        'A charge goes to the office for approval. Carry on with the pickup.',
      );
      await navigate(`/driver/jobs/${job.jobId}`);
    } catch {
      toast.error('Could not save that', 'Try again — nothing was lost.');
    }
  };

  return (
    <div className="space-y-4">
      <Link
        to={`/driver/jobs/${job.jobId}`}
        className="focus-ring inline-block rounded text-sm text-muted-foreground underline-offset-4"
      >
        ← Job #{job.jobNumber}
      </Link>

      <header>
        <h1 className="font-display text-lg font-semibold tracking-tight">Contaminated load</h1>
        <p className="text-sm text-muted-foreground">
          {job.siteName}, {job.suburb}
        </p>
      </header>

      <Alert variant="warning" title="Take the load anyway">
        Report it and carry on with the pickup. A charge goes to the office for approval — this
        does not stop the job.
      </Alert>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">What was in it?</legend>
        <div className="space-y-2">
          {CONTAMINATION_TYPES.map((option) => (
            <label
              key={option}
              className={cn(
                'focus-within:ring-ring/50 flex min-h-14 cursor-pointer items-center rounded-xl border px-4 text-sm focus-within:ring-2',
                type === option
                  ? 'border-warning bg-warning/10 font-semibold'
                  : 'border-border bg-card',
              )}
            >
              <input
                type="radio"
                name="contamination-type"
                className="sr-only"
                checked={type === option}
                onChange={() => {
                  setType(option);
                  setError(null);
                }}
              />
              {CONTAMINATION_TYPE_LABELS[option]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">How much of the load?</legend>
        <div className="space-y-2">
          {CONTAMINATION_EXTENTS.map((option) => (
            <label
              key={option}
              className={cn(
                'focus-within:ring-ring/50 flex min-h-14 cursor-pointer items-center rounded-xl border px-4 text-sm focus-within:ring-2',
                extent === option
                  ? 'border-warning bg-warning/10 font-semibold'
                  : 'border-border bg-card',
              )}
            >
              <input
                type="radio"
                name="contamination-extent"
                className="sr-only"
                checked={extent === option}
                onChange={() => {
                  setExtent(option);
                  setError(null);
                }}
              />
              {CONTAMINATION_EXTENT_LABELS[option]}
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
              Get the contamination in frame — timber through the bag, insulation, whatever it is.
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

      <Field id="contamination-note" label="Anything else" hint="Optional.">
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            maxLength={500}
            value={note}
            placeholder="Timber offcuts right through the second bag."
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
        disabled={markContaminated.isPending || evidence.length === 0}
        className={cn(
          'focus-ring flex min-h-16 w-full items-center justify-center gap-2 rounded-xl bg-warning text-base font-semibold text-warning-foreground',
          (markContaminated.isPending || evidence.length === 0) && 'opacity-50',
        )}
      >
        {markContaminated.isPending ? (
          <Spinner label="Saving" />
        ) : (
          <TriangleAlertIcon aria-hidden />
        )}
        Report contamination
      </button>
    </div>
  );
}
