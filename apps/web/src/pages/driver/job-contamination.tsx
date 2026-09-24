import {
  CONTAMINATION_EXTENTS,
  CONTAMINATION_EXTENT_LABELS,
  CONTAMINATION_TYPES,
  CONTAMINATION_TYPE_LABELS,
  EVIDENCE_PHOTO_CAPTIONS,
  EVIDENCE_PHOTO_SLOTS,
  type ContaminationExtent,
  type ContaminationType,
  type DriverContamination,
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
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { PhotoThumb } from '@/components/driver/photo-grid';
import { evidencePhotos } from '@/components/driver/photo-rules';
import {
  useAddPhoto,
  useDriverJob,
  useMarkContaminated,
  useRemovePhoto,
} from '@/features/driver/queries';
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

  /*
   * ⚠️ One report per job, so the form is for a job that has none.
   *
   * It used to render every time, including where the phone's Back button lands
   * straight after submitting — the driver saw the form again, took it that the
   * report had not gone, and filed it again. One job carries eleven.
   */
  if (job.contamination !== null) {
    return (
      <ReportClosed
        jobId={job.jobId}
        jobNumber={job.jobNumber}
        tone="success"
        title="Contamination already reported"
      >
        <p>{describeReport(job.contamination)}</p>
        <p>If something in it is wrong, message the office from the job.</p>
      </ReportClosed>
    );
  }

  if (job.status === 'futile' || job.status === 'cancelled') {
    return (
      <ReportClosed
        jobId={job.jobId}
        jobNumber={job.jobNumber}
        tone="info"
        title="There is no load to report on"
      >
        {job.status === 'cancelled'
          ? 'The office cancelled this job — do not collect it.'
          : 'This job was reported as could not collect.'}
      </ReportClosed>
    );
  }

  return <ContaminationForm key={job.jobId} job={job} onStale={() => void refetch()} />;
}

/** "Timber offcuts · Heavy · reported 14:32" — what the job's report said. */
function describeReport(report: DriverContamination): string {
  const at = new Date(report.reportedAt).toLocaleTimeString('en-AU', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const what = [
    report.type === null ? null : CONTAMINATION_TYPE_LABELS[report.type],
    report.extent === null ? null : CONTAMINATION_EXTENT_LABELS[report.extent].split(' —')[0],
  ].filter((part): part is string => part !== null && part !== undefined);

  return [...what, `reported ${at}`].join(' · ');
}

/** In place of the form, when there is nothing left to report. */
function ReportClosed({
  jobId,
  jobNumber,
  tone,
  title,
  children,
}: {
  jobId: string;
  jobNumber: number;
  tone: 'success' | 'info';
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <Link
        to={`/driver/jobs/${jobId}`}
        className="focus-ring inline-block rounded text-sm text-muted-foreground underline-offset-4"
      >
        ← Job #{jobNumber}
      </Link>
      <Alert variant={tone} title={title}>
        {children}
      </Alert>
      <Link
        to={`/driver/jobs/${jobId}`}
        className={`${buttonVariants({ size: 'lg' })} min-h-14 w-full`}
      >
        Back to the job
      </Link>
    </div>
  );
}

function ContaminationForm({
  job,
  onStale,
}: {
  job: NonNullable<ReturnType<typeof useDriverJob>['data']>;
  /** Re-signs the thumbnails' read URLs; see the note on `PhotoThumb`. */
  onStale: () => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const markContaminated = useMarkContaminated();
  const addPhoto = useAddPhoto();
  const removePhoto = useRemovePhoto();

  const [type, setType] = useState<ContaminationType | null>(null);
  const [extent, setExtent] = useState<ContaminationExtent | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  /**
   * The photos filed under this report's own slot, and nothing else.
   *
   * ── Why the slot and not "what this screen captured" ──────────────────────
   * The guard once counted any photo captioned "Contamination", and a second
   * report on the same job was satisfied by the FIRST report's photograph.
   * Tracking this visit's captures fixed that and broke something else: leave
   * the screen and come back, and the photo just taken was gone from the list
   * while still sitting on the job. A job now takes one report, so every photo
   * under the contamination slot is this report's — and they stay listed.
   */
  const evidence = evidencePhotos(job.photos, 'contamination');

  /*
   * A wrong shot has to be removable here, before the office approves a
   * charge by looking at it. This screen showed a count and nothing else.
   */
  const remove = async (photoId: string) => {
    try {
      await removePhoto.mutateAsync({ jobId: job.jobId, photoId });
      toast.success('Photo removed');
    } catch {
      toast.error('Could not remove that photo');
    }
  };

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
          // Its own slot, so it is this report's evidence and not a checklist extra.
          slot: EVIDENCE_PHOTO_SLOTS.contamination,
          caption: EVIDENCE_PHOTO_CAPTIONS.contamination,
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
      /*
       * ⚠️ Deliberately does not promise a charge.
       *
       * This write goes through the offline outbox (`queue`), which resolves as
       * soon as the action is stored on the phone — hours before the server sees
       * it. The endpoint now answers with `ContaminationOutcome.chargeRaised`,
       * because a job carries at most one contamination charge and a second
       * report raises nothing, but a queued write cannot read that response.
       *
       * So the copy states only what is certainly true: the report is recorded.
       * It used to say "a charge goes to the office for approval", which was a
       * promise this screen was in no position to make — and was simply false on
       * a second report, where the driver walked away believing the load was
       * covered.
       */
      toast.success('Reported', 'The office has it. Carry on with the pickup.');
      // `replace`, so Back does not return to the form for a job already reported.
      await navigate(`/driver/jobs/${job.jobId}`, { replace: true });
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

      {/*
        One report per job, and it cannot be changed from the phone once sent —
        so the copy says so before the tap rather than after.
      */}
      <Alert variant="warning" title="Take the load anyway">
        Report it and carry on with the pickup — this does not stop the job. A job takes one report,
        and it raises a contamination charge for the office to approve.
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

        {/*
          The shots themselves, not just a count — the driver has to be able to
          see whether the camera caught the timber or their thumb, and remove it.
          Keyed on the URL so an expired signature remounts the tile with the
          fresh one; see the note on `PhotoThumb`.
        */}
        {evidence.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-3">
            {evidence.map((photo) => (
              <li key={photo.id}>
                <PhotoThumb
                  key={photo.url ?? photo.id}
                  photo={photo}
                  label={photo.caption}
                  onRemove={() => void remove(photo.id)}
                  onStale={onStale}
                />
              </li>
            ))}
          </ul>
        )}
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
