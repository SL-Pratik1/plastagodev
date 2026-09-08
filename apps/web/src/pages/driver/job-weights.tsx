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
import { useCaptureWeights, useDriverJob } from '@/features/driver/queries';
import { currentPosition } from '@/lib/geolocation';

/**
 * What was collected (M4.3 · F34, W30, W44).
 *
 * ── m² and kg are two different quantities, not two units ─────────────────
 * The square metres are the board that was *installed* in the house — that is
 * what gets priced, and it is known from the builder's order before the truck
 * arrives. The kilograms are the waste actually *recovered*, weighed on the day,
 * and average around 6.8% of the installed board weight. Labelling them as two
 * readings of one thing is the mistake this screen exists to prevent.
 *
 * ── Why the driver is not asked for m² ────────────────────────────────────
 * Matt, 53:24 and 55:32: *"they'll only enter weight… they won't enter square
 * because they don't know the square metres either. Like you can't tell"* and
 * *"that will be entered in the admin side before the job, because we bill based
 * on square meters, but we issue certificates based on weight."*
 *
 * The area is therefore shown here as context — the figure the office booked, so
 * the driver can see at a glance whether the pile matches what was expected —
 * and there is no field to type it into. A driver cannot look at a heap of
 * offcuts and read its area off, so an editable box only ever collected a number
 * invented to get past it, and that number was what got invoiced.
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
export function DriverJobWeightsPage() {
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
  const [bags, setBags] = useState(String(job.bagCount));
  const [craneKg, setCraneKg] = useState(job.craneScaleKg === null ? '' : String(job.craneScaleKg));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const weighable = loadType === 'bagged' && job.capturesWeight;

  const save = async () => {
    const next: Record<string, string> = {};
    const bagValue = Number(bags);
    const craneValue = craneKg.trim() === '' ? null : Number(craneKg);

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
          bagCount: bagValue,
          loadType,
          craneScaleKg: weighable ? craneValue : null,
        },
      });
      toast.success('Saved on this phone', 'It goes to the office when you have signal.');
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
        <h1 className="font-display text-lg font-semibold tracking-tight">What did you collect?</h1>
        <p className="text-sm text-muted-foreground">{job.siteName}</p>
      </header>

      {/*
       * The area, shown and not asked for.
       *
       * It is here because the driver still needs it — it is how they tell
       * whether the pile in front of them is the job that was booked — but it is
       * read-only, because they have no way to measure it and the office already
       * has the number from the builder's order.
       */}
      <div className="flex items-baseline justify-between rounded-xl border border-border bg-muted/40 px-3 py-2.5">
        <div>
          <p className="text-sm font-medium">Booked for this job</p>
          <p className="text-xs text-muted-foreground">Set in the office · you do not enter this</p>
        </div>
        <p className="font-display text-lg font-semibold tabular-nums">
          {job.expectedAreaM2.toLocaleString('en-AU')} m²
        </p>
      </div>

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
          There is no bag to lift onto the scale. This job&rsquo;s weight gets worked out at the end
          of the run from the tip-off figure, shared out by job size — so it will be recorded as an
          estimate, not a measurement.
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
