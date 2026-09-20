import { DEFECT_SEVERITIES, DEFECT_SEVERITY_LABELS, type DefectSeverity } from '@plastago/shared';
import { Alert, Field, Input, Spinner, Textarea, buttonVariants, cn, useToast } from '@plastago/ui';
import { CameraIcon, PhoneIcon, WrenchIcon } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useReportDefect, useRunSheet, useUploadDefectPhoto } from '@/features/driver/queries';
import { todayInSydney } from '@/lib/geolocation';
import { currentPosition } from '@/lib/geolocation';

/**
 * Vehicle defect (M4.9 · F43, W33).
 *
 * ── Why severity is three plain sentences and not a number ────────────────
 * Because the only decision this drives is what the office does in the next hour.
 * "Keep an eye on it" goes on the maintenance list; "needs booking in" gets a
 * workshop slot; "unsafe to drive" means somebody rings the driver *now*. A 1–5
 * scale would make the driver guess at a threshold nobody has defined, and the
 * office guess back.
 *
 * ── The unsafe path deliberately interrupts ───────────────────────────────
 * Picking "unsafe to drive" replaces the submit button's subtitle with the
 * office's phone number. A queued report is not good enough when the answer is
 * "stop driving" — and the driver may have no signal, which is precisely when a
 * form is the wrong channel.
 */
