import { zodResolver } from '@hookform/resolvers/zod';
import type { Place, PortalBookingDraft } from '@plastago/shared';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  DatePicker,
  Field,
  Input,
  Label,
  Select,
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
import { useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router';
import * as z from 'zod';
import { PlacePicker } from '@/components/place-picker';
import { usePortalBook, usePortalQuote, usePortalScope } from '@/features/portal/queries';
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
  /* ── Where the pickup is ──────────────────────────────────────────────
   *
   * Typed, not chosen from a saved list — there are no saved sites (Matt,
   * 0:29): *"we don't ever really visit a site more than once."*
   *
   * ⚠️ The SUBURB is still chosen, because it carries the zone that prices the
   * job and the pin the board plots. Neither survives free text.
   */
  siteName: z.string().trim().min(1, 'Name the place — our driver navigates by it').max(120),
  lotNumber: z.string().trim().max(30),
  addressLine: z.string().trim().min(1, 'Enter the street address').max(160),
  placeId: z.string().min(1, 'Choose the suburb from the list'),
  builderName: z.string().trim().max(120),
  accessNotes: z.string().trim().max(1000),
  gateHours: z.string().trim().max(120),
  inductionRequired: z.boolean(),
  craneAvailable: z.boolean(),
  siteContactName: z.string().trim().max(80),
  siteContactMobile: z.string().trim().max(20),
  siteContactEmail: z
    .string()
    .trim()
    .max(160)
    .refine(
      (value) => value === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
      'Enter a valid email address, or leave it blank',
    ),
  readyDate: z.string().min(1, 'Tell us the date the board will be ready'),
  /**
   * Optional in the schema, required in the form — for contractors only.
   *
   * A builder never sees this field: their area comes off the purchase order
   * (Matt, 25:19), and `null` here means *"the PO will tell us"*, not zero.
   * Zero would price the job at the call-out fee and nobody would notice.
   */
  expectedAreaM2: z.coerce
    .number()
    .positive('Enter the expected square metres')
    .max(100000, 'That is larger than any job on record — check the figure')
    .nullable(),
  bagCount: z.coerce
    .number()
    .int('Whole bags only')
    .min(0, 'Bags cannot be negative')
    .max(200, 'That is more bags than a truck holds — check the figure'),
  serviceLevel: z.enum(['standard', 'urgent']),
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
  const book = usePortalBook();

  /*
   * The chosen suburb, held beside the form.
   *
   * The form field stores the id — that is what the service resolves and what
   * cannot be tampered with. This holds the whole `Place` so the picker can
   * show the label and the zone back to the person booking.
   */
  const [place, setPlace] = useState<Place | null>(null);

  const today = new Date(now).toISOString().slice(0, 10);
  const poRequired = scope.data?.poRequired ?? false;
  const canSeePricing = scope.data?.canSeePricing ?? false;

  /*
   * A builder's numbers are already on their purchase order.
   *
   * Matt, 25:19: *"in the builder's regard it probably won't ask expected
   * plasterboard square metres, won't ask recycling bags, because **all that
   * information is in the purchase order**."*
   *
   * So the form does not ask. Not because the figures are unimportant — they are
   * what the job is priced on — but because asking invites a second, contradicting
   * number from someone who has no reason to know it. The site supervisor booking
   * this run *"is running the site, they're not going to know it's 823.4 square
   * metres"* (29:21). The office fills them from the PO.
   *
   * A contractor gets the full form, because for them it IS the authorisation:
   * *"they're just going to fill out the form and we'll generate them an
   * invoice"* (22:53).
   */
  const fromPurchaseOrder = scope.data?.accountType === 'builder';

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
      siteName: '',
      lotNumber: '',
      addressLine: '',
      // Deep-linkable, so a shared booking link can still land with the suburb
      // resolved — what B.1 used to do with a site id.
      placeId: params.get('place') ?? '',
      builderName: '',
      accessNotes: '',
      gateHours: '',
      inductionRequired: false,
      craneAvailable: false,
      siteContactName: '',
      siteContactMobile: '',
      siteContactEmail: '',
      readyDate: '',
      expectedAreaM2: '' as unknown as number,
      bagCount: 0,
      serviceLevel: 'standard',
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
    const placeId = watched.placeId ?? '';
    const area = Number(watched.expectedAreaM2 ?? 0);
    // The suburb carries the zone, and the zone is the price. No suburb, no quote.
    if (!placeId || !Number.isFinite(area) || area <= 0) return null;

    return {
      // Only the fields that move the figure are real here; the rest are
      // placeholders so the draft satisfies the contract without re-quoting
      // every time somebody types a note.
      siteName: 'quote',
      lotNumber: '',
      addressLine: 'quote',
      placeId,
      builderName: '',
      accessNotes: '',
      gateHours: '',
      inductionRequired: false,
      craneAvailable: false,
      siteContactName: '',
      siteContactMobile: '',
      siteContactEmail: '',
      readyDate: watched.readyDate ?? today,
      expectedAreaM2: area,
      bagCount: Number(watched.bagCount ?? 0) || 0,
      serviceLevel: watched.serviceLevel ?? 'standard',
      poNumber: '',
      // No picker on this form yet — a portal booking carries no order, so
      // the area comes from the field above as it does today.
      purchaseOrderId: null,
      notes: '',
      certification: { jobReady: true, truckAccessible: true, freeOfContaminants: true },
    };
  }, [
    watched.placeId,
    watched.expectedAreaM2,
    watched.bagCount,
    watched.serviceLevel,
    watched.readyDate,
    today,
  ]);

  const quote = usePortalQuote(quoteDraft, canSeePricing);



  const submit = handleSubmit(async (values) => {
    if (poRequired && values.poNumber.trim().length === 0) {
      setError('poNumber', {
        message: 'Your account requires a purchase order number on every booking',
      });
      return;
    }

    // Contractors must give a figure, because for them the form is the only
    // source there is. Builders must not be asked — see `fromPurchaseOrder`.
    if (!fromPurchaseOrder && !values.expectedAreaM2) {
      setError('expectedAreaM2', { message: 'Enter the expected square metres' });
      return;
    }

    try {
      const created = await book.mutateAsync({
        siteName: values.siteName,
        lotNumber: values.lotNumber,
        addressLine: values.addressLine,
        placeId: values.placeId,
        builderName: values.builderName,
        accessNotes: values.accessNotes,
        gateHours: values.gateHours,
        inductionRequired: values.inductionRequired,
        craneAvailable: values.craneAvailable,
        siteContactName: values.siteContactName,
        siteContactMobile: values.siteContactMobile,
        siteContactEmail: values.siteContactEmail,
        readyDate: values.readyDate,
        expectedAreaM2: fromPurchaseOrder ? null : Number(values.expectedAreaM2),
        bagCount: fromPurchaseOrder ? 0 : Number(values.bagCount),
        serviceLevel: values.serviceLevel,
        poNumber: values.poNumber,
        purchaseOrderId: null,
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
            {/*
              The address, typed each time.
              Matt, 0:29: *"the job should just have the site on it as part of
              the details for the job"* — because a site is a house being built
              and it is never a pickup twice (3:28).
            */}
            <Field
              id="book-site-name"
              label="What should we call this pickup?"
              required
              error={errors.siteName?.message}
              hint="Whatever you would say on the phone — “Lot 214” or “the Edgeworth job”."
            >
              {(control) => (
                <Input {...control} placeholder="Lot 214 Allambie Circuit" {...register('siteName')} />
              )}
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field
                id="book-lot"
                label="Lot number"
                error={errors.lotNumber?.message}
                hint="If there is one."
              >
                {(control) => <Input {...control} placeholder="214" {...register('lotNumber')} />}
              </Field>

              <Field
                id="book-address"
                label="Street address"
                required
                error={errors.addressLine?.message}
                className="sm:col-span-2"
              >
                {(control) => (
                  <Input {...control} placeholder="46 Allambie Circuit" {...register('addressLine')} />
                )}
              </Field>
            </div>

            {/*
              The suburb is PICKED, not typed — it carries the zone that prices
              the job and the pin the board plots (Matt, 7:25 asked for the
              type-ahead; this is also what replaces the site's stored zone).
            */}
            <Controller
              control={control}
              name="placeId"
              render={({ field }) => (
                <Field
                  id="book-place"
                  label="Suburb"
                  required
                  error={errors.placeId?.message}
                  hint="Start typing — we only service Sydney, Wollongong and Newcastle."
                >
                  {(aria) => (
                    <PlacePicker
                      {...aria}
                      value={place}
                      onChange={(next) => {
                        setPlace(next);
                        field.onChange(next?.id ?? '');
                      }}
                    />
                  )}
                </Field>
              )}
            />

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

              {/* Both hidden for a builder — see `fromPurchaseOrder` above. */}
              {!fromPurchaseOrder && (
                <>
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
                </>
              )}

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
            <CardTitle className="text-base">Your reference</CardTitle>
            <p className="text-xs text-muted-foreground">
              Optional, unless your account requires a purchase order.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {/*
              One field, not two.
              Matt, 9:08: *"customer reference and purchase order number… either a
              customer gives us a purchase order number or they'll give us a job
              reference number. **They are one and the same.**"* It keeps the PO
              name because that is what has to print on the invoice — 9:56: *"if
              we don't list PO on the invoice, then sometimes I have trouble
              getting paid."*
            */}
            <div className="grid gap-4">
              <Field
                id="book-po"
                label="PO / job reference"
                required={poRequired}
                error={errors.poNumber?.message}
                hint={
                  fromPurchaseOrder
                    ? 'We take the area, bag allowance and site supervisor from this order.'
                    : poRequired
                      ? 'Your account requires a PO before we can invoice.'
                      : 'A PO number or your own job reference — whichever you use. It prints as the PO.'
                }
              >
                {(control) => (
                  <Input
                    {...control}
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="29916613/096 or Lot 1097"
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
