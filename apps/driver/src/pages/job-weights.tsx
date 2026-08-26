import { LOAD_TYPE_LABELS, LOAD_TYPES, type LoadType } from '@plastago/shared';
import {
  Alert,
  ErrorState,
  Field,
  Input,
  Skeleton,
  Spinner,
  buttonVariants,
  cn,
  useToast,
} from '@plastago/ui';
import { SaveIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useCaptureWeights, useDriverJob } from '@/features/run/queries';
import { currentPosition } from '@/services/mock/create-mock-services';

/**
 * What was collected (M4.3 · F34, W30, W44).
 *
 * ── m² and kg are two different quantities, not two units ─────────────────
 * The square metres are the board that was *installed* in the house — that is
 * what gets priced, and it is usually known from the builder's order before the
 * truck arrives. The kilograms are the waste actually *recovered*, weighed on the
 * day, and average around 6.8% of the installed board weight. Labelling them as
 * two readings of one thing is the mistake this screen exists to prevent.
 *
 * ── Why the kg field disappears rather than greying out ───────────────────
 * Two separate reasons, and they compound:
 *
 *  1. **Per-customer capture config (M2.3).** iPlasta, Fornari and Wisdom record
 *     m² only. Asking for a figure nobody will use trains the driver to type
 *     something to get past the field.
 *  2. **Hand loads cannot be weighed at all.** There is no bag to lift onto the
 *     crane scale. A zero here would enter the tip-off reconciliation (M4.4) as
 *     "we collected nothing" and skew the imputed weight of every other
 *     hand-load job on the run.
 *
 * So the field is absent, and the reason is on screen.
 */
export function JobWeightsPage() {
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
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }

  return <WeightsForm key={job.jobId} job={job} />;
}

function WeightsForm({ job }: { job: NonNullable<ReturnType<typeof useDriverJob>['data']> }) {
  const toast = useToast();
  const navigate = useNavigate();
  const capture = useCaptureWeights();

  const [loadType, setLoadType] = useState<LoadType>(job.loadType);
  const [area, setArea] = useState(
    job.capturedAreaM2 === null ? String(job.expectedAreaM2) : String(job.capturedAreaM2),
  );
  const [bags, setBags] = useState(String(job.bagCount));
  const [craneKg, setCraneKg] = useState(job.craneScaleKg === null ? '' : String(job.craneScaleKg));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const weighable = loadType === 'bagged' && job.capturesWeight;

  const save = async () => {
    const next: Record<string, string> = {};
    const areaValue = Number(area);
    const bagValue = Number(bags);
    const craneValue = craneKg.trim() === '' ? null : Number(craneKg);

    if (!Number.isFinite(areaValue) || areaValue <= 0) {
      next.area = 'Enter the square metres you collected.';
    } else if (areaValue > 100000) {
      next.area = 'That is larger than any job on record — check the figure.';
    }

    if (!Number.isInteger(bagValue) || bagValue < 0 || bagValue > 200) {
      next.bags = 'Whole bags, 0 to 200.';
    }

    if (weighable) {
      if (craneValue === null || !Number.isFinite(craneValue) || craneValue <= 0) {
        next.crane = 'Enter the crane scale reading — the tip-off maths needs it.';
      } else if (craneValue > 20000) {
        next.crane = 'That is heavier than the truck can lift. Check the scale.';
      }
    }

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const position = await currentPosition();
    try {
      await capture.mutateAsync({
        jobId: job.jobId,
        input: {
          occurredAt: new Date().toISOString(),
          position,
          areaM2: areaValue,
          bagCount: bagValue,
          loadType,
          craneScaleKg: weighable ? craneValue : null,
        },
      });
      toast.success('Saved on this phone', 'It goes to the office when you have signal.');
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
        <h1 className="font-display text-lg font-semibold tracking-tight">What did you collect?</h1>
        <p className="text-sm text-muted-foreground">
          {job.siteName} · expected {job.expectedAreaM2.toLocaleString('en-AU')} m²
        </p>
      </header>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">How was it loaded?</legend>
        <div className="grid grid-cols-2 gap-2">
          {LOAD_TYPES.map((option) => (
            <label
              key={option}
              className={cn(
                'focus-within:ring-ring/50 flex min-h-16 cursor-pointer flex-col justify-center rounded-xl border p-3 text-sm focus-within:ring-2',
                loadType === option
                  ? 'border-primary bg-primary/10 font-semibold'
                  : 'border-border bg-card',
              )}
            >
              <input
                type="radio"
                name="load-type"
                className="sr-only"
                checked={loadType === option}
                onChange={() => {
                  setLoadType(option);
                  setErrors({});
                }}
              />
              <span>{option === 'bagged' ? 'Bagged' : 'Hand load'}</span>
              <span className="mt-0.5 text-xs font-normal text-muted-foreground">
                {option === 'bagged' ? 'Weigh on the crane scale' : 'Cannot be weighed'}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <Field
        id="weights-area"
        label="Square metres collected"
        required
        error={errors.area}
        hint="What was actually there. Change it if the pile was bigger or smaller than booked."
      >
        {(control) => (
          <Input
            {...control}
            type="number"
            inputMode="numeric"
            min={1}
            step={10}
            // Big numeric field: typed on a phone, standing next to the pile.
            className="h-16 text-2xl font-semibold tabular-nums"
            value={area}
            onChange={(event) => {
              setArea(event.target.value);
              setErrors(({ area: _drop, ...rest }) => rest);
            }}
          />
        )}
      </Field>

      <Field id="weights-bags" label="Bags collected" error={errors.bags}>
        {(control) => (
          <Input
            {...control}
            type="number"
            inputMode="numeric"
            min={0}
            max={200}
            className="h-14 text-xl tabular-nums"
            value={bags}
            onChange={(event) => {
              setBags(event.target.value);
              setErrors(({ bags: _drop, ...rest }) => rest);
            }}
          />
        )}
      </Field>

      {weighable && (
        <Field
          id="weights-crane"
          label="Crane scale reading (kg)"
          required
          error={errors.crane}
          hint="The measured weight of this load. The tip-off reconciliation subtracts it."
        >
          {(control) => (
            <Input
              {...control}
              type="number"
              inputMode="decimal"
              min={1}
              step={5}
              className="h-16 text-2xl font-semibold tabular-nums"
              value={craneKg}
              onChange={(event) => {
                setCraneKg(event.target.value);
                setErrors(({ crane: _drop, ...rest }) => rest);
              }}
            />
          )}
        </Field>
      )}

      {loadType === 'hand-load' && (
        <Alert variant="info" title="Hand loads are not weighed">
          There is no bag to lift onto the scale, so we work the weight out at the end of the run
          from the tip-off figure. Just the square metres here.
        </Alert>
      )}

      {loadType === 'bagged' && !job.capturesWeight && (
        <Alert variant="info" title="This customer records square metres only">
          {job.accountName} do not have us record weight, so there is nothing to enter. The tip-off
          figure still covers the whole load.
        </Alert>
      )}

      <button
        type="button"
        onClick={() => void save()}
        disabled={capture.isPending}
        className={`${buttonVariants({ size: 'lg' })} min-h-16 w-full text-base`}
      >
        {capture.isPending ? <Spinner label="Saving" /> : <SaveIcon aria-hidden />}
        Save
      </button>

      <p className="text-center text-xs text-muted-foreground">{LOAD_TYPE_LABELS[loadType]}</p>
    </div>
  );
}
