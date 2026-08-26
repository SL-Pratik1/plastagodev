import { PRE_START_ITEMS, type PreStartItemState } from '@plastago/shared';
import {
  Alert,
  Checkbox,
  Field,
  Input,
  Label,
  Spinner,
  Textarea,
  buttonVariants,
  cn,
  useToast,
} from '@plastago/ui';
import { CheckIcon, MinusIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useRunSheet, useSubmitPreStart } from '@/features/run/queries';
import { RUN_DATE } from '@/services/mock/fixtures';
import { currentPosition } from '@/services/mock/create-mock-services';

/**
 * Driver pre-start checklist (M4.8a · F56).
 *
 * ── This is a legal record, not a nag screen ───────────────────────────────
 * Chain of Responsibility under the Heavy Vehicle National Law makes pre-start
 * checks an **operator** obligation, not just the driver's. That changes the
 * design in two ways that matter:
 *
 *  1. **A failed item is not a blocker to dismiss — it becomes a defect report**
 *     (M4.9). So "fail" opens a note field and the note is required, because
 *     "brakes: fail" with no detail is useless to whoever books the repair.
 *  2. **The declaration is a real attestation.** A checklist with no signature is
 *     a form; with one it is a record, and the obligation needs the record.
 *
 * ── Three states, not a checkbox ──────────────────────────────────────────
 * Pass / fail / not applicable. A two-state checkbox forces a driver to tick
 * "crane and lifting gear" on a truck that has no crane, which teaches them that
 * ticking things is how you get past the screen — and that habit is exactly what
 * the obligation exists to prevent.
 */
