import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_DESCRIPTIONS,
  ACCOUNT_TYPE_LABELS,
  AccountDraftSchema,
  AccountTypeSchema,
  BRAND_LABELS,
  CAPTURE_MODES,
  CAPTURE_MODE_LABELS,
  PO_POLICIES,
  PO_POLICY_LABELS,
  type AccountType,
} from '@plastago/shared';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  Input,
  Select,
  Spinner,
  Textarea,
  useToast,
} from '@plastago/ui';
import { zodResolver } from '@hookform/resolvers/zod';
import { BuildingIcon } from 'lucide-react';
import { useForm, useWatch } from 'react-hook-form';
import * as z from 'zod';
import { Link, useNavigate } from 'react-router';
import { PageHeader } from '@/components/page-header';
import { CONFIGURED_BRAND_IDS, IS_MULTI_BRAND } from '@/config/brands';
import { useCreateCustomer } from '@/features/customers/queries';
import { useRateCardOptions, useSelectableZones } from '@/features/lookups/queries';
import { normaliseAbnInput } from '@/lib/format';
import { describeError } from '@/lib/error-message';
import { isServiceError } from '@/services/service-error';

/**
 * Create an account directly, with no lead behind it.
 *
 * ── Why this screen exists ────────────────────────────────────────────────
 * Matt, 6:10: *"we also need the ability to create customer accounts manually
 * without going through the lead and invite process. For the larger builders
 * like Clarendon Homes, they won't go through… we'll just create the account for
 * them and give them the details."*
 *
 * The lead queue was built to stop enquiries being typed straight in as jobs. It
 * was never meant to be the only door into the customer list, and for the
 * accounts that matter most it is the wrong door: the relationship was
 * negotiated in a meeting months ago, and inventing a lead so it can be closed
 * the same minute is paperwork that describes nothing.
 *
 * ── Why the invitation is OFF by default here ─────────────────────────────
 * That is the difference between this screen and the conversion. Matt, 6:36:
 * *"they won't go through create your own account — we'll just create the
 * account for them."* A builder whose terms were signed in a contract does not
 * need the self-serve onboarding, and sending it would ask them to accept
 * conditions their legal team already negotiated.
 */
/**
 * The form's schema: the API's, plus the two fields that must be CHOSEN.
 *
 * ── Why these two open empty ──────────────────────────────────────────────
 * Both used to be pre-filled — the rate card as `default`, the type as
 * `builder` — and both are decisions nothing later asks about again. A rate
 * card is what every invoice on the account is computed from, so an unnoticed
 * default is a pricing incident that surfaces a month later as an invoice nobody
 * can explain. The type decides whether the customer gets site supervisors and
 * which booking form they see (Matt, 21:55).
 *
 * The conversion dialog has always forced both. This is the same rule, so the
 * two doors into the customer list cannot produce differently-configured
 * accounts.
 */
const CustomerFormSchema = AccountDraftSchema.extend({
  accountType: z.literal('').or(AccountTypeSchema),
  rateCardId: z.string(),
  /*
   * Overridden to a plain string so '' is representable in the form.
   *
   * ⚠️ It used to default to Sydney, because a constant was lying around to
   * default to. The same argument the file already makes for `accountType` and
   * `rateCardId` applies here: the zone decides the service charge and the
   * per-m² rate on every invoice, so an unnoticed default is a pricing incident
   * that surfaces a month later as an invoice nobody can explain.
   *
   * It also solves the ordering problem outright — '' is valid before the zone
   * list loads and after, so `defaultValues` never has to wait on a fetch.
   */
  primaryZoneId: z.string(),
}).superRefine((values, ctx) => {
  if (values.primaryZoneId === '') {
    ctx.addIssue({
      code: 'custom',
      path: ['primaryZoneId'],
      message:
        'Choose the primary zone. The service charge and the per-m² rate both vary by zone.',
    });
  }

  if (values.accountType === '') {
    ctx.addIssue({
      code: 'custom',
      path: ['accountType'],
      message:
        'Choose builder or contractor. It decides whether they get site supervisors and which booking form they see.',
    });
  }

  if (values.rateCardId === '') {
    ctx.addIssue({
      code: 'custom',
      path: ['rateCardId'],
      message: 'Choose the rate card. Every invoice for this customer is priced from it.',
    });
  }
});

type CustomerForm = z.input<typeof CustomerFormSchema>;

