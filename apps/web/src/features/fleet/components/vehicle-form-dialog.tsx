import { zodResolver } from '@hookform/resolvers/zod';
import {
  REGO_PERIODS,
  VEHICLE_TYPE_LABELS,
  VEHICLE_TYPES,
  type Vehicle,
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
  Textarea,
  useToast,
} from '@plastago/ui';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { describeError } from '@/lib/error-message';
import { isServiceError } from '@/services/service-error';
import { useCreateVehicle, useUpdateVehicle } from '../queries';

/**
 * Create or edit a vehicle (M9.7 · F43).
 *
 * ── What this form deliberately does NOT ask for ───────────────────────────
 * Cost per kilometre, total spend and the last service date are **outputs of the
 * expense log**, so there is no field for any of them. Matt's framing is the
 * design: odometer and expenses go in, cost per kilometre comes out. A form that
 * let someone type a cost per kilometre would make the one number this screen
 * exists to produce unauditable on the first day somebody guessed.
 *
 * Assigned driver and in/out of service are absent for a different reason —
 * they are their own decisions, taken off a menu on a day when nobody is editing
 * the make and model. Folding them in here would mean opening a ten-field dialog
 * to take a broken truck off the road.
 */
const FormSchema = z.object({
  rego: z
    .string()
    .trim()
    .min(2, 'Enter the registration plate')
    .max(10, 'That is longer than a plate')
    .regex(/^[A-Za-z0-9 -]+$/, 'Letters and numbers only'),
  label: z.string().trim().min(2, 'Describe it, e.g. Isuzu FVZ crane truck').max(60, 'Keep the description under 60 characters'),
  type: z.enum(VEHICLE_TYPES),
  make: z.string().trim().max(40, 'Keep the make under 40 characters'),
  model: z.string().trim().max(40, 'Keep the model under 40 characters'),
  year: z
    .string()
    .trim()
    .refine((value) => value === '' || /^\d{4}$/.test(value), 'Enter a 4-digit year'),
  odometerKm: z.string().trim(),
  registrationExpiresOn: z.string().min(1, 'When does the registration expire?'),
  registrationPeriodMonths: z.string(),
  purchasedOn: z.string(),
  notes: z.string().trim().max(500, 'Keep notes under 500 characters'),
});

type FormValues = z.infer<typeof FormSchema>;

const EMPTY: FormValues = {
  rego: '',
  label: '',
  type: 'crane-truck',
  make: '',
  model: '',
  year: '',
  odometerKm: '0',
  registrationExpiresOn: '',
  registrationPeriodMonths: '12',
  purchasedOn: '',
  notes: '',
};

export interface VehicleFormDialogProps {
  open: boolean;
  onClose: () => void;
  /** Omit to create. Supply to edit. */
  vehicle?: Vehicle | null;
}

