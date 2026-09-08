import { RISK_CONTROLS, SITE_HAZARDS } from '@plastago/shared';
import {
  Alert,
  Checkbox,
  ErrorState,
  Field,
  Label,
  Skeleton,
  Spinner,
  Textarea,
  buttonVariants,
  cn,
  useToast,
} from '@plastago/ui';
import {
  CheckCircle2Icon,
  FileTextIcon,
  QrCodeIcon,
  ShieldAlertIcon,
  UploadCloudIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useDriverJob, useSubmitRiskAssessment } from '@/features/run/queries';
import { useOnlineStatus } from '@/offline/use-offline-state';
import { currentPosition } from '@/lib/geolocation';

/**
 * Site Risk Assessment (M4.8b · F56, F14, W37, W41).
 *
 * ── This is a five-step workflow, not a checklist ─────────────────────────
 * Matt described the sequence precisely:
 *
 * ```
 * Driver taps ARRIVED
 *    ↓  the form pops up automatically
 *    ↓  driver completes it on the spot
 *    ↓  PDF generated — page 1 the assessment, page 2 the versioned SWMS
 *    ↓  driver SCANS THE QR CODE on the site fence
 *    ↓  the PDF uploads to the BUILDER'S OWN PORTAL
 *    ↓  job proceeds
 * ```
 *
 * Required by some clients for **every** site before the driver may start, and
 * it is the largest single item in M4: form engine, PDF generation, PDF merge,
 * camera QR scanning, and a handoff to an external URL — all of which must work
 * at a fence with no signal.
 *
 * ── What is built here, and what is honestly not ──────────────────────────
 * The form, the hazard/control capture, the QR step and the queued-handoff state
 * are real. The **PDF generation and the upload to the builder's portal are
 * server-side** and are shown as pipeline states rather than faked — a mocked PDF
 * would suggest a capability that does not exist yet, and this is the one screen
 * where a client might reasonably assume otherwise.
 *
 * The steps after the form are recorded as *states on the submission* rather than
 * as prerequisites for saving, which is what makes the offline case work: the
 * assessment is captured and queued at the fence, and the PDF and handoff happen
 * when there is signal.
 */
export function JobRiskAssessmentPage() {
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
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    );
  }

  return <RiskForm key={job.jobId} job={job} />;
}

/** The standard SWMS merged in as page 2. Versioned, and "updated yearly". */
const SWMS_VERSION = 'SWMS-2026.1';