export function DriverReportDefectPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { data: day } = useRunSheet(todayInSydney());
  const report = useReportDefect();
  const uploadPhoto = useUploadDefectPhoto();

  const [severity, setSeverity] = useState<DefectSeverity | null>(null);
  const [summary, setSummary] = useState('');
  const [detail, setDetail] = useState('');
  const [photoIds, setPhotoIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  /**
   * ⚠️ This used to upload nothing whatsoever.
   *
   * It pushed a `crypto.randomUUID()` into `photoIds` and toasted "Photo saved
   * on this phone" — and it did so on a 400ms TIMER as well as on `change`, so
   * on a real phone, where the camera takes seconds to open, the timer always
   * won. The driver got the confirmation before they had even framed the shot,
   * cancelling changed nothing, and the API discarded the invented id because it
   * was not a valid reference. A cracked windscreen photographed three times
   * reached the workshop as a defect report with no pictures.
   *
   * Now it presigns, PUTs the bytes and keeps the storage key the server hands
   * back. Cancelling the picker does nothing at all, which is the honest
   * outcome: the driver is asked again rather than handed a receipt for a photo
   * that does not exist.
   */
  const takePhoto = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;

      void (async () => {
        try {
          const key = await uploadPhoto.mutateAsync(file);
          setPhotoIds((current) => [...current, key]);
          toast.success('Photo uploaded');
        } catch {
          toast.error('Could not upload that photo', 'Photos need signal. Try again in range.');
        }
      })();
    });

    input.click();
  };

  const save = async () => {
    const next: Record<string, string> = {};
    if (severity === null) next.severity = 'How bad is it?';
    if (summary.trim().length === 0) next.summary = 'Say what is wrong in a few words.';

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const position = await currentPosition();
    try {
      await report.mutateAsync({
        occurredAt: new Date().toISOString(),
        position,
        // The server files it against the truck paired with this driver and
        // ignores what is sent here; this keeps the payload honest either way.
        vehicleRego: day?.vehicleRego ?? 'Unknown',
        severity: severity as DefectSeverity,
        summary: summary.trim(),
        detail: detail.trim(),
        photoIds,
      });
      toast.success(
        'Reported',
        severity === 'unroadworthy'
          ? 'Ring the office as well — do not keep driving.'
          : 'It lands against the vehicle record for the office.',
      );
      await navigate('/driver');
    } catch {
      toast.error('Could not save that', 'Try again — nothing was lost.');
    }
  };

  /*
   * Same stop as the pre-start: a defect is found again by matching the plate,
   * so one filed with no truck paired lands where nobody looks. Blocking beats
   * accepting a report the office will never see.
   */
  if (day !== undefined && day.vehicleRego === null) {
    return (
      <div className="space-y-4">
        <header>
          <h1 className="font-display text-lg font-semibold tracking-tight">Report a problem</h1>
        </header>

        <Alert variant="destructive" title="No vehicle is assigned to you">
          A defect is recorded against a truck, so the office has to pair you with yours first.
          Ring them on the number below — and if it is unsafe to drive, tell them now rather than
          waiting for this screen.
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="font-display text-lg font-semibold tracking-tight">Report a problem</h1>
        <p className="text-sm text-muted-foreground">
          {day?.vehicleRego ?? 'Your vehicle'}
          {day?.vehicleLabel !== null &&
            day?.vehicleLabel !== undefined &&
            ` · ${day.vehicleLabel}`}
        </p>
      </header>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">How bad is it?</legend>
        <div className="space-y-2">
          {DEFECT_SEVERITIES.map((option) => (
            <label
              key={option}
              className={cn(
                'focus-within:ring-ring/50 flex min-h-14 cursor-pointer items-center rounded-xl border px-4 text-sm focus-within:ring-2',
                severity === option
                  ? option === 'unroadworthy'
                    ? 'border-destructive bg-destructive/10 font-semibold'
                    : 'border-primary bg-primary/10 font-semibold'
                  : 'border-border bg-card',
              )}
            >
              <input
                type="radio"
                name="defect-severity"
                className="sr-only"
                checked={severity === option}
                onChange={() => {
                  setSeverity(option);
                  setErrors(({ severity: _drop, ...rest }) => rest);
                }}
              />
              {DEFECT_SEVERITY_LABELS[option]}
            </label>
          ))}
        </div>
        {errors.severity !== undefined && (
          <p role="alert" className="text-sm font-medium text-destructive">
            {errors.severity}
          </p>
        )}
      </fieldset>

      {severity === 'unroadworthy' && (
        <Alert variant="destructive" title="Do not keep driving">
          <p>Ring the office now. A queued report is not enough when the truck is unsafe.</p>
          <a
            href="tel:1300395438"
            className={`${buttonVariants({ variant: 'outline', size: 'sm' })} min-h-12`}
          >
            <PhoneIcon aria-hidden />
            1300 395 438
          </a>
        </Alert>
      )}

      <Field id="defect-summary" label="What is wrong?" required error={errors.summary}>
        {(control) => (
          <Input
            {...control}
            className="h-14"
            maxLength={120}
            value={summary}
            placeholder="Nearside rear tyre worn to the bars"
            onChange={(event) => {
              setSummary(event.target.value);
              setErrors(({ summary: _drop, ...rest }) => rest);
            }}
          />
        )}
      </Field>

      <Field id="defect-detail" label="More detail" hint="Optional. When it started, what it does.">
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            maxLength={500}
            value={detail}
            placeholder="Started making a noise on the way to Austral. Worse under load."
            onChange={(event) => {
              setDetail(event.target.value);
            }}
          />
        )}
      </Field>

      <div className="rounded-xl border border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium">
              Photos <span className="text-muted-foreground">({photoIds.length})</span>
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              A picture saves the workshop a phone call.
            </p>
          </div>
          <button
            type="button"
            onClick={takePhoto}
            disabled={uploadPhoto.isPending}
            className={`${buttonVariants({ variant: 'outline' })} min-h-12 shrink-0`}
          >
            {uploadPhoto.isPending ? <Spinner aria-hidden /> : <CameraIcon aria-hidden />}
            {uploadPhoto.isPending ? 'Uploading' : 'Take'}
          </button>
        </div>
      </div>

      <button
        type="button"
        onClick={() => void save()}
        disabled={report.isPending}
        className={`${buttonVariants({ size: 'lg' })} min-h-16 w-full text-base`}
      >
        {report.isPending ? <Spinner label="Saving" /> : <WrenchIcon aria-hidden />}
        Send to the office
      </button>
    </div>
  );
}
