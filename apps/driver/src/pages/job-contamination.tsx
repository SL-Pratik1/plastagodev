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
import { useAddPhoto, useDriverJob, useMarkContaminated } from '@/features/run/queries';
import { currentPosition } from '@/services/mock/create-mock-services';

/**
 * Contaminated load (M4.7 · W27, W32).
 *
 * ── The improvement over today is the two questions ───────────────────────
 * Currently this is a binary flag. Capturing *what* the contamination was and
 * *how much* makes it reportable and defensible — and it is what lets the office
 * identify repeat-offender sites rather than just absorbing the cost.
 *
 * The $90 charge goes into the approvals queue (M2.7), where somebody looks at
 * the photo and says yes. That is why the photo is mandatory here: the approver's
 * entire decision is looking at the picture, and a charge with no picture is one
 * the customer disputes successfully.
 *
 * ── The job is not stopped ────────────────────────────────────────────────
 * Unlike futile, reporting contamination does not end the pickup — the driver
 * takes the load anyway and the charge rides along with it. So this returns to
 * the job rather than to the run sheet.
 */
export function JobContaminationPage() {
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
        await addPhoto.mutateAsync({
          jobId: job.jobId,
          slot: null,
          caption: 'Contamination — evidence',
          blob,
        });
        setError(null);
      } catch {
        toast.error('Could not save that photo', 'Try again.');
      } finally {
        setCapturing(false);
      }
    };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      void submit(file ?? new Blob(['demo:contamination'], { type: 'image/jpeg' }));
    });
    input.click();
    window.setTimeout(() => {
      if (input.files?.length === 0 && !capturing) {
        void submit(new Blob(['demo:contamination'], { type: 'image/jpeg' }));
      }
    }, 400);
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
        'A $90 charge goes to the office for approval. Carry on with the pickup.',
      );
      await navigate(`/jobs/${job.jobId}`);
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
        <h1 className="font-display text-lg font-semibold tracking-tight">Contaminated load</h1>
        <p className="text-sm text-muted-foreground">
          {job.siteName}, {job.suburb}
        </p>
      </header>

      <Alert variant="warning" title="Take the load anyway">
        Report it and carry on with the pickup. A $90 charge goes to the office for approval — this
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
