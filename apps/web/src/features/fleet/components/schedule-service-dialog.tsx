import { zodResolver } from '@hookform/resolvers/zod';
import type { Vehicle } from '@plastago/shared';
import { Alert, Button, DatePicker, Dialog, Field, Spinner, useToast } from '@plastago/ui';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { useSetNextService } from '../queries';
import { describeError } from '@/lib/error-message';
import { formatDate } from '@/lib/format';

/**
 * Book the next service (M9.7 · F43 · W113 — the allocator's).
 *
 * ── Why a date and not a derived interval ──────────────────────────────────
 * "Last service + 6 months" would put a date on every truck without anyone
 * agreeing to it. Four of their five vehicles already show service dates in the
 * past; a fifth invented one is more of exactly what made them stop trusting
 * the module they have. The workshop decides when it can take the truck — this
 * records that decision, it does not guess it.
 *
 * ── Why clearing is offered ────────────────────────────────────────────────
 * A booking that fell through has to be removable. A stale date is worse than
 * no date: it turns the overdue list — the one thing on this screen that exists
 * to be chased — back into the noise it was built to replace.
 */
const FormSchema = z.object({
  dueOn: z.string().min(1, 'Pick a date, or clear the booking'),
});

type FormValues = z.infer<typeof FormSchema>;

export interface ScheduleServiceDialogProps {
  open: boolean;
  onClose: () => void;
  vehicle: Vehicle;
}

export function ScheduleServiceDialog({ open, onClose, vehicle }: ScheduleServiceDialogProps) {
  const toast = useToast();
  const setNextService = useSetNextService();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: { dueOn: '' },
    mode: 'onTouched',
  });

  useEffect(() => {
    if (!open) return;
    reset({ dueOn: vehicle.nextServiceDueOn ?? '' });
  }, [open, vehicle.nextServiceDueOn, reset]);

  const save = async (dueOn: string | null) => {
    try {
      await setNextService.mutateAsync({ id: vehicle.id, dueOn });
      toast.success(
        dueOn === null ? 'Service booking cleared' : `Next service due ${formatDate(dueOn)}`,
        dueOn === null ? 'It will stop appearing on the overdue list.' : undefined,
      );
      onClose();
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const pending = isSubmitting || setNextService.isPending;

  return (
    <Dialog
      open={open}
      onClose={pending ? () => undefined : onClose}
      title={`Next service for ${vehicle.rego}`}
      description="When the workshop can take it. The reminder fires two weeks before."
      dismissible={!pending}
      footer={
        <>
          {vehicle.nextServiceDueOn !== null && (
            <Button
              variant="outline"
              onClick={() => void save(null)}
              disabled={pending}
              className="w-full sm:mr-auto sm:w-auto"
            >
              Clear booking
            </Button>
          )}
          <Button
            variant="outline"
            onClick={onClose}
            disabled={pending}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            form="schedule-service-form"
            type="submit"
            disabled={pending}
            className="w-full sm:w-auto"
          >
            {pending && <Spinner className="text-current" />}
            Save date
          </Button>
        </>
      }
    >
      <form
        id="schedule-service-form"
        onSubmit={(event) => void handleSubmit((values) => save(values.dueOn))(event)}
        className="space-y-4 py-2"
        noValidate
      >
        <Field id="service-due" label="Next service due" required error={errors.dueOn?.message}>
          {(aria) => <DatePicker {...aria} {...register('dueOn')} />}
        </Field>

        <Alert variant="neutral" title="Last service comes from the expense log">
          {vehicle.lastServiceOn === null
            ? 'Nothing logged yet — log a service expense and the date fills itself in.'
            : `Last service ${formatDate(vehicle.lastServiceOn)}, taken from the most recent Service expense.`}
        </Alert>
      </form>
    </Dialog>
  );
}
