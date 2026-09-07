import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_DESCRIPTIONS,
  ACCOUNT_TYPE_LABELS,
  AccountDraftSchema,
  BRAND_IDS,
  BRAND_LABELS,
  CAPTURE_MODES,
  CAPTURE_MODE_LABELS,
  PO_POLICIES,
  PO_POLICY_LABELS,
  RATE_CARDS,
  RATE_CARD_LABELS,
  ZONES,
  ZONE_LABELS,
  type AccountDraft,
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
import { Link, useNavigate } from 'react-router';
import { PageHeader } from '@/components/page-header';
import { useCreateCustomer } from '@/features/customers/queries';
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
export function AdminCustomerCreatePage() {
  const toast = useToast();
  const navigate = useNavigate();
  const create = useCreateCustomer();

  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<AccountDraft>({
    resolver: zodResolver(AccountDraftSchema),
    mode: 'onTouched',
    defaultValues: {
      customerCode: '',
      legalName: '',
      abn: '',
      accountType: 'builder',
      brandId: 'plastago',
      rateCardId: 'default',
      poPolicy: 'not-required',
      captureMode: 'area-only',
      paymentTermsDays: 7,
      primaryZone: 'sydney',
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
      const account = await create.mutateAsync(values);
      toast.success(
        `${account.name} created as ${account.code}`,
        values.sendInvitation
          ? 'An onboarding link is on its way to their accounts contact.'
          : 'No invitation sent — their terms are handled off-system.',
      );
      await navigate(`/admin/customers/${account.id}`);
    } catch (caught) {
      if (isServiceError(caught) && Object.keys(caught.fieldErrors).length > 0) {
        for (const [field, message] of Object.entries(caught.fieldErrors)) {
          setError(field as keyof AccountDraft, { type: 'server', message });
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
          <CardContent className="grid gap-4 sm:grid-cols-2">
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
                  className="font-mono uppercase"
                  autoComplete="off"
                  placeholder="NEW001"
                  {...register('customerCode')}
                />
              )}
            </Field>

            <Field
              id="cc-name"
              label="Registered company name"
              required
              error={errors.legalName?.message}
            >
              {(aria) => <Input {...aria} placeholder="Clarendon Homes" {...register('legalName')} />}
            </Field>

            <Field id="cc-abn" label="ABN" required error={errors.abn?.message}>
              {(aria) => (
                <Input
                  {...aria}
                  inputMode="numeric"
                  className="font-mono"
                  placeholder="61004213771"
                  {...register('abn')}
                />
              )}
            </Field>

            <Field
              id="cc-zone"
              label="Primary zone"
              required
              error={errors.primaryZone?.message}
              hint="Where most of their work is. Each job is still zoned by its own address."
            >
              {(aria) => (
                <Select {...aria} {...register('primaryZone')}>
                  {ZONES.map((zone) => (
                    <option key={zone} value={zone}>
                      {ZONE_LABELS[zone]}
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
              hint={ACCOUNT_TYPE_DESCRIPTIONS[accountType]}
            >
              {(aria) => (
                <Select {...aria} {...register('accountType')}>
                  {ACCOUNT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {ACCOUNT_TYPE_LABELS[type]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field id="cc-brand" label="Brand" required error={errors.brandId?.message}>
              {(aria) => (
                <Select {...aria} {...register('brandId')}>
                  {BRAND_IDS.map((brand) => (
                    <option key={brand} value={brand}>
                      {BRAND_LABELS[brand]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Commercial terms</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
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
                  {RATE_CARDS.map((card) => (
                    <option key={card} value={card}>
                      {RATE_CARD_LABELS[card]}
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
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field
              id="cc-contact-name"
              label="Who handles their invoices"
              error={errors.accountsContactName?.message}
            >
              {(aria) => <Input {...aria} placeholder="Marcus Webb" {...register('accountsContactName')} />}
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
                <span className="block text-sm font-medium">
                  Email them the onboarding link
                </span>
                <span className="block text-xs text-muted-foreground">
                  They complete their own details and accept the terms. Leave this off for a
                  customer whose terms are already covered by a signed contract.
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
