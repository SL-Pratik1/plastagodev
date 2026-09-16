import { zodResolver } from '@hookform/resolvers/zod';
import {
  FREIGHT_ITEM_LABELS,
  FREIGHT_ITEMS,
  ZONE_LABELS,
  type JobDraft,
  type Place,
} from '@plastago/shared';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  DatePicker,
  Field,
  Input,
  Select,
  Skeleton,
  Spinner,
  Textarea,
  useToast,
} from '@plastago/ui';
import { CircleDollarSignIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import * as z from 'zod';
import { PageHeader } from '@/components/page-header';
import { PlacePicker } from '@/components/place-picker';
import { useAccountOptions } from '@/features/lookups/queries';
import {
  useBookablePurchaseOrders,
  useCreateJob,
  useJobPricePreview,
} from '@/features/jobs/queries';
import { describeError } from '@/lib/error-message';
import { formatMoney } from '@/lib/format';
import { isServiceError } from '@/services/service-error';

/**
 * Create a job (M2.1) — their #1 daily screen.
 *
 * ── What makes this better than what they have ─────────────────────────────
 * Today this is 17 fields with the account name typed by hand. Here:
 *
 *  • **Account and site are pickers, not free text.** Free text is exactly why
 *    leads arrive disguised as jobs and why the office has to work out who a
 *    booking belongs to.
 *  • **The site list is scoped to the chosen account** and grouped by suburb, so
 *    picking is recognition rather than recall.
 *  • **The price is shown before saving** — "$356.80 ex GST — Sydney zone, $220
 *    service + 855 m² × $0.16". TransVirtual cannot do this, and it is what lets
 *    the office quote on the phone.
 *
 * ⚠️ The estimate is resolved by the service, never computed here. Pricing is an
 * effective-dated three-dimensional lookup that has to match TransVirtual to the
 * cent; a second implementation in the browser would be a second thing to keep
 * correct, and the wrong one would be invisible until an invoice bounced.
 */
const FormSchema = z.object({
  accountId: z.string().min(1, 'Choose the account being invoiced'),
  /* ── The address, typed on the job (Matt, 0:29) ───────────────────── */
  siteName: z
    .string()
    .trim()
    .min(1, 'Name the place — drivers navigate by it')
    .max(120, 'Keep the site name under 120 characters'),
  lotNumber: z.string().trim().max(30, 'A lot number is at most 30 characters'),
  addressLine: z
    .string()
    .trim()
    .min(1, 'Enter the street address')
    .max(160, 'Keep the address under 160 characters'),
  /** Picked, not typed — carries the zone that prices the job and the map pin. */
  placeId: z.string().min(1, 'Choose the suburb from the list'),
  builderName: z.string().trim().max(120, 'Keep the builder name under 120 characters'),
  accessNotes: z.string().trim().max(1000, 'Keep access notes under 1000 characters'),
  gateHours: z.string().trim().max(120, 'Keep gate hours under 120 characters'),
  inductionRequired: z.boolean(),
  craneAvailable: z.boolean(),
  siteContactName: z.string().trim().max(80, 'Keep the contact name under 80 characters'),
  siteContactMobile: z.string().trim().max(20, 'A mobile number is at most 20 characters'),
  siteContactEmail: z.string().trim().max(160, 'Keep the email under 160 characters'),
  poNumber: z.string().trim().max(60, 'A PO or job reference is at most 60 characters'),
  /**
   * M2.12 — the confirmed purchase order this pickup fulfils.
   *
   * Empty string rather than null, because that is what an unselected `<select>`
   * gives us. Mapped to null on submit — the contract is nullable, and "" is not
   * an ObjectId.
   */
  purchaseOrderId: z.string(),
  readyDate: z.string().min(1, 'Enter the date the customer says it will be ready'),
  serviceLevel: z.enum(['standard', 'urgent']),
  freightItem: z.enum(FREIGHT_ITEMS),
  expectedAreaM2: z.coerce
    .number()
    .min(0, 'Square metres cannot be negative')
    .max(100000, 'That looks too large — check the figure'),
  bagCount: z.coerce
    .number()
    .int('Whole bags only')
    .min(0, 'Bags cannot be negative')
    .max(200, 'That looks too many — check the figure'),
  notes: z.string().trim().max(2000, 'Keep notes under 2000 characters'),
});

type FormValues = z.input<typeof FormSchema>;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function AdminJobCreatePage() {
  const navigate = useNavigate();
  const toast = useToast();
  const accounts = useAccountOptions();
  const createJob = useCreateJob();

  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      accountId: '',
      siteName: '',
      lotNumber: '',
      addressLine: '',
      placeId: '',
      builderName: '',
      accessNotes: '',
      gateHours: '',
      inductionRequired: false,
      craneAvailable: false,
      siteContactName: '',
      siteContactMobile: '',
      siteContactEmail: '',
      poNumber: '',
      purchaseOrderId: '',
      readyDate: todayIso(),
      serviceLevel: 'standard',
      freightItem: 'plasterboard-bagged',
      expectedAreaM2: 0,
      bagCount: 0,
      notes: '',
    },
    mode: 'onTouched',
  });

  const accountId = useWatch({ control, name: 'accountId' });
  const placeId = useWatch({ control, name: 'placeId' });
  /*
   * The chosen suburb, held beside the form.
   *
   * The form field stores the id — that is what the service resolves, and what
   * a caller cannot tamper with to change the zone. This holds the whole
   * `Place` so the picker can show the label and the zone back.
   */
  const [place, setPlace] = useState<Place | null>(null);
  const expectedAreaM2 = useWatch({ control, name: 'expectedAreaM2' });
  const bagCount = useWatch({ control, name: 'bagCount' });
  const purchaseOrderId = useWatch({ control, name: 'purchaseOrderId' });

  /*
   * M2.12 — the orders this account has on file.
   *
   * Fetched per account rather than filtered client-side: an account can
   * accumulate hundreds of orders over a year, and only its own are ever
   * relevant.
   */
  const purchaseOrders = useBookablePurchaseOrders(accountId || undefined);

  const chosenOrder = purchaseOrders.data?.find((order) => order.id === purchaseOrderId) ?? null;

  /*
   * ⚠️ The order OWNS the area, the bags and the PO number.
   *
   * The server resolves all three from the stored record and ignores whatever
   * the form sends (see `JobDraftSchema`). Locking the inputs is what makes
   * that visible — an editable box whose value is silently discarded is worse
   * than no box at all.
   */
  const lockedToOrder = chosenOrder !== null;
  const readyDate = useWatch({ control, name: 'readyDate' });
  const serviceLevel = useWatch({ control, name: 'serviceLevel' });
  const freightItem = useWatch({ control, name: 'freightItem' });

  /**
   * The draft handed to the pricing service.
   *
   * Memoised so the query key is stable — without it every render is a new
   * object and the preview refetches continuously.
   */
  const priceDraft = useMemo<JobDraft | null>(() => {
    // The suburb carries the zone, and the zone is the price. No suburb, no quote.
    if (!accountId || !placeId) return null;
    return {
      accountId,
      // Only the fields that move the figure are real; the rest are
      // placeholders so the draft satisfies the contract without re-pricing
      // every time somebody types an access note.
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
      poNumber: '',
      // Real, not a placeholder: the order supplies the area, so a quote
      // that omitted it would be the wrong number.
      purchaseOrderId: purchaseOrderId || null,
      readyDate: readyDate || todayIso(),
      serviceLevel,
      freightItem,
      expectedAreaM2: Number(expectedAreaM2) || 0,
      bagCount: Number(bagCount) || 0,
      notes: '',
    };
  }, [
    accountId,
    placeId,
    readyDate,
    serviceLevel,
    freightItem,
    expectedAreaM2,
    bagCount,
    purchaseOrderId,
  ]);

  const preview = useJobPricePreview(priceDraft);

  const onSubmit = async (values: FormValues) => {
    const draft: JobDraft = {
      ...values,
      // '' is what an unselected <select> gives; the contract wants null.
      purchaseOrderId: values.purchaseOrderId || null,
      /*
       * Sent even when an order is chosen, and deliberately ignored by the
       * server in that case. Stripping them here would make the contract
       * conditional on a client decision — the server decides which source
       * wins, and it is the only place that can.
       */
      expectedAreaM2: Number(values.expectedAreaM2),
      bagCount: Number(values.bagCount),
    };

    try {
      const created = await createJob.mutateAsync(draft);
      toast.success(
        `Job #${String(created.jobNumber)} created`,
        `${created.accountName} · ${created.siteName}. It is now unallocated on the board.`,
      );
      await navigate(`/admin/jobs/${created.id}`);
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
    <div className="space-y-6">
      <PageHeader
        title="Create job"
        breadcrumbs={[{ label: 'Jobs', to: '/admin/jobs' }]}
        description="Raise a pickup on behalf of a customer. The estimate updates as you type."
      />

      {/*
        A job is raised ON BEHALF OF an account, so with none on the system this
        form cannot be completed — the Account field is required and its only
        options are accounts.

        ── Why an Alert and not a toast ──────────────────────────────────
        The Alert component's own note puts it well: an alert is about the
        content on screen and stays until the situation changes, a toast
        confirms something and leaves. This is a standing condition, not an
        event. A message that vanishes after three seconds would leave someone
        staring at an empty dropdown with no idea why.

        Only once the query has RESOLVED. Rendering it while accounts are still
        loading tells a fully-configured office it has no customers, which is a
        worse lie than saying nothing.
      */}
      {accounts.isSuccess && (accounts.data ?? []).length === 0 && (
        <Alert variant="warning" title="No customers yet">
          A job is raised against a customer account, and there are none on the system. Add the
          first customer and this form is ready to use.{' '}
          <Link to="/admin/customers" className="font-medium underline underline-offset-4">
            Go to Customers
          </Link>
        </Alert>
      )}

      <form onSubmit={(event) => void handleSubmit(onSubmit)(event)} noValidate>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle>Who and where</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field
                  id="job-account"
                  label="Account"
                  required
                  error={errors.accountId?.message}
                  hint="The party being invoiced."
                >
                  {(aria) => (
                    <Select {...aria} {...register('accountId')}>
                      <option value="">Choose an account…</option>
                      {(accounts.data ?? []).map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>

                {/*
                  The address, typed on the job — no site to pick from.
                  Matt, 0:29: *"the job should just have the site on it as part
                  of the details for the job."*
                */}
                <Field
                  id="job-site-name"
                  label="Site name"
                  required
                  error={errors.siteName?.message}
                  hint="What the office and the driver will call it."
                >
                  {(aria) => (
                    <Input
                      {...aria}
                      placeholder="Lot 214 Allambie Circuit"
                      {...register('siteName')}
                    />
                  )}
                </Field>

                <Field id="job-lot" label="Lot number" error={errors.lotNumber?.message}>
                  {(aria) => <Input {...aria} placeholder="214" {...register('lotNumber')} />}
                </Field>

                <Field
                  id="job-address"
                  label="Street address"
                  required
                  error={errors.addressLine?.message}
                >
                  {(aria) => (
                    <Input
                      {...aria}
                      placeholder="46 Allambie Circuit"
                      {...register('addressLine')}
                    />
                  )}
                </Field>

                {/*
                  Picked, not typed: the suburb carries the zone that prices the
                  job (M6.3) and the pin the board plots. Matt asked for the
                  type-ahead at 7:25; this is also what replaces the site's
                  stored zone.
                */}
                <Controller
                  control={control}
                  name="placeId"
                  render={({ field }) => (
                    <Field
                      id="job-place"
                      label="Suburb"
                      required
                      error={errors.placeId?.message}
                      hint="Decides the zone, and the zone decides the rate."
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

                <Field id="job-builder" label="Builder" error={errors.builderName?.message}>
                  {(aria) => (
                    <Input {...aria} placeholder="GJ Gardner" {...register('builderName')} />
                  )}
                </Field>

                {/*
                  One field, not two.
                  Matt, 9:08: *"they are one and the same, we don't need both of
                  them."* Kept under the PO name because that is what prints on
                  the invoice (9:56).
                */}
                {/*
                  M2.12 — the confirmed purchase orders on this account.
                  Choosing one supplies the area, the bag allowance and the PO
                  number from the document PlastaGo already holds, instead of
                  asking somebody to retype figures off a PDF.
                */}
                <Field
                  id="job-purchase-order"
                  label="Purchase order"
                  error={errors.purchaseOrderId?.message}
                  hint={
                    accountId === ''
                      ? 'Choose an account first.'
                      : purchaseOrders.isPending
                        ? 'Loading orders…'
                        : (purchaseOrders.data?.length ?? 0) === 0
                          ? 'No purchase orders on file for this account.'
                          : 'Supplies the m², the bag allowance and the PO number.'
                  }
                >
                  {(aria) => (
                    <Select
                      {...aria}
                      {...register('purchaseOrderId')}
                      disabled={accountId === '' || purchaseOrders.isPending}
                    >
                      <option value="">None — enter the details by hand</option>
                      {purchaseOrders.data?.map((order) => (
                        <option
                          key={order.id}
                          value={order.id}
                          /*
                            One order, one job: an invoice is raised per job and
                            a builder pays one purchase order once. Shown rather
                            than hidden, so somebody hunting for it sees where it
                            went instead of keying it in again.
                          */
                          disabled={order.usedByJobNumber !== null}
                        >
                          {order.poNumber}
                          {order.expectedAreaM2 === null
                            ? ' · fixed price'
                            : ` · ${String(order.expectedAreaM2)} m²`}
                          {order.suburb === null ? '' : ` · ${order.suburb}`}
                          {order.usedByJobNumber === null
                            ? ''
                            : ` — already on job ${String(order.usedByJobNumber)}`}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>

                {chosenOrder !== null && (
                  <Alert variant="info" title={`Booking against ${chosenOrder.poNumber}`}>
                    {chosenOrder.expectedAreaM2 === null
                      ? 'This order states a fixed price and no square metres, so the job prices on the call-out fee. That is correct — do not guess an area.'
                      : `The job will be priced on ${String(chosenOrder.expectedAreaM2)} m² and ${String(chosenOrder.bagAllowance ?? 0)} bag(s) from the order.`}
                  </Alert>
                )}
                <Field
                  id="job-po"
                  label="PO / job reference"
                  error={errors.poNumber?.message}
                  hint={
                    lockedToOrder
                      ? `Taken from the order — the number the builder matches on.`
                      : 'Whatever the customer quotes. Can be added later if it has not arrived.'
                  }
                >
                  {(aria) => (
                    <Input
                      {...aria}
                      {...register('poNumber')}
                      autoComplete="off"
                      disabled={lockedToOrder}
                      placeholder={lockedToOrder ? (chosenOrder?.poNumber ?? '') : undefined}
                    />
                  )}
                </Field>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>When and what</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field
                  id="job-ready-date"
                  label="Ready date"
                  required
                  error={errors.readyDate?.message}
                  hint="Target is this date plus 5 business days."
                >
                  {(aria) => <DatePicker {...aria} {...register('readyDate')} />}
                </Field>

                <Field
                  id="job-service-level"
                  label="Service level"
                  error={errors.serviceLevel?.message}
                >
                  {(aria) => (
                    <Select {...aria} {...register('serviceLevel')}>
                      <option value="standard">Standard</option>
                      <option value="urgent">Urgent</option>
                    </Select>
                  )}
                </Field>

                <Field id="job-freight" label="Freight item" error={errors.freightItem?.message}>
                  {(aria) => (
                    <Select {...aria} {...register('freightItem')}>
                      {FREIGHT_ITEMS.map((item) => (
                        <option key={item} value={item}>
                          {FREIGHT_ITEM_LABELS[item]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>

                <Field
                  id="job-area"
                  label="Expected m²"
                  error={errors.expectedAreaM2?.message}
                  hint={
                    lockedToOrder
                      ? chosenOrder?.expectedAreaM2 === null
                        ? 'The order states a fixed price and no area.'
                        : 'From the purchase order.'
                      : 'Board installed — this is what gets priced.'
                  }
                >
                  {(aria) => (
                    <Input
                      {...aria}
                      {...register('expectedAreaM2')}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={1}
                      /*
                        Locked, not hidden. The server takes the area from the
                        order regardless, and an editable box whose value is
                        silently discarded is worse than a disabled one that
                        says why.
                      */
                      disabled={lockedToOrder}
                      placeholder={
                        lockedToOrder ? String(chosenOrder?.expectedAreaM2 ?? '—') : undefined
                      }
                    />
                  )}
                </Field>

                <Field
                  id="job-bags"
                  label="Recycling bags"
                  error={errors.bagCount?.message}
                  hint={lockedToOrder ? 'From the purchase order.' : '$30 each.'}
                >
                  {(aria) => (
                    <Input
                      {...aria}
                      {...register('bagCount')}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={1}
                      disabled={lockedToOrder}
                      placeholder={
                        lockedToOrder ? String(chosenOrder?.bagAllowance ?? 0) : undefined
                      }
                    />
                  )}
                </Field>

                <Field
                  id="job-notes"
                  label="Notes"
                  error={errors.notes?.message}
                  className="sm:col-span-2"
                >
                  {(aria) => (
                    <Textarea
                      {...aria}
                      {...register('notes')}
                      rows={3}
                      placeholder="Anything the driver needs to know on arrival."
                    />
                  )}
                </Field>
              </CardContent>
            </Card>

            {/*
              ── Site access and contact ────────────────────────────────────
              ⚠️ These seven fields were declared on this form's schema, given
              defaults, carried through `JobDraft`, stored on the job — and had
              no inputs. Nothing in the product could set them.

              The driver app is built around them: a "Call site" button on the
              mobile, an Access panel read before getting out of the truck,
              Induction and Crane badges, gate hours, and a "No site contact on
              this job — ring the office" fallback for when they are empty. So
              every job booked here reached the driver with that fallback and a
              phone call back to the office, which is the thing the fields exist
              to prevent.

              Optional on purpose: a phone booking often has none of it, and the
              form must not block on what the caller did not say.
            */}
            <Card>
              <CardHeader>
                <CardTitle>Site access and contact</CardTitle>
                <CardDescription>
                  What the driver needs on arrival. All optional — anything left blank simply does
                  not show on their screen.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field
                  id="job-contact-name"
                  label="Site contact"
                  error={errors.siteContactName?.message}
                >
                  {(aria) => (
                    <Input {...aria} placeholder="Dave Nguyen" {...register('siteContactName')} />
                  )}
                </Field>

                <Field
                  id="job-contact-mobile"
                  label="Site contact mobile"
                  hint="The number the driver taps to call from site."
                  error={errors.siteContactMobile?.message}
                >
                  {(aria) => (
                    <Input
                      {...aria}
                      type="tel"
                      inputMode="tel"
                      placeholder="0412 345 678"
                      {...register('siteContactMobile')}
                    />
                  )}
                </Field>

                <Field
                  id="job-contact-email"
                  label="Site contact email"
                  error={errors.siteContactEmail?.message}
                >
                  {(aria) => (
                    <Input
                      {...aria}
                      type="email"
                      placeholder="dave@example.com.au"
                      {...register('siteContactEmail')}
                    />
                  )}
                </Field>

                <Field
                  id="job-gate-hours"
                  label="Gate hours"
                  hint="When the site can actually be entered."
                  error={errors.gateHours?.message}
                >
                  {(aria) => (
                    <Input {...aria} placeholder="6:30am – 3:30pm" {...register('gateHours')} />
                  )}
                </Field>

                <Field
                  id="job-access-notes"
                  label="Access notes"
                  error={errors.accessNotes?.message}
                  className="sm:col-span-2"
                >
                  {(aria) => (
                    <Textarea
                      {...aria}
                      {...register('accessNotes')}
                      rows={2}
                      placeholder="Gate code, where to park, which lot to enter from."
                    />
                  )}
                </Field>

                <label className="flex items-start gap-2.5 text-sm">
                  <Checkbox className="mt-0.5" {...register('inductionRequired')} />
                  <span>
                    <span className="block font-medium">Induction required</span>
                    <span className="block text-xs text-muted-foreground">
                      The driver cannot start without one.
                    </span>
                  </span>
                </label>

                <label className="flex items-start gap-2.5 text-sm">
                  <Checkbox className="mt-0.5" {...register('craneAvailable')} />
                  <span>
                    <span className="block font-medium">Crane on site</span>
                    <span className="block text-xs text-muted-foreground">
                      Changes how the load comes out.
                    </span>
                  </span>
                </label>
              </CardContent>
            </Card>
          </div>

          {/* ── Price preview ────────────────────────────────────────────── */}
          <div className="space-y-4">
            <Card className="lg:sticky lg:top-20">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CircleDollarSignIcon aria-hidden className="size-4 text-muted-foreground" />
                  Estimate
                </CardTitle>
              </CardHeader>

              <CardContent className="space-y-3">
                {priceDraft === null ? (
                  <p className="text-sm text-muted-foreground">
                    Choose an account and a site to see the price. The zone comes from the site.
                  </p>
                ) : preview.isPending ? (
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="mt-4 h-8 w-32" />
                  </div>
                ) : preview.error ? (
                  <Alert variant="destructive" title="Could not price this job">
                    {describeError(preview.error).detail}
                  </Alert>
                ) : preview.data ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      {ZONE_LABELS[preview.data.zone]} zone
                    </p>

                    <ul className="space-y-2 border-y border-border py-3 text-sm">
                      {preview.data.lines.map((line) => (
                        <li key={line.code} className="flex items-start justify-between gap-3">
                          <span className="min-w-0">
                            <span className="block">{line.description}</span>
                            {/* qty × rate, which TransVirtual cannot render. */}
                            <span className="block text-xs text-muted-foreground tabular-nums">
                              {line.quantity.toLocaleString('en-AU')} × {formatMoney(line.unitRate)}
                            </span>
                          </span>
                          <span className="shrink-0 font-medium tabular-nums">
                            {formatMoney(line.amount)}
                          </span>
                        </li>
                      ))}
                    </ul>

                    <dl className="space-y-1 text-sm">
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Subtotal ex GST</dt>
                        <dd className="font-medium tabular-nums">
                          {formatMoney(preview.data.subtotalExGst)}
                        </dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">GST</dt>
                        <dd className="tabular-nums">{formatMoney(preview.data.gst)}</dd>
                      </div>
                      <div className="flex justify-between border-t border-border pt-1.5">
                        <dt className="font-medium">Total inc GST</dt>
                        <dd className="font-display text-lg font-semibold tabular-nums">
                          {formatMoney(preview.data.totalIncGst)}
                        </dd>
                      </div>
                    </dl>

                    {preview.data.caveat && (
                      <Alert variant="warning" title="Estimate is incomplete">
                        {preview.data.caveat}
                      </Alert>
                    )}

                    <p className="text-xs text-muted-foreground">
                      Priced by the rate engine, not by this screen. Additional services raised on
                      site are added later and may need their own PO.
                    </p>
                  </>
                ) : null}
              </CardContent>
            </Card>

            <div className="flex flex-col gap-2">
              <Button type="submit" size="lg" disabled={isSubmitting}>
                {isSubmitting && <Spinner className="text-current" />}
                {isSubmitting ? 'Creating job…' : 'Create job'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void navigate('/admin/jobs')}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
