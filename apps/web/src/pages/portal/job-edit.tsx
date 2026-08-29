import { zodResolver } from '@hookform/resolvers/zod';
import type { PortalJob } from '@plastago/shared';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DatePicker,
  ErrorState,
  Field,
  Input,
  Select,
  Skeleton,
  Spinner,
  Textarea,
  useToast,
} from '@plastago/ui';
import { SaveIcon } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router';
import * as z from 'zod';
import { usePortalEditJob, usePortalJob, usePortalScope } from '@/features/portal/queries';
import { describeError } from '@/lib/error-message';
import { formatDate } from '@/lib/format';
import { isServiceError } from '@/services/service-error';
import { useNow } from '@/lib/use-now';

/**
 * Edit a pickup (M5.4 · F38, W97).
 *
 * ── Why this is a separate screen from booking ────────────────────────────
 * §13.2 lists "edit pickup" as its own screen, and the two really are different:
 * booking asks for a promise about readiness, editing does not re-ask for it.
 * Making someone re-tick three certifications to move a date by a day would
 * train them to tick without reading — which would quietly destroy the value of
 * the certification on the bookings where it matters.
 *
 * ── The guard is the server's flag, checked again on arrival ───────────────
 * A pickup is editable until it is on a run sheet. Someone can open this screen
 * from a bookmark, or leave it open while the office allocates the job — so the
 * `editable` flag is re-read here and the form refuses rather than submitting
 * into a conflict.
 */
const FormSchema = z.object({
  readyDate: z.string().min(1, 'Tell us the date the board will be ready'),
  expectedAreaM2: z.coerce
    .number()
    .positive('Enter the expected square metres')
    .max(100000, 'That is larger than any job on record — check the figure'),
  bagCount: z.coerce
    .number()
    .int('Whole bags only')
    .min(0, 'Bags cannot be negative')
    .max(200, 'That is more bags than a truck holds — check the figure'),
  serviceLevel: z.enum(['standard', 'urgent']),
  reference: z.string().trim().max(60),
  poNumber: z.string().trim().max(60),
  notes: z.string().trim().max(1000),
});

type FormValues = z.input<typeof FormSchema>;

export function PortalJobEditPage() {
  const { jobId } = useParams();
  const { data: job, error, isPending, refetch } = usePortalJob(jobId);

  if (error) {
    const described = describeError(error);
    return (
      <ErrorState
        title={described.title}
        description={described.detail}
        onRetry={described.retryable ? () => void refetch() : undefined}
      />
    );
  }

  if (isPending || !job) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-7 w-56" />
        <Card className="p-5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-4 h-56 w-full" />
        </Card>
      </div>
    );
  }

  return <EditForm job={job} />;
}