function RiskForm({ job }: { job: NonNullable<ReturnType<typeof useDriverJob>['data']> }) {
  const toast = useToast();
  const navigate = useNavigate();
  const online = useOnlineStatus();
  const submit = useSubmitRiskAssessment();

  const [hazards, setHazards] = useState<string[]>([]);
  const [controls, setControls] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [safe, setSafe] = useState(true);
  const [portalCode, setPortalCode] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const noHazards = hazards.includes('no-hazards');

  const toggle = (list: string[], setList: (next: string[]) => void, key: string) => {
    /*
     * "No significant hazards" is exclusive both ways.
     *
     * Ticking it alongside "open excavation" is not a form error to explain — it
     * is a contradiction that should be impossible to express, because whoever
     * reads the record later cannot tell which half the driver meant.
     */
    if (key === 'no-hazards') {
      setList(list.includes(key) ? [] : ['no-hazards']);
      return;
    }
    const without = list.filter((item) => item !== 'no-hazards');
    setList(without.includes(key) ? without.filter((item) => item !== key) : [...without, key]);
  };

  const save = async () => {
    const next: Record<string, string> = {};
    if (hazards.length === 0) {
      next.hazards = 'Tick what you can see, or "no significant hazards".';
    }
    if (controls.length === 0) {
      next.controls = 'What are you doing about it? Tick at least one.';
    }
    if (!safe && note.trim().length === 0) {
      next.note = 'If it is not safe, say why — the office acts on this immediately.';
    }

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const position = await currentPosition();
    try {
      await submit.mutateAsync({
        occurredAt: new Date().toISOString(),
        position,
        jobId: job.jobId,
        hazardKeys: hazards,
        controlKeys: controls,
        note: note.trim(),
        safeToProceed: safe,
        swmsVersion: SWMS_VERSION,
        builderPortalCode: portalCode.trim() === '' ? null : portalCode.trim(),
      });

      toast.success(
        safe ? 'Risk assessment saved' : 'Unsafe site reported',
        safe
          ? online
            ? 'Your PDF copy is on the job — share it to the builder’s portal.'
            : 'Your PDF copy appears on the job when you have signal.'
          : 'The office has been alerted. Do not start until they call you.',
      );
      await navigate(`/jobs/${job.jobId}`);
    } catch {
      toast.error('Could not save that', 'Try again — nothing was lost.');
    }
  };

  /*
   * The QR scan.
   *
   * A real implementation opens the camera and decodes with `BarcodeDetector`
   * where available. Here the code can be typed, which is the fallback a real
   * build needs anyway: fence signs get muddy, and a driver who cannot scan must
   * still be able to proceed rather than being stuck at a gate.
   */
  const scan = () => {
    toast.info(
      'Camera scanning is not in this build',
      'Type the code from the fence sign instead — the real app scans it.',
    );
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
        <h1 className="font-display text-lg font-semibold tracking-tight">Site risk assessment</h1>
        <p className="text-sm text-muted-foreground">
          {job.siteName}, {job.suburb} · {job.accountName}
        </p>
      </header>

      {/*
       * Whose idea this form was.
       *
       * Matt, 1:07:40: *"I'd say make it optional because the driver will know
       * which ones he needs to do it for or not."* On a site nobody flagged, the
       * driver has chosen to fill one in — saying so out loud is the difference
       * between a tool they reach for and a form they assume is a mistake.
       */}
      {!job.riskAssessmentRequired && (
        <Alert variant="info" title="Not required here — you have chosen to do one">
          {job.accountName} do not ask for an assessment on this site. Fill it in anyway if the site
          warrants it; it is filed against the job either way.
        </Alert>
      )}

      <Alert variant="info" title="Works with no signal">
        Fill it in here at the fence. If you have no coverage it saves on the phone and goes to the
        builder&rsquo;s portal as soon as you do.
      </Alert>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">What can you see on this site?</legend>
        <ul className="space-y-1.5">
          {SITE_HAZARDS.map((hazard) => (
            <li key={hazard.key}>
              <label
                className={cn(
                  'focus-within:ring-ring/50 flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 text-sm focus-within:ring-2',
                  hazards.includes(hazard.key)
                    ? 'border-primary bg-primary/10 font-medium'
                    : 'border-border bg-card',
                  noHazards && hazard.key !== 'no-hazards' && 'opacity-45',
                )}
              >
                <Checkbox
                  checked={hazards.includes(hazard.key)}
                  onChange={() => {
                    toggle(hazards, setHazards, hazard.key);
                    setErrors(({ hazards: _drop, ...rest }) => rest);
                  }}
                />
                {hazard.label}
              </label>
            </li>
          ))}
        </ul>
        {errors.hazards !== undefined && (
          <p role="alert" className="text-sm font-medium text-destructive">
            {errors.hazards}
          </p>
        )}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">What are you doing about it?</legend>
        <ul className="space-y-1.5">
          {RISK_CONTROLS.map((control) => (
            <li key={control.key}>
              <label
                className={cn(
                  'focus-within:ring-ring/50 flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 text-sm focus-within:ring-2',
                  controls.includes(control.key)
                    ? 'border-primary bg-primary/10 font-medium'
                    : 'border-border bg-card',
                )}
              >
                <Checkbox
                  checked={controls.includes(control.key)}
                  onChange={() => {
                    toggle(controls, setControls, control.key);
                    setErrors(({ controls: _drop, ...rest }) => rest);
                  }}
                />
                {control.label}
              </label>
            </li>
          ))}
        </ul>
        {errors.controls !== undefined && (
          <p role="alert" className="text-sm font-medium text-destructive">
            {errors.controls}
          </p>
        )}
      </fieldset>

      <Field
        id="risk-note"
        label="Anything else"
        error={errors.note}
        hint="Optional, unless you are calling the site unsafe."
      >
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            maxLength={500}
            value={note}
            placeholder="Powerlines run directly over the only crane position."
            onChange={(event) => {
              setNote(event.target.value);
              setErrors(({ note: _drop, ...rest }) => rest);
            }}
          />
        )}
      </Field>

      {/* ── Step 4 — the QR code on the site fence ─────────────────────── */}
      <div className="rounded-xl border border-border p-3">
        <p className="flex items-center gap-2 text-sm font-medium">
          <QrCodeIcon aria-hidden className="size-4 text-muted-foreground" />
          Builder&rsquo;s site code
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Scan the QR code on the fence, or type it. Leave it blank if this site has no sign.
        </p>
        <div className="mt-2 flex gap-2">
          <input
            aria-label="Builder's site code"
            className="focus-ring h-12 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 font-mono text-sm"
            placeholder="DOM-CF-1097"
            value={portalCode}
            onChange={(event) => {
              setPortalCode(event.target.value.toUpperCase());
            }}
          />
          <button
            type="button"
            onClick={scan}
            className={`${buttonVariants({ variant: 'outline' })} min-h-12 shrink-0`}
          >
            <QrCodeIcon aria-hidden />
            Scan
          </button>
        </div>
      </div>

      {/* What happens after saving — stated, not simulated. */}
      <div className="rounded-xl border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        <p className="flex items-center gap-1.5 font-medium text-foreground">
          <FileTextIcon aria-hidden className="size-3.5" />
          What happens next
        </p>
        <ol className="mt-1.5 ml-4 list-decimal space-y-0.5">
          <li>This assessment becomes page 1 of a PDF.</li>
          <li>Our standard SWMS ({SWMS_VERSION}) is attached as page 2.</li>
          <li>The PDF is filed against job #{job.jobNumber} for the office.</li>
          <li>
            You get your own copy to share
            {online ? '' : ' — it appears as soon as you have signal'}.
          </li>
          <li>
            It also goes to {job.accountName}&rsquo;s portal
            {online ? '' : ' when you are back in coverage'}.
          </li>
        </ol>
        <p className="mt-1.5 flex items-center gap-1.5">
          <UploadCloudIcon aria-hidden className="size-3.5 shrink-0" />
          Generation and the portal upload happen in the office system, not on this phone.
        </p>
      </div>

      <div className="rounded-xl border border-border p-3">
        <div className="flex items-start gap-3">
          <Checkbox
            id="risk-safe"
            checked={!safe}
            onChange={(event) => {
              setSafe(!event.target.checked);
              setErrors({});
            }}
          />
          <div>
            <Label htmlFor="risk-safe" className="font-normal">
              This site is not safe to work — stopping
            </Label>
            <p className="text-xs text-muted-foreground">
              Tick this and the office is alerted straight away. Do not start.
            </p>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={() => void save()}
        disabled={submit.isPending}
        className={cn(
          'focus-ring flex min-h-16 w-full items-center justify-center gap-2 rounded-xl text-base font-semibold',
          safe
            ? 'bg-primary text-primary-foreground'
            : 'bg-destructive text-destructive-foreground',
          submit.isPending && 'opacity-50',
        )}
      >
        {submit.isPending ? (
          <Spinner label="Saving" />
        ) : safe ? (
          <CheckCircle2Icon aria-hidden />
        ) : (
          <ShieldAlertIcon aria-hidden />
        )}
        {safe ? 'Save and start work' : 'Report unsafe site'}
      </button>
    </div>
  );
}
