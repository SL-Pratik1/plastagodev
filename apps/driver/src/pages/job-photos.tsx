import { Alert, ErrorState, Skeleton, buttonVariants, useToast } from '@plastago/ui';
import { CheckCircle2Icon } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { useState } from 'react';
import { PhotoGrid } from '@/components/driver/photo-grid';
import { missingRequiredPhotos } from '@/components/driver/photo-rules';
import { useAddPhoto, useDriverJob, useRemovePhoto } from '@/features/run/queries';

/**
 * Photo capture (M4.5 · F7, F14, W28, W34).
 *
 * ── Their protocol, prompted rather than remembered ───────────────────────
 * Front of site · pile before · pile after · site closed · and cars on site if
 * it could not be closed. Typically ten photos a job, sometimes twenty, and no
 * limit — Matt was explicit. The last shot is pure commercial defence: *"we get
 * blamed for leaving everything open, so we take evidential proof that this
 * person was still here when we left."*
 *
 * ── The camera, and what stands in for it here ────────────────────────────
 * A real capture uses `<input type="file" capture="environment">` so the phone
 * opens the camera directly rather than a file browser. That input is here and
 * wired; on a desktop it falls back to a file picker, and with nothing selected
 * the demo records a placeholder so the queueing and upload states can still be
 * exercised. The bytes are irrelevant to everything this screen is testing.
 */
export function JobPhotosPage() {
  const { jobId } = useParams();
  const toast = useToast();
  const { data: job, error, isPending, refetch } = useDriverJob(jobId);

  const addPhoto = useAddPhoto();
  const removePhoto = useRemovePhoto();
  const [busySlot, setBusySlot] = useState<string | null>(null);

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

  const capture = (slot: string | null, caption: string) => {
    /*
     * A real file input, created on demand.
     *
     * `capture="environment"` is what makes a phone open the rear camera instead
     * of a photo library — the difference between one tap and four. Created here
     * rather than rendered because there is one per slot and a hidden input per
     * row would be six inputs the driver can tab into by accident.
     */
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';

    const submit = async (blob: Blob) => {
      setBusySlot(slot ?? 'extra');
      try {
        await addPhoto.mutateAsync({ jobId: job.jobId, slot, caption, blob });
        /*
         * ⚠️ "Saved on this phone, uploads when you have signal" is what every
         * other driver write can honestly say, and it is the one thing this one
         * cannot. Photos do not go through the outbox: `addPhoto` presigns,
         * PUTs the bytes to storage and only then resolves, so by the time this
         * line runs the photo is already off the phone. Telling a driver with
         * full signal that their evidence is sitting in a queue invites them to
         * go back and retake it.
         */
        toast.success('Photo uploaded');
      } catch {
        // The honest failure, and the only driver action that genuinely needs
        // signal — worth saying so rather than a bare "try again".
        toast.error('Could not upload that photo', 'Photos need signal. Try again in range.');
      } finally {
        setBusySlot(null);
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

  const remove = async (photoId: string) => {
    try {
      await removePhoto.mutateAsync({ jobId: job.jobId, photoId });
      toast.success('Photo removed');
    } catch {
      toast.error('Could not remove that photo');
    }
  };

  const missing = missingRequiredPhotos(job.photos, job.requiredPhotos);

  return (
    <div className="space-y-4">
      <Link
        to={`/jobs/${job.jobId}`}
        className="focus-ring inline-block rounded text-sm text-muted-foreground underline-offset-4"
      >
        ← Job #{job.jobNumber}
      </Link>

      <header>
        <h1 className="font-display text-lg font-semibold tracking-tight">Photos</h1>
        <p className="text-sm text-muted-foreground">
          {job.photos.length} taken. These are what defend the charges, so the standard shots are
          listed rather than left to memory.
        </p>
      </header>

      {missing.length === 0 ? (
        <Alert variant="success" title="All the required shots are done">
          Anything else you take is extra and always welcome.
        </Alert>
      ) : (
        <Alert variant="warning" title={`${String(missing.length)} still needed`}>
          {missing.map((slot) => slot.label).join(', ')}
        </Alert>
      )}

      <PhotoGrid
        photos={job.photos}
        required={job.requiredPhotos}
        onCapture={capture}
        onRemove={(photoId) => void remove(photoId)}
        busySlot={busySlot}
      />

      <Link
        to={`/jobs/${job.jobId}`}
        className={`${buttonVariants({ size: 'lg' })} min-h-14 w-full`}
      >
        <CheckCircle2Icon aria-hidden />
        Back to the job
      </Link>
    </div>
  );
}
