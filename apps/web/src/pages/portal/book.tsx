import { zodResolver } from '@hookform/resolvers/zod';
import type { PortalBookingDraft } from '@plastago/shared';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  DatePicker,
  ErrorState,
  Field,
  Input,
  Label,
  Select,
  Skeleton,
  Spinner,
  Textarea,
  useToast,
} from '@plastago/ui';
import {
  CheckCircle2Icon,
  CircleDollarSignIcon,
  InfoIcon,
  PackageIcon,
  ZapIcon,
} from 'lucide-react';
import { useMemo } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router';
import * as z from 'zod';
import {
  usePortalBook,
  usePortalQuote,
  usePortalScope,
  usePortalSites,
} from '@/features/portal/queries';
import { describeError } from '@/lib/error-message';
import { formatMoney } from '@/lib/format';
import { isServiceError } from '@/services/service-error';
import { useNow } from '@/lib/use-now';

/**
 * Book a pickup (M5.1 · F9, F21, W88 + M5.2 · W86).
 *
 * ── The whole point: four fields instead of seventeen ──────────────────────
 * Today's form is 17 fields with 13 mandatory, filled in on a building site in
 * the rain, with the account name typed by hand and no validation. Everything
 * the session already knows — account, builder, address, contact, rate — is
 * absent here by design. What is left is: which site, when, how much, how many
 * bags.
 *
 * ── The certification is not a formality ──────────────────────────────────
 * M5.2 captures three separate promises against a named, authenticated user with
 * a timestamp, because that record is what makes a $120 futile charge
 * defensible: *"David Chen, GJ Gardner, certified on 12 Aug at 14:32 that this
 * job would be ready"* — rather than an unverified string in a text box. They are
 * three checkboxes and not one, because the charge stands or falls on which
 * promise was broken, and each carries its own error message saying why it
 * matters.
 *
 * ── The price is only shown to those allowed to see it ────────────────────
 * A site supervisor never sees a figure (M1.5), and the quote call is not even
 * made for them. For an administrator it is resolved by the service and never
 * computed here — pricing must match TransVirtual to the cent (Risk 1).
 */
const FormSchema = z.object({
  siteId: z.string().min(1, 'Choose which site the pickup is for'),
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
  jobReady: z.literal(true, {
    error: 'Confirm the board will be stacked and ready on this date',
  }),
  truckAccessible: z.literal(true, {
    error: 'Confirm a truck can reach the pile — this is the top cause of futile pickups',
  }),
  freeOfContaminants: z.literal(true, {
    error: 'Confirm the plasterboard is free of timber, insulation and other waste',
  }),
});

type FormValues = z.input<typeof FormSchema>;