export function PreStartPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { data: day } = useRunSheet(RUN_DATE);
  const submit = useSubmitPreStart();

  const [states, setStates] = useState<Record<string, PreStartItemState>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [odometer, setOdometer] = useState('');
  const [declared, setDeclared] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const failures = PRE_START_ITEMS.filter((item) => states[item.key] === 'fail');
  const answered = PRE_START_ITEMS.filter((item) => states[item.key] !== undefined).length;

  const setState = (key: string, state: PreStartItemState) => {
    setStates((current) => ({ ...current, [key]: state }));
    setErrors(({ [key]: _drop, items: _items, ...rest }) => rest);
  };

  const save = async () => {
    const next: Record<string, string> = {};

    const unanswered = PRE_START_ITEMS.filter((item) => states[item.key] === undefined);
    if (unanswered.length > 0) {
      next.items = `${String(unanswered.length)} check${unanswered.length === 1 ? '' : 's'} not answered yet.`;
    }

    const odometerValue = Number(odometer);
    if (!Number.isInteger(odometerValue) || odometerValue <= 0) {
      next.odometer = 'Enter the odometer reading in whole kilometres.';
    }

    // A failure with no detail cannot be actioned by whoever books the repair.
    for (const item of failures) {
      if ((notes[item.key] ?? '').trim().length === 0) {
        next[item.key] = 'Say what is wrong — this becomes the defect report.';
      }
    }

    if (!declared) {
      next.declaration = 'Confirm the checks were actually carried out.';
    }

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const position = await currentPosition();
    try {
      await submit.mutateAsync({
        occurredAt: new Date().toISOString(),
        position,
        date: RUN_DATE,
        vehicleRego: day?.vehicleRego ?? '',
        odometerKm: odometerValue,
        items: PRE_START_ITEMS.map((item) => ({
          key: item.key,
          state: states[item.key] ?? 'not-applicable',
          note: notes[item.key] ?? '',
        })),
        declaration: true,
      });

      toast.success(
        'Pre-start recorded',
        failures.length > 0
          ? `${String(failures.length)} defect${failures.length === 1 ? '' : 's'} sent to the office.`
          : 'You are good to go.',
      );
      await navigate('/');
    } catch {
      toast.error('Could not save that', 'Try again — nothing was lost.');
    }
  };

  return (
    <div className="space-y-4">
      <Link to="/" className="focus-ring inline-block rounded text-sm text-muted-foreground">
        ← Run sheet
      </Link>

      <header>
        <h1 className="font-display text-lg font-semibold tracking-tight">Pre-start check</h1>
        <p className="text-sm text-muted-foreground">
          {day?.vehicleRego ?? 'Your vehicle'}
          {day?.vehicleLabel !== null &&
            day?.vehicleLabel !== undefined &&
            ` · ${day.vehicleLabel}`}
        </p>
      </header>

      <Alert variant="info" title="Why this is on the record">
        Under Chain of Responsibility this is the operator's obligation as well as yours. Anything
        you mark as a problem goes straight to the office as a defect.
      </Alert>

      <p className="text-xs text-muted-foreground">
        {answered} of {PRE_START_ITEMS.length} answered
      </p>

      <ul className="space-y-2">
        {PRE_START_ITEMS.map((item) => {
          const state = states[item.key];
          return (
            <li key={item.key} className="rounded-xl border border-border bg-card p-3">
              <p className="text-sm font-medium">{item.label}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{item.detail}</p>

              <div className="mt-2 grid grid-cols-3 gap-2">
                <StateButton
                  label="Pass"
                  icon={CheckIcon}
                  active={state === 'pass'}
                  tone="pass"
                  onClick={() => {
                    setState(item.key, 'pass');
                  }}
                />
                <StateButton
                  label="Problem"
                  icon={XIcon}
                  active={state === 'fail'}
                  tone="fail"
                  onClick={() => {
                    setState(item.key, 'fail');
                  }}
                />
                <StateButton
                  label="N/A"
                  icon={MinusIcon}
                  active={state === 'not-applicable'}
                  tone="na"
                  onClick={() => {
                    setState(item.key, 'not-applicable');
                  }}
                />
              </div>

              {state === 'fail' && (
                <div className="mt-3">
                  <Field
                    id={`prestart-note-${item.key}`}
                    label="What is wrong?"
                    required
                    error={errors[item.key]}
                  >
                    {(control) => (
                      <Textarea
                        {...control}
                        rows={2}
                        maxLength={300}
                        value={notes[item.key] ?? ''}
                        placeholder="Nearside rear tyre down to the wear bars."
                        onChange={(event) => {
                          setNotes((current) => ({ ...current, [item.key]: event.target.value }));
                          setErrors(({ [item.key]: _drop, ...rest }) => rest);
                        }}
                      />
                    )}
                  </Field>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {errors.items !== undefined && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {errors.items}
        </p>
      )}

      <Field
        id="prestart-odometer"
        label="Odometer (km)"
        required
        error={errors.odometer}
        hint="Whole kilometres, off the dash."
      >
        {(control) => (
          <Input
            {...control}
            type="number"
            inputMode="numeric"
            min={1}
            className="h-16 text-2xl font-semibold tabular-nums"
            value={odometer}
            onChange={(event) => {
              setOdometer(event.target.value);
              setErrors(({ odometer: _drop, ...rest }) => rest);
            }}
          />
        )}
      </Field>

      {failures.length > 0 && (
        <Alert
          variant="warning"
          title={`${String(failures.length)} problem${failures.length === 1 ? '' : 's'} found`}
        >
          {failures.map((item) => item.label).join(', ')}. These go to the office as defects against{' '}
          {day?.vehicleRego ?? 'this vehicle'}. If it is unsafe to drive, ring them before you
          leave.
        </Alert>
      )}

      <div className="rounded-xl border border-border p-3">
        <div className="flex items-start gap-3">
          <Checkbox
            id="prestart-declaration"
            checked={declared}
            aria-invalid={errors.declaration !== undefined}
            onChange={(event) => {
              setDeclared(event.target.checked);
              setErrors(({ declaration: _drop, ...rest }) => rest);
            }}
          />
          <div>
            <Label htmlFor="prestart-declaration" className="font-normal">
              I carried out these checks on {day?.vehicleRego ?? 'this vehicle'} today
            </Label>
            <p className="text-xs text-muted-foreground">
              Recorded against your name and the time.
            </p>
          </div>
        </div>
        {errors.declaration !== undefined && (
          <p role="alert" className="mt-1 ml-7 text-xs font-medium text-destructive">
            {errors.declaration}
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={() => void save()}
        disabled={submit.isPending}
        className={`${buttonVariants({ size: 'lg' })} min-h-16 w-full text-base`}
      >
        {submit.isPending && <Spinner label="Saving" />}
        Finish pre-start
      </button>
    </div>
  );
}

function StateButton({
  label,
  icon: Icon,
  active,
  tone,
  onClick,
}: {
  label: string;
  icon: typeof CheckIcon;
  active: boolean;
  tone: 'pass' | 'fail' | 'na';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'focus-ring flex min-h-12 items-center justify-center gap-1.5 rounded-lg border text-sm font-medium',
        active && tone === 'pass' && 'border-success bg-success/15 text-success',
        active && tone === 'fail' && 'border-destructive bg-destructive/15 text-destructive',
        active && tone === 'na' && 'border-border bg-muted text-muted-foreground',
        !active && 'border-border bg-card text-muted-foreground',
      )}
    >
      <Icon aria-hidden className="size-4" />
      {label}
    </button>
  );
}