export function AdminCustomerCreatePage() {
  const toast = useToast();
  const navigate = useNavigate();
  const create = useCreateCustomer();

  /*
   * The rate cards, loaded (M6.1).
   *
   * Falling back to an empty list rather than gating the page on a spinner: the
   * rest of this form is usable while seven rows arrive, and the server refuses
   * a card that does not exist anyway — so an empty dropdown fails safe instead
   * of silently assigning the default.
   */
  const rateCards = useRateCardOptions().data ?? [];
  /* Live zones only: a new customer is never assigned to a retired one. */
  const zones = useSelectableZones();

  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
    setError,
    setValue,
  } = useForm<CustomerForm>({
    resolver: zodResolver(CustomerFormSchema),
    mode: 'onTouched',
    defaultValues: {
      customerCode: '',
      legalName: '',
      abn: '',
      // Empty, not 'builder' — see `CustomerFormSchema`.
      accountType: '',
      brandId: 'plastago',
      // Empty, not 'default' — see `CustomerFormSchema`.
      rateCardId: '',
      poPolicy: 'not-required',
      captureMode: 'area-only',
      paymentTermsDays: 7,
      primaryZoneId: '',
      accountsContactName: '',
      accountsContactEmail: '',
      sendInvitation: false,
      notes: '',
    },
  });

  // `useWatch` rather than `watch` — the latter re-renders on every keystroke
  // in the form, and the React Compiler skips a component that calls it.
  const accountType = useWatch({ control, name: 'accountType' });
  const sendInvitation = useWatch({ control, name: 'sendInvitation' });

  const submit = handleSubmit(async (values) => {
    try {
      /*
       * The cast is safe: `CustomerFormSchema` has already rejected `''`, so by
       * the time the resolver hands values over, the type has been chosen.
       */
      const { account, welcome } = await create.mutateAsync({
        ...values,
        accountType: values.accountType as AccountType,
      });

      /*
       * ⚠️ What the send ACTUALLY did, never what was asked for.
       *
       * This used to announce "an onboarding link is on its way" whenever the
       * box was ticked — and nothing was ever sent, because the endpoint did not
       * send it. A cheerful message over a failed provider is how a customer
       * ends up waiting for an email nobody knows never left.
       */
      if (welcome === null) {
        toast.success(
          `${account.name} created as ${account.code}`,
          'No invitation sent — their terms are handled off-system.',
        );
      } else if (welcome.outcome === 'sent' || welcome.outcome === 'duplicate') {
        toast.success(
          `${account.name} created as ${account.code}`,
          `Onboarding link emailed to ${welcome.toMasked ?? 'their accounts contact'}.`,
        );
      } else {
        toast.warning(
          `${account.name} created as ${account.code}, but the invitation did not send`,
          `${welcome.detail ?? 'The email did not go out'} — tell them their customer code by phone; they can sign in as soon as they have it.`,
        );
      }

      await navigate(`/admin/customers/${account.id}`);
    } catch (caught) {
      if (isServiceError(caught) && Object.keys(caught.fieldErrors).length > 0) {
        for (const [field, message] of Object.entries(caught.fieldErrors)) {
          setError(field as keyof CustomerForm, { type: 'server', message });
        }
        return;
      }
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="New customer"
        description="For an account we already have a relationship with. Enquiries belong in the lead queue."
        actions={
          <Link
            to="/admin/queues/leads"
            className="text-sm text-primary underline underline-offset-4"
          >
            This is an enquiry →
          </Link>
        }
      />

      <form onSubmit={(event) => void submit(event)} className="space-y-6" noValidate>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BuildingIcon aria-hidden className="size-4 text-muted-foreground" />
              The business
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              id="cc-code"
              label="Customer code"
              required
              error={errors.customerCode?.message}
              hint="Three letters then three digits — CLA001. It appears on every invoice."
            >
              {(aria) => (
                <Input
                  {...aria}
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="NEW001"
                  {...register('customerCode', {
                    /*
                     * ⚠️ The VALUE, not a text-transform.
                     *
                     * This field used to carry `uppercase` as a CSS class, so a
                     * typed "abc001" showed as ABC001 and was submitted as
                     * abc001 — rejected by a rule the screen appeared to be
                     * meeting. Stripping punctuation as well means a pasted
                     * "BEL-001" arrives as BEL001 rather than as an error.
                     */
                    onChange: (event: { target: { value: string } }) => {
                      setValue(
                        'customerCode',
                        event.target.value
                          .toUpperCase()
                          .replace(/[^A-Z0-9]/g, '')
                          .slice(0, 6),
                      );
                    },
                  })}
                />
              )}
            </Field>

            <Field
              id="cc-name"
              label="Registered company name"
              required
              error={errors.legalName?.message}
            >
              {(aria) => (
                <Input {...aria} placeholder="Clarendon Homes" {...register('legalName')} />
              )}
            </Field>

            <Field id="cc-abn" label="ABN" required error={errors.abn?.message}>
              {(aria) => (
                <Input
                  {...aria}
                  inputMode="numeric"
                  className="font-mono"
                  placeholder="61004213771"
                  {...register('abn', {
                    // Digits only, capped at eleven — the resolver still decides
                    // whether the number passes the ATO checksum.
                    onChange: (event: { target: { value: string } }) => {
                      setValue('abn', normaliseAbnInput(event.target.value));
                    },
                  })}
                />
              )}
            </Field>

            <Field
              id="cc-zone"
              label="Primary zone"
              required
              error={errors.primaryZoneId?.message}
              hint="Where most of their work is. Each job is still zoned by its own address."
            >
              {(aria) => (
                <Select {...aria} {...register('primaryZoneId')} disabled={zones.length === 0}>
                  <option value="">Choose a zone…</option>
                  {zones.map((zone) => (
                    <option key={zone.value} value={zone.value}>
                      {zone.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            {/*
              Builder or contractor decides whether they get site supervisors and
              whether their booking form asks for area and bags (Matt, 21:55). It
              is the first thing to get right, not a detail.
            */}
            <Field
              id="cc-type"
              label="Type"
              required
              error={errors.accountType?.message}
              hint={
                accountType
                  ? ACCOUNT_TYPE_DESCRIPTIONS[accountType]
                  : 'Decides site supervisors and which booking form they get.'
              }
            >
              {(aria) => (
                <Select {...aria} {...register('accountType')}>
                  <option value="">Choose builder or contractor…</option>
                  {ACCOUNT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {ACCOUNT_TYPE_LABELS[type]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            {/*
              One configured brand is not a choice, so the form submits its
              default — the same rule the conversion dialog follows.

              It used to list every id in `BRAND_IDS`, which is the set the
              SCHEMA accepts so that records already carrying EasyLift or BrickGo
              keep their label. Neither trades, so offering them here let the
              office open an account under a brand that does not operate. The set
              a person can choose from follows `config/brands`; re-listing one
              there brings this field back.
            */}
            {IS_MULTI_BRAND && (
              <Field id="cc-brand" label="Brand" required error={errors.brandId?.message}>
                {(aria) => (
                  <Select {...aria} {...register('brandId')}>
                    {CONFIGURED_BRAND_IDS.map((brand) => (
                      <option key={brand} value={brand}>
                        {BRAND_LABELS[brand]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Commercial terms</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/*
              A wrong rate card is a pricing incident, not a typo — every invoice
              on the account is computed from it. Nothing here is defaulted
              silently for that reason.
            */}
            <Field
              id="cc-rate-card"
              label="Rate card"
              required
              error={errors.rateCardId?.message}
              hint="Every invoice for this customer is priced from it."
            >
              {(aria) => (
                <Select {...aria} {...register('rateCardId')}>
                  <option value="">Choose a rate card…</option>
                  {/*
                    Loaded, not hardcoded. Rate cards are records an
                    administrator creates on the Pricing tab, so a card added
                    this morning has to be selectable this afternoon — a
                    compile-time list could only ever offer the ones that
                    shipped.
                  */}
                  {rateCards.map((card) => (
                    <option key={card.value} value={card.value}>
                      {card.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field
              id="cc-terms"
              label="Payment terms"
              required
              error={errors.paymentTermsDays?.message}
              hint="Days. Their standard is 7."
            >
              {(aria) => (
                <Input
                  {...aria}
                  type="number"
                  min={0}
                  max={90}
                  {...register('paymentTermsDays', { valueAsNumber: true })}
                />
              )}
            </Field>

            <Field id="cc-po" label="PO policy" required error={errors.poPolicy?.message}>
              {(aria) => (
                <Select {...aria} {...register('poPolicy')}>
                  {PO_POLICIES.map((policy) => (
                    <option key={policy} value={policy}>
                      {PO_POLICY_LABELS[policy]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field
              id="cc-capture"
              label="What we record"
              required
              error={errors.captureMode?.message}
              hint="Weight is needed for recycling certificates."
            >
              {(aria) => (
                <Select {...aria} {...register('captureMode')}>
                  {CAPTURE_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {CAPTURE_MODE_LABELS[mode]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Accounts contact</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              id="cc-contact-name"
              label="Who handles their invoices"
              error={errors.accountsContactName?.message}
            >
              {(aria) => (
                <Input {...aria} placeholder="Marcus Webb" {...register('accountsContactName')} />
              )}
            </Field>

            <Field
              id="cc-contact-email"
              label="Invoices emailed to"
              error={errors.accountsContactEmail?.message}
            >
              {(aria) => (
                <Input
                  {...aria}
                  type="email"
                  inputMode="email"
                  placeholder="ap@company.com.au"
                  {...register('accountsContactEmail')}
                />
              )}
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Terms and conditions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/*
              Off by default, and that is the whole point of this screen.
              Matt, 6:36: *"they won't go through create your own account — we'll
              just create the account for them and give them the details."*
            */}
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3">
              <Checkbox id="cc-invite" className="mt-0.5" {...register('sendInvitation')} />
              <span>
                <span className="block text-sm font-medium">Email them the onboarding link</span>
                <span className="block text-xs text-muted-foreground">
                  They complete their own details and accept the terms. Leave this off for a
                  customer whose terms are already covered by a signed contract. Needs an accounts
                  contact email above — there is nowhere else to send it.
                </span>
              </span>
            </label>

            {!sendInvitation && (
              <Alert variant="neutral" title="Recorded as agreed off-system">
                The account opens ready to trade. Nothing will chase them for a director&rsquo;s
                guarantee, because you are saying one already exists.
              </Alert>
            )}

            <Field id="cc-notes" label="Notes" error={errors.notes?.message}>
              {(aria) => (
                <Textarea
                  {...aria}
                  rows={3}
                  placeholder="Anything the office should know about this account."
                  {...register('notes')}
                />
              )}
            </Field>
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? <Spinner label="Creating" /> : null}
            Create account
          </Button>
          <Link
            to="/admin/customers"
            className="text-sm text-muted-foreground underline underline-offset-4"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