export function VehicleFormDialog({ open, onClose, vehicle }: VehicleFormDialogProps) {
  const toast = useToast();
  const createVehicle = useCreateVehicle();
  const updateVehicle = useUpdateVehicle();
  const editing = Boolean(vehicle);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: EMPTY,
    mode: 'onTouched',
  });

  // Reset on open so a cancelled edit cannot leak into the next one.
  useEffect(() => {
    if (!open) return;
    reset(
      vehicle
        ? {
            rego: vehicle.rego,
            label: vehicle.label,
            type: vehicle.type,
            make: vehicle.make,
            model: vehicle.model,
            year: vehicle.year === null ? '' : String(vehicle.year),
            odometerKm: String(vehicle.odometerKm),
            registrationExpiresOn: vehicle.registrationExpiresOn,
            registrationPeriodMonths: String(vehicle.registrationPeriodMonths),
            purchasedOn: vehicle.purchasedOn ?? '',
            notes: vehicle.notes,
          }
        : EMPTY,
    );
  }, [open, vehicle, reset]);

  const onSubmit = async (values: FormValues) => {
    const draft = {
      rego: values.rego.trim().toUpperCase(),
      label: values.label,
      type: values.type,
      make: values.make,
      model: values.model,
      year: values.year ? Number(values.year) : null,
      odometerKm: Number(values.odometerKm || 0),
      registrationExpiresOn: values.registrationExpiresOn,
      registrationPeriodMonths: Number(values.registrationPeriodMonths),
      purchasedOn: values.purchasedOn || null,
      notes: values.notes,
    };

    try {
      if (vehicle) {
        await updateVehicle.mutateAsync({ id: vehicle.id, draft });
        toast.success(`${draft.rego} updated`);
      } else {
        await createVehicle.mutateAsync(draft);
        toast.success(`${draft.rego} added to the fleet`, 'Log its first expense to start costing.');
      }
      onClose();
    } catch (caught) {
      // Field errors land on their fields — the rego clash is server-only, since
      // the form cannot know the rest of the fleet. Anything else is a toast, and
      // either way the dialog stays open with the data still in it.
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
      title={editing ? `Edit ${vehicle?.rego ?? 'vehicle'}` : 'Add a vehicle'}
      description={
        editing
          ? 'Cost per kilometre and service history come from the expense log, not from here.'
          : 'The registration reminder starts as soon as you save.'
      }
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
            form="vehicle-form"
            type="submit"
            disabled={isSubmitting}
            className="w-full sm:w-auto"
          >
            {isSubmitting && <Spinner className="text-current" />}
            {editing ? 'Save changes' : 'Add vehicle'}
          </Button>
        </>
      }
    >
      <form
        id="vehicle-form"
        onSubmit={(event) => void handleSubmit(onSubmit)(event)}
        className="space-y-4 py-2"
        noValidate
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            id="vehicle-rego"
            label="Registration plate"
            required
            error={errors.rego?.message}
            hint="How everyone in the yard names the truck."
          >
            {(aria) => (
              <Input
                {...aria}
                {...register('rego')}
                autoComplete="off"
                placeholder="BQ44JT"
                className="font-mono uppercase"
              />
            )}
          </Field>

          <Field id="vehicle-type" label="Type" required error={errors.type?.message}>
            {(aria) => (
              <Select {...aria} {...register('type')}>
                {VEHICLE_TYPES.map((option) => (
                  <option key={option} value={option}>
                    {VEHICLE_TYPE_LABELS[option]}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field
            id="vehicle-label"
            label="Description"
            required
            error={errors.label?.message}
            className="sm:col-span-2"
          >
            {(aria) => (
              <Input
                {...aria}
                {...register('label')}
                autoComplete="off"
                placeholder="Isuzu FVZ crane truck"
              />
            )}
          </Field>

          <Field id="vehicle-make" label="Make" error={errors.make?.message}>
            {(aria) => <Input {...aria} {...register('make')} autoComplete="off" placeholder="Isuzu" />}
          </Field>

          <Field id="vehicle-model" label="Model" error={errors.model?.message}>
            {(aria) => (
              <Input {...aria} {...register('model')} autoComplete="off" placeholder="FVZ 260-300" />
            )}
          </Field>

          <Field id="vehicle-year" label="Year" error={errors.year?.message}>
            {(aria) => (
              <Input
                {...aria}
                {...register('year')}
                type="text"
                inputMode="numeric"
                maxLength={4}
                placeholder="2019"
                onChange={(event) => {
                  event.target.value = event.target.value.replace(/\D/g, '').slice(0, 4);
                  void register('year').onChange(event);
                }}
              />
            )}
          </Field>

          <Field
            id="vehicle-odometer"
            label="Odometer"
            error={errors.odometerKm?.message}
            hint={
              editing
                ? 'Raised by each expense you log. It never goes down.'
                : 'The reading today, in kilometres.'
            }
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
            id="vehicle-rego-expiry"
            label="Registration expires"
            required
            error={errors.registrationExpiresOn?.message}
          >
            {(aria) => <DatePicker {...aria} {...register('registrationExpiresOn')} />}
          </Field>

          <Field
            id="vehicle-rego-period"
            label="Registered period"
            error={errors.registrationPeriodMonths?.message}
            hint="What “Log renewal” rolls the expiry forward by."
          >
            {(aria) => (
              <Select {...aria} {...register('registrationPeriodMonths')}>
                {REGO_PERIODS.map((months) => (
                  <option key={months} value={months}>
                    {months} months
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field id="vehicle-purchased" label="Purchased" error={errors.purchasedOn?.message}>
            {(aria) => <DatePicker {...aria} {...register('purchasedOn')} />}
          </Field>
        </div>

        <Field id="vehicle-notes" label="Notes" error={errors.notes?.message}>
          {(aria) => (
            <Textarea {...aria} {...register('notes')} rows={2} placeholder="Optional — internal only" />
          )}
        </Field>

        {!editing && (
          <Alert variant="info" title="Cost per kilometre needs two expenses to appear">
            It is total spend divided by the distance between the oldest and newest odometer
            readings on the log — so a single entry has nothing to divide by yet.
          </Alert>
        )}
      </form>
    </Dialog>
  );
}