export function PortalBookPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const now = useNow(300_000);

  const scope = usePortalScope();
  const sites = usePortalSites({ page: 1, pageSize: 200 });
  const book = usePortalBook();

  const today = new Date(now).toISOString().slice(0, 10);
  const poRequired = scope.data?.poRequired ?? false;
  const canSeePricing = scope.data?.canSeePricing ?? false;

  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    mode: 'onTouched',
    defaultValues: {
      // Deep-linked from a site page or the site's shareable booking link (B.1),
      // so the supervisor who taps a WhatsApp link lands with the site chosen.
      siteId: params.get('site') ?? '',
      readyDate: '',
      expectedAreaM2: '' as unknown as number,
      bagCount: 0,
      serviceLevel: 'standard',
      reference: '',
      poNumber: '',
      notes: '',
      jobReady: false as unknown as true,
      truckAccessible: false as unknown as true,
      freeOfContaminants: false as unknown as true,
    },
  });

  // `useWatch` rather than `watch()`: the latter reads outside React's data flow
  // and defeats the compiler's memoisation of this component.
  const watched = useWatch({ control });

  /*
   * The draft the quote is keyed on, memoised so typing a note does not re-ask
   * for a price. Only the three fields that affect the figure are included.
   */
  const quoteDraft = useMemo<PortalBookingDraft | null>(() => {
    const siteId = watched.siteId ?? '';
    const area = Number(watched.expectedAreaM2 ?? 0);
    if (!siteId || !Number.isFinite(area) || area <= 0) return null;

    return {
      siteId,
      readyDate: watched.readyDate ?? today,
      expectedAreaM2: area,
      bagCount: Number(watched.bagCount ?? 0) || 0,
      serviceLevel: watched.serviceLevel ?? 'standard',
      reference: '',
      poNumber: '',
      notes: '',
      certification: { jobReady: true, truckAccessible: true, freeOfContaminants: true },
    };
  }, [
    watched.siteId,
    watched.expectedAreaM2,
    watched.bagCount,
    watched.serviceLevel,
    watched.readyDate,
    today,
  ]);

  const quote = usePortalQuote(quoteDraft, canSeePricing);

  const siteOptions = sites.data?.data ?? [];
  const chosenSite = siteOptions.find((site) => site.id === watched.siteId);

  const submit = handleSubmit(async (values) => {
    if (poRequired && values.poNumber.trim().length === 0) {
      setError('poNumber', {
        message: 'Your account requires a purchase order number on every booking',
      });
      return;
    }

    try {
      const created = await book.mutateAsync({
        siteId: values.siteId,
        readyDate: values.readyDate,
        expectedAreaM2: Number(values.expectedAreaM2),
        bagCount: Number(values.bagCount),
        serviceLevel: values.serviceLevel,
        reference: values.reference,
        poNumber: values.poNumber,
        notes: values.notes,
        certification: { jobReady: true, truckAccessible: true, freeOfContaminants: true },
      });

      toast.success(
        `Pickup #${String(created.jobNumber)} booked`,
        'We will text you when a driver is assigned.',
      );
      await navigate(`/portal/jobs/${created.id}`);
    } catch (caught) {
      // Field-level errors from the service land on the field, so the user does
      // not have to work out which of nine inputs the toast is about.
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

  if (sites.error) {
    const described = describeError(sites.error);
    return (
      <ErrorState
        title={described.title}
        description={described.detail}
        onRetry={() => void sites.refetch()}
      />
    );
  }

  if (sites.isPending) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-7 w-48" />
        <Card className="p-5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-4 h-64 w-full" />
        </Card>
      </div>
    );
  }

  // A supervisor with no sites yet is a real state (freshly invited), and it
  // needs an answer rather than an empty dropdown.
  if (siteOptions.length === 0) {
    return (
      <div className="space-y-5">
        <h1 className="font-display text-xl font-semibold tracking-tight">Book a pickup</h1>
        <Alert variant="info" title="No sites are linked to your account yet">
          Ask your account administrator to add a site for you, or call the office on{' '}
          <a href="tel:1300395438" className="font-medium underline underline-offset-4">
            1300 395 438
          </a>{' '}
          and we will set it up.
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-display text-xl font-semibold tracking-tight">Book a pickup</h1>
        <p className="text-sm text-muted-foreground">
          Four details and a quick confirmation. We already have your account, address and rates.
        </p>
      </header>

      <form onSubmit={(event) => void submit(event)} noValidate className="space-y-5">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">The pickup</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field
              id="book-site"
              label="Which site?"
              required
              error={errors.siteId?.message}
              hint={
                chosenSite?.accessNotes
                  ? `Access notes on file: ${chosenSite.accessNotes}`
                  : 'Your saved sites — no address to retype.'
              }
            >
              {(control) => (
                <Select {...control} {...register('siteId')}>
                  <option value="">Choose a site…</option>
                  {siteOptions.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.name} — {site.suburb}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="book-ready-date"
                label="When will it be ready?"
                required
                error={errors.readyDate?.message}
                hint="We aim to collect within 5 business days of this date."
              >
                {(control) => (
                  <DatePicker {...control} min={today} {...register('readyDate')} />
                )}
              </Field>

              <Field
                id="book-area"
                label="Expected plasterboard (m²)"
                required
                error={errors.expectedAreaM2?.message}
                hint="A rough figure is fine — we measure on collection."
              >
                {(control) => (
                  <Input
                    {...control}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={10}
                    placeholder="850"
                    {...register('expectedAreaM2')}
                  />
                )}
              </Field>

              <Field
                id="book-bags"
                label="Recycling bags needed"
                error={errors.bagCount?.message}
                hint="Leave at 0 if the board is stacked loose."
              >
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

              <Field
                id="book-service-level"
                label="Urgency"
                hint="Urgent pickups are flagged to the office immediately (M5.5)."
              >
                {(control) => (
                  <Select {...control} {...register('serviceLevel')}>
                    <option value="standard">Standard</option>
                    <option value="urgent">Urgent — needed as soon as possible</option>
                  </Select>
                )}
              </Field>
            </div>

            {watched.serviceLevel === 'urgent' && (
              <Alert variant="warning" title="We will call you about this one">
                <span className="flex items-start gap-2">
                  <ZapIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  Urgent pickups are highlighted on the allocation board and the office is alerted.
                  Availability depends on the day&apos;s run — we will confirm by phone or text.
                </span>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your references</CardTitle>
            <p className="text-xs text-muted-foreground">
              Optional, unless your account requires a purchase order.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="book-reference"
                label="Your reference"
                error={errors.reference?.message}
                hint="Job number, lot number — whatever you use to find it later."
              >
                {(control) => (
                  <Input {...control} placeholder="Lot 1097" {...register('reference')} />
                )}
              </Field>

              <Field
                id="book-po"
                label="Purchase order number"
                required={poRequired}
                error={errors.poNumber?.message}
                hint={
                  poRequired
                    ? 'Your account requires a PO before we can invoice.'
                    : 'Add one if your accounts team needs it on the invoice.'
                }
              >
                {(control) => (
                  <Input
                    {...control}
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="29916613/096"
                    {...register('poNumber')}
                  />
                )}
              </Field>
            </div>

            <Field
              id="book-notes"
              label="Anything the driver should know"
              error={errors.notes?.message}
              hint="Where the pile is, who to call on arrival, access quirks."
            >
              {(control) => (
                <Textarea
                  {...control}
                  rows={3}
                  placeholder="Board is stacked behind the garage. Ring Dave 20 minutes out."
                  {...register('notes')}
                />
              )}
            </Field>
          </CardContent>
        </Card>

        {/* ── M5.2 · W86 — the three certifications ─────────────────────── */}
        <Card className="border-warning/40">
          <CardHeader>
            <CardTitle className="text-base">Confirm before you book</CardTitle>
            <p className="text-xs text-muted-foreground">
              These three confirmations are recorded against your name and the time you made them.
              If the truck arrives and one of them is not true, a $120 futile fee applies.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <CertifyRow
              id="cert-ready"
              label="The plasterboard will be stacked and ready on this date"
              hint="Not still on the walls, not behind other trades' materials."
              error={errors.jobReady?.message}
              register={register('jobReady')}
            />
            <CertifyRow
              id="cert-access"
              label="A truck can get to the pile"
              hint="This is the single most common reason a pickup fails."
              error={errors.truckAccessible?.message}
              register={register('truckAccessible')}
            />
            <CertifyRow
              id="cert-clean"
              label="The plasterboard is free of timber, insulation and other waste"
              hint="Contaminated loads carry a $90 charge and are photographed on site."
              error={errors.freeOfContaminants?.message}
              register={register('freeOfContaminants')}
            />
          </CardContent>
        </Card>

        {/* ── The estimate, administrators only ─────────────────────────── */}
        {canSeePricing && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <CircleDollarSignIcon aria-hidden className="size-4 text-muted-foreground" />
                Estimated cost
              </CardTitle>
            </CardHeader>
            <CardContent>
              {quoteDraft === null ? (
                <p className="text-sm text-muted-foreground">
                  Choose a site and enter the expected square metres for an estimate.
                </p>
              ) : quote.isPending ? (
                <Spinner label="Pricing" />
              ) : quote.error ? (
                <p className="text-sm text-muted-foreground">
                  We could not price this right now. You can still book — the invoice will use your
                  agreed rates.
                </p>
              ) : quote.data ? (
                <div className="space-y-2">
                  <dl className="space-y-1 text-sm">
                    {quote.data.lines.map((line) => (
                      <div key={line.code} className="flex justify-between gap-4">
                        <dt className="min-w-0 truncate text-muted-foreground">
                          {line.description}
                          {line.quantity !== 1 && (
                            <span className="ml-1 text-xs">
                              ({line.quantity.toLocaleString('en-AU')} ×{' '}
                              {formatMoney(line.unitRate)})
                            </span>
                          )}
                        </dt>
                        <dd className="shrink-0 tabular-nums">{formatMoney(line.amount)}</dd>
                      </div>
                    ))}
                    <div className="flex justify-between border-t border-border pt-1.5">
                      <dt className="font-medium">Total inc GST</dt>
                      <dd className="font-display text-lg font-semibold tabular-nums">
                        {formatMoney(quote.data.totalIncGst)}
                      </dd>
                    </div>
                  </dl>
                  {quote.data.caveat !== null && (
                    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                      <InfoIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
                      {quote.data.caveat}
                    </p>
                  )}
                </div>
              ) : null}
            </CardContent>
          </Card>
        )}

        {/* Sticky on phones so the action is always in thumb reach — this form
            is long, and scrolling back up to submit is the friction M5.1 exists
            to remove. */}
        <div className="sticky bottom-20 z-10 flex flex-wrap items-center justify-end gap-3 rounded-xl border border-border bg-card/95 p-3 backdrop-blur md:static md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none">
          <Link
            to="/portal"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            Cancel
          </Link>
          <Button type="submit" size="lg" disabled={isSubmitting} className="min-w-40">
            {isSubmitting && <Spinner label="Booking" />}
            <PackageIcon aria-hidden />
            Book pickup
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * One certification row.
 *
 * The error sits under its own checkbox rather than in a summary, because with
 * three near-identical confirmations a shared error message cannot tell you
 * which one you missed.
 */
function CertifyRow({
  id,
  label,
  hint,
  error,
  register,
}: {
  id: string;
  label: string;
  hint: string;
  error: string | undefined;
  register: ReturnType<ReturnType<typeof useForm<FormValues>>['register']>;
}) {
  return (
    <div>
      <div className="flex items-start gap-3">
        <Checkbox
          id={id}
          aria-invalid={error !== undefined}
          aria-describedby={error ? `${id}-error` : `${id}-hint`}
          {...register}
        />
        <div className="min-w-0">
          <Label htmlFor={id} className="font-normal">
            {label}
          </Label>
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        </div>
        {error === undefined && (
          <CheckCircle2Icon aria-hidden className="ml-auto size-4 shrink-0 text-transparent" />
        )}
      </div>
      {error !== undefined && (
        <p
          id={`${id}-error`}
          role="alert"
          className="mt-1 ml-7 text-xs font-medium text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  );
}
