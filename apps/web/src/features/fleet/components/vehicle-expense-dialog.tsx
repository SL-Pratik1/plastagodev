import { zodResolver } from '@hookform/resolvers/zod';
import {
  VEHICLE_EXPENSE_KIND_LABELS,
  VEHICLE_EXPENSE_KINDS,
  type Vehicle,
  type VehicleExpenseDraft,
} from '@plastago/shared';
import {
  Alert,
  Button,
  DatePicker,
  Dialog,
  Field,
  Input,
  Select,
  Spinner,
  useToast,
} from '@plastago/ui';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { todayInSydney } from '@/lib/business-day';
import { describeError } from '@/lib/error-message';
import { isServiceError } from '@/services/service-error';
import { useAddVehicleExpense } from '../queries';

/**
 * Log one expense (M9.7 · F43).
 *
 * ── Five fields, and that is the whole specification ───────────────────────
 * Matt, verbatim: *"At 49,000 km it went in for a service, what the service
 * description was — A service, B service — and the price."* A parts-and-labour
 * breakdown was explicitly not wanted, so the description stays free text and
 * there is no line-item table to fill in. Resisting that is the feature.
 *
 * ── Why the odometer reading is required ───────────────────────────────────
 * Cost per kilometre is total spend ÷ the distance between the oldest and newest
 * readings on this log. An expense without a reading contributes a cost with no
 * distance to divide it by — which does not fail, it just quietly makes the
 * number wrong. So the field is required and the hint says why.
 */
const FormSchema = z.object({
  incurredOn: z.string().min(1, 'When was it paid?'),
  odometerKm: z
    .string()
    .min(1, 'Enter the reading at the time')
    .refine((value) => Number(value) >= 0, 'Enter the reading at the time'),
  kind: z.enum(VEHICLE_EXPENSE_KINDS),
  description: z.string().trim().min(2, 'Say what it was for, e.g. “A service”').max(120, 'Keep the description under 120 characters'),
  amountExGst: z
    .string()
    .min(1, 'Enter the amount excluding GST')
    .refine((value) => Number(value) > 0, 'Enter the amount excluding GST'),
  supplier: z.string().trim().max(60, 'Keep the supplier under 60 characters'),
});

type FormValues = z.infer<typeof FormSchema>;

export interface VehicleExpenseDialogProps {
  open: boolean;
  onClose: () => void;
  vehicle: Vehicle;
  /** Preselects the kind — the Maintenance tab opens this asking for a service. */
  defaultKind?: VehicleExpenseDraft['kind'];
}

export function VehicleExpenseDialog({
  open,
  onClose,
  vehicle,
  defaultKind = 'service',
}: VehicleExpenseDialogProps) {
  const toast = useToast();
  const addExpense = useAddVehicleExpense();

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    mode: 'onTouched',
  });

  /*
   * The odometer defaults to the vehicle's current reading, not to blank.
   * Whoever is typing this is reading a workshop invoice, and the reading on it
   * is almost always "what it is now" — so the common case is confirming a
   * number rather than hunting for one.
   */
  useEffect(() => {
    if (!open) return;
    reset({
      incurredOn: todayInSydney(),
      odometerKm: String(vehicle.odometerKm),
      kind: defaultKind,
      description: '',
      amountExGst: '',
      supplier: '',
    });
  }, [open, vehicle.odometerKm, defaultKind, reset]);

  const onSubmit = async (values: FormValues) => {
    const draft: VehicleExpenseDraft = {
      incurredOn: values.incurredOn,
      odometerKm: Number(values.odometerKm),
      kind: values.kind,
      description: values.description,
      amountExGst: Number(values.amountExGst).toFixed(2),
      supplier: values.supplier || null,
    };

    try {
      await addExpense.mutateAsync({ id: vehicle.id, draft });
      toast.success(
        'Expense logged',
        values.kind === 'service'
          ? 'Cost per kilometre and the service history have both moved.'
          : 'Cost per kilometre has been recalculated.',
      );
      onClose();
    } catch (caught) {
      if (isServiceError(caught) && Object.keys(caught.fieldErrors).length > 0) {
        for (const [field, message] of Object.entries(caught.fieldErrors)) {
          setError(field as keyof FormValues, { type: 'server', message });
        }
        return;
      }
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={isSubmitting ? () => undefined : onClose}
      title={`Log an expense for ${vehicle.rego}`}
      description="A date, a reading, a description and a price. No parts-and-labour breakdown."
      size="lg"
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
            form="vehicle-expense-form"
            type="submit"
            disabled={isSubmitting}
            className="w-full sm:w-auto"
          >
            {isSubmitting && <Spinner className="text-current" />}
            Log expense
          </Button>
        </>
      }
    >
      <form
        id="vehicle-expense-form"
        onSubmit={(event) => void handleSubmit(onSubmit)(event)}
        className="space-y-4 py-2"
        noValidate
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="expense-date" label="Date" required error={errors.incurredOn?.message}>
            {(aria) => <DatePicker {...aria} {...register('incurredOn')} />}
          </Field>

          <Field id="expense-kind" label="Kind" required error={errors.kind?.message}>
            {(aria) => (
              <Select {...aria} {...register('kind')}>
                {VEHICLE_EXPENSE_KINDS.map((option) => (
                  <option key={option} value={option}>
                    {VEHICLE_EXPENSE_KIND_LABELS[option]}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field
            id="expense-odometer"
            label="Odometer reading"
            required
            error={errors.odometerKm?.message}
            hint="This is what makes cost per kilometre computable — not optional detail."
          >
            {(aria) => (
              <Input
                {...aria}
                {...register('odometerKm')}
                type="number"
                inputMode="numeric"
                min={0}
              />
            )}
          </Field>

          <Field
            id="expense-amount"
            label="Amount ex GST"
            required
            error={errors.amountExGst?.message}
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

          <Field
            id="expense-description"
            label="Description"
            required
            error={errors.description?.message}
            className="sm:col-span-2"
          >
            {(aria) => (
              <Input
                {...aria}
                {...register('description')}
                autoComplete="off"
                placeholder="A service"
              />
            )}
          </Field>

          <Field
            id="expense-supplier"
            label="Supplier"
            error={errors.supplier?.message}
            className="sm:col-span-2"
          >
            {(aria) => (
              <Input
                {...aria}
                {...register('supplier')}
                autoComplete="off"
                placeholder="Optional — who did the work"
              />
            )}
          </Field>
        </div>

        <Alert variant="neutral" title="A service also moves the maintenance history">
          Logging this with the kind set to Service updates the last-service date on the Maintenance
          tab. Booking the next one is a separate step, because the workshop decides that date.
        </Alert>
      </form>
    </Dialog>
  );
}