function EditForm({ job }: { job: PortalJob }) {
  const toast = useToast();
  const navigate = useNavigate();
  const now = useNow(300_000);
  const scope = usePortalScope();
  const edit = usePortalEditJob();

  const today = new Date(now).toISOString().slice(0, 10);
  const poRequired = scope.data?.poRequired ?? false;

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    mode: 'onTouched',
    defaultValues: {
      readyDate: job.readyDate,
      expectedAreaM2: job.expectedAreaM2,
      bagCount: job.bagCount,
      serviceLevel: job.serviceLevel,
      reference: job.reference ?? '',
      poNumber: job.poNumber ?? '',
      notes: job.notes,
    },
  });

  // Re-checked on arrival: the office may have allocated this job while the
  // customer sat on the previous screen.
  if (!job.editable) {
    return (
      <div className="space-y-5">
        <h1 className="font-display text-xl font-semibold tracking-tight">
          Pickup #{job.jobNumber}
        </h1>
        <Alert variant="info" title="This pickup can no longer be edited here">
          It is scheduled with a driver now. Open the pickup and use{' '}
          <strong>Request a change</strong> — the office will confirm what is possible.
        </Alert>
        <Link
          to={`/portal/jobs/${job.id}`}
          className="text-sm text-primary underline underline-offset-4"
        >
          Back to the pickup
        </Link>
      </div>
    );
  }

  const submit = handleSubmit(async (values) => {
    if (poRequired && values.poNumber.trim().length === 0) {
      setError('poNumber', { message: 'Your account requires a purchase order number' });
      return;
    }

    try {
      await edit.mutateAsync({
        id: job.id,
        input: {
          readyDate: values.readyDate,
          expectedAreaM2: Number(values.expectedAreaM2),
          bagCount: Number(values.bagCount),
          serviceLevel: values.serviceLevel,
          reference: values.reference,
          poNumber: values.poNumber,
          notes: values.notes,
        },
      });
      toast.success(
        `Pickup #${String(job.jobNumber)} updated`,
        values.readyDate !== job.readyDate
          ? `Ready date moved to ${formatDate(values.readyDate)}.`
          : undefined,
      );
      await navigate(`/portal/jobs/${job.id}`);
    } catch (caught) {
      if (isServiceError(caught) && caught.fieldErrors) {
        for (const [field, message] of Object.entries(caught.fieldErrors)) {
          if (field in values) setError(field as keyof FormValues, { message });
        }
        return;
      }
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  });

  return (
    <div className="space-y-5">
      <Link
        to={`/portal/jobs/${job.id}`}
        className="focus-ring inline-block rounded text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        ← Pickup #{job.jobNumber}
      </Link>

      <header>
        <h1 className="font-display text-xl font-semibold tracking-tight">Edit pickup</h1>
        <p className="text-sm text-muted-foreground">
          {job.siteName}, {job.suburb} — not yet scheduled with a driver, so you can change it
          directly.
        </p>
      </header>

      <form onSubmit={(event) => void submit(event)} noValidate className="space-y-5">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">The pickup</CardTitle>
            <p className="text-xs text-muted-foreground">
              The site cannot be changed — book a new pickup if it is for somewhere else.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="edit-ready-date"
                label="When will it be ready?"
                required
                error={errors.readyDate?.message}
                hint="Moving this restarts the five-business-day collection window."
              >
                {(control) => (
                  <DatePicker {...control} min={today} {...register('readyDate')} />
                )}
              </Field>

              <Field
                id="edit-area"
                label="Expected plasterboard (m²)"
                required
                error={errors.expectedAreaM2?.message}
              >
                {(control) => (
                  <Input
                    {...control}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={10}
                    {...register('expectedAreaM2')}
                  />
                )}
              </Field>

              <Field id="edit-bags" label="Recycling bags" error={errors.bagCount?.message}>
                {(control) => (
                  <Input
                    {...control}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={200}
                    {...register('bagCount')}
                  />
                )}
              </Field>

              <Field id="edit-service-level" label="Urgency">
                {(control) => (
                  <Select {...control} {...register('serviceLevel')}>
                    <option value="standard">Standard</option>
                    <option value="urgent">Urgent — needed as soon as possible</option>
                  </Select>
                )}
              </Field>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">References and notes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="edit-reference" label="Your reference" error={errors.reference?.message}>
                {(control) => <Input {...control} {...register('reference')} />}
              </Field>

              <Field
                id="edit-po"
                label="Purchase order number"
                required={poRequired}
                error={errors.poNumber?.message}
                hint={poRequired ? 'Required on this account before we can invoice.' : undefined}
              >
                {(control) => (
                  <Input
                    {...control}
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                    {...register('poNumber')}
                  />
                )}
              </Field>
            </div>

            <Field
              id="edit-notes"
              label="Anything the driver should know"
              error={errors.notes?.message}
            >
              {(control) => <Textarea {...control} rows={3} {...register('notes')} />}
            </Field>
          </CardContent>
        </Card>

        <div className="sticky bottom-20 z-10 flex flex-wrap items-center justify-end gap-3 rounded-xl border border-border bg-card/95 p-3 backdrop-blur md:static md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none">
          <Link
            to={`/portal/jobs/${job.id}`}
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            Discard changes
          </Link>
          <Button type="submit" size="lg" disabled={isSubmitting} className="min-w-36">
            {isSubmitting && <Spinner label="Saving" />}
            <SaveIcon aria-hidden />
            Save changes
          </Button>
        </div>
      </form>
    </div>
  );
}
