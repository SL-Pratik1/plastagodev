import { zodResolver } from '@hookform/resolvers/zod';
import { REGO_PERIODS, type RegoPeriod, type Vehicle } from '@plastago/shared';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  Select,
  Spinner,
  useToast,
} from '@plastago/ui';
import { useEffect } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import * as z from 'zod';
import { useRenewRegistration } from '../queries';
import { todayInSydney } from '@/lib/business-day';
import { describeError } from '@/lib/error-message';
import { formatDate } from '@/lib/format';

/**
 * Log a registration renewal (M9.7 · F43).
 *
 * ── Why this shows the arithmetic before you commit to it ──────────────────
 * The rule — roll forward from the CURRENT expiry, not from today — is correct
 * and completely invisible. Someone renewing a plate three weeks late has every
 * reason to expect twelve months from today, and if the badge just flips to
 * green they will never learn otherwise. Showing "6 Sept 2026 → 6 Sept 2027"
 * before the click turns a hidden rule into a visible promise: you paid for a
 * full period, you get a full period. That is why this is a real dialog and not
 * the yes/no box it replaced.
 *
 * ── Why the cost is captured here and not on a second trip ─────────────────
 * `registration` is already an expense kind, and the only moment anyone has the
 * amount in front of them is the moment they renew. Making it a separate errand
 * is how a cost per kilometre ends up quietly understating for a year.
 */
const FormSchema = z
  .object({
    /** Matt, 21 Oct: the length "can vary" — chosen on every renewal. */
    periodMonths: z.enum(['12', '6', '3']),
    logCost: z.boolean(),
    amountExGst: z.string(),
  })
  .check((ctx) => {
    const { logCost, amountExGst } = ctx.value;
    if (logCost && !(Number(amountExGst) > 0)) {
      ctx.issues.push({
        code: 'custom',
        input: amountExGst,
        path: ['amountExGst'],
        message: 'Enter what the registration cost, or untick the box',
      });
    }
  });

type FormValues = z.infer<typeof FormSchema>;

export interface RenewRegistrationDialogProps {
  open: boolean;
  onClose: () => void;
  vehicle: Vehicle;
}

/**
 * The new expiry, computed the same way the service does — including the
 * month-end clamp: six months from 31 August is 28 February, not 3 March.
 */
function rollForward(expiresOn: string, months: number): string {
  const [year = 0, month = 1, day = 1] = expiresOn.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** The vehicle's current length when it is one of the three on offer, else 12. */
function defaultPeriod(vehicle: Vehicle): FormValues['periodMonths'] {
  const current = String(vehicle.registrationPeriodMonths);
  return current === '6' || current === '3' ? current : '12';
}

export function RenewRegistrationDialog({ open, onClose, vehicle }: RenewRegistrationDialogProps) {
  const toast = useToast();
  const renew = useRenewRegistration();

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: { periodMonths: defaultPeriod(vehicle), logCost: true, amountExGst: '' },
    mode: 'onTouched',
  });

  useEffect(() => {
    if (!open) return;
    reset({ periodMonths: defaultPeriod(vehicle), logCost: true, amountExGst: '' });
  }, [open, reset, vehicle]);

  const logCost = useWatch({ control, name: 'logCost' });
  const months = Number(useWatch({ control, name: 'periodMonths' })) as RegoPeriod;
  const newExpiry = rollForward(vehicle.registrationExpiresOn, months);

  const onSubmit = async (values: FormValues) => {
    const chosen = Number(values.periodMonths) as RegoPeriod;
    try {
      await renew.mutateAsync({
        id: vehicle.id,
        periodMonths: chosen,
        expense: values.logCost
          ? {
              incurredOn: todayInSydney(),
              odometerKm: vehicle.odometerKm,
              kind: 'registration',
              description: `Registration renewal (${String(chosen)} months) to ${formatDate(newExpiry)}`,
              amountExGst: Number(values.amountExGst).toFixed(2),
              supplier: null,
            }
          : null,
      });
      toast.success(
        `${vehicle.rego} registered to ${formatDate(newExpiry)}`,
        `${String(chosen)}-month renewal saved.${values.logCost ? ' The cost is on the expense log.' : ''}`,
      );
      onClose();
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={isSubmitting ? () => undefined : onClose}
      title={`Log the renewal for ${vehicle.rego}`}
      description="Records that you have renewed it. It does not pay anything."
      dismissible={!isSubmitting}
      footer={
        <>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isSubmitting}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            form="renew-rego-form"
            type="submit"
            disabled={isSubmitting}
            className="w-full sm:w-auto"
          >
            {isSubmitting && <Spinner className="text-current" />}
            Log renewal
          </Button>
        </>
      }
    >
      <form
        id="renew-rego-form"
        onSubmit={(event) => void handleSubmit(onSubmit)(event)}
        className="space-y-4 py-2"
        noValidate
      >
        <Field
          id="renewal-period"
          label="Registration length"
          required
          error={errors.periodMonths?.message}
          hint="What you paid for this time. The next renewal starts from this length."
        >
          {(aria) => (
            <Select {...aria} {...register('periodMonths')}>
              {REGO_PERIODS.map((period) => (
                <option key={period} value={String(period)}>
                  {period} months
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/40 p-4">
          <span className="text-sm">
            <span className="block text-xs text-muted-foreground">Expires now</span>
            <span className="font-medium tabular-nums">
              {formatDate(vehicle.registrationExpiresOn)}
            </span>
          </span>
          <span aria-hidden className="text-muted-foreground">
            →
          </span>
          <span className="text-sm">
            <span className="block text-xs text-muted-foreground">New expiry</span>
            <span className="font-medium tabular-nums text-brand-600 dark:text-brand-400">
              {formatDate(newExpiry)}
            </span>
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            {months}-month registration
          </span>
        </div>

        <Alert variant="neutral" title="Counted from the old expiry, not from today">
          A late renewal does not quietly shorten the next period — you paid for {months} months,
          so you get {months} months.
        </Alert>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox {...register('logCost')} />
          Also log what it cost
        </label>

        {logCost && (
          <Field
            id="renewal-amount"
            label="Registration cost ex GST"
            required
            error={errors.amountExGst?.message}
            hint="Goes on the expense log as a Registration entry and feeds cost per kilometre."
          >
            {(aria) => (
              <Input
                {...aria}
                {...register('amountExGst')}
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                placeholder="0.00"
              />
            )}
          </Field>
        )}
      </form>
    </Dialog>
  );
}
