import { Alert, ErrorState, Skeleton, buttonVariants, useToast } from '@plastago/ui';
import { CheckCircle2Icon } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { useState } from 'react';
import { PhotoGrid } from '@/components/driver/photo-grid';
import { missingRequiredPhotos } from '@/components/driver/photo-rules';
import { useAddPhoto, useDriverJob, useRemovePhoto } from '@/features/driver/queries';

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
export function DriverJobPhotosPage() {
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
        toast.success('Photo saved on this phone', 'It uploads when you have signal.');
      } catch {
        toast.error('Could not save that photo', 'Try again.');
      } finally {
        setBusySlot(null);
      }
    };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      void submit(file ?? new Blob([`demo:${caption}`], { type: 'image/jpeg' }));
    });

    // Cancelling the picker fires no event on most browsers, so the demo path
    // needs a way through. `showPicker` is unavailable for file inputs, hence
    // the click plus a fallback if nothing arrives.
    input.click();
    window.setTimeout(() => {
      if (input.files?.length === 0 && busySlot === null) {
        void submit(new Blob([`demo:${caption}`], { type: 'image/jpeg' }));
      }
    }, 400);
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
        to={`/driver/jobs/${job.jobId}`}
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
        to={`/driver/jobs/${job.jobId}`}
        className={`${buttonVariants({ size: 'lg' })} min-h-14 w-full`}
      >
        <CheckCircle2Icon aria-hidden />
        Back to the job
      </Link>
    </div>
  );
}
