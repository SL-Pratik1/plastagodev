import { AccountOnboardingSchema, type AccountOnboarding } from '@plastago/shared';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  ErrorState,
  Field,
  Input,
  Skeleton,
  Spinner,
  useToast,
} from '@plastago/ui';
import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2Icon, ShieldCheckIcon } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import { PageHeader } from '@/components/page-header';
import { useCompleteOnboarding, useOnboardingInvite } from '@/features/portal/queries';
import { describeError } from '@/lib/error-message';
import { formatDateTime } from '@/lib/format';

/**
 * Journey A.4 — the customer completes their own account.
 *
 * ── What this screen replaces ─────────────────────────────────────────────
 * A PDF account application form that Matt emails, chases, and files. It exists
 * for one reason, and it is not administrative — 7:49: *"it's a contractual
 * thing where some customers require them to give a **director's guarantee**…
 * it's more of a legal precedent that they have to sign off on those account
 * terms and conditions."*
 *
 * Chirag proposed the invite flow and Matt agreed to it twice — *"send them the
 * invite for them to complete this part"* (9:07), and on the terms checkbox,
 * *"yeah, beautiful"* (9:24).
 *
 * ── The division of labour ────────────────────────────────────────────────
 * The office already set the rate card, the PO policy and the payment terms when
 * they converted the lead. None of those appear here, and that is the point: a
 * commercial term is negotiated, not filled in by whoever opens the email. This
 * form asks only for what the customer is the authority on — their own registered
 * details, who handles their invoices, where certificates go — and the tick.
 *
 * ── Why the accepting person is typed rather than taken from the session ──
 * A guarantee is given by a named individual. The person signed in may be an
 * accounts clerk acting for a director, so asking makes who accepted an explicit
 * answer instead of an inference from whose password was used.
 */
export function PortalWelcomePage() {
  const invite = useOnboardingInvite();
  const complete = useCompleteOnboarding();
  const toast = useToast();
  const navigate = useNavigate();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<AccountOnboarding>({
    resolver: zodResolver(AccountOnboardingSchema),
    mode: 'onTouched',
    defaultValues: {
      legalName: '',
      tradingName: '',
      abn: '',
      addressLine: '',
      suburb: '',
      postcode: '',
      accountsContactName: '',
      accountsContactEmail: '',
      certificateEmail: '',
      acceptedByName: '',
      acceptedByRole: '',
    },
  });

  const submit = handleSubmit(async (values) => {
    try {
      await complete.mutateAsync(values);
      toast.success('Account activated', 'Everything is open to you now.');
      await navigate('/portal');
    } catch (caught) {
      const described = describeError(caught);
      setError('root', { message: described.detail ?? described.title });
      toast.error(described.title, described.detail);
    }
  });

  if (invite.error) {
    const described = describeError(invite.error);
    return (
      <Card>
        <ErrorState
          title={described.title}
          description={described.detail}
          onRetry={() => void invite.refetch()}
        />
      </Card>
    );
  }

  if (invite.isPending || !invite.data) {
    return (
      <Card className="p-6">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="mt-4 h-40 w-full" />
      </Card>
    );
  }

  const { data } = invite;

  /*
   * Already done.
   *
   * Shown rather than redirected, because someone who follows the invite link a
   * second time — or forwards it to a colleague — needs to be told the account is
   * active, not silently dropped on a dashboard.
   */
  if (data.state === 'complete' && data.acceptance !== null) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <PageHeader title="Account active" description={data.customerCode} />
        <Alert variant="success" title="Your terms are on file">
          Accepted by <strong>{data.acceptance.acceptedByName}</strong> (
          {data.acceptance.acceptedByRole}) on {formatDateTime(data.acceptance.acceptedAt)}.
        </Alert>
        <Link to="/portal" className="text-sm text-primary underline underline-offset-4">
          Go to your dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title={`Welcome, ${data.suggestedLegalName}`}
        description={`Account ${data.customerCode} — a few details and you are open for bookings.`}
      />

      <Alert variant="info" title="Your pricing is already set">
        We agreed your rate card and payment terms when we opened the account. Nothing on this page
        changes what a pickup costs — it is your company details and the terms of trade.
      </Alert>

      <form onSubmit={(event) => void submit(event)} className="space-y-6" noValidate>
        <Card>
          <CardHeader>
            <CardTitle>Your business</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              id="onb-legal-name"
              label="Registered company name"
              required
              error={errors.legalName?.message}
              hint="Exactly as registered — this appears on every invoice."
            >
              {(control) => (
                <Input
                  {...control}
                  defaultValue={data.suggestedLegalName}
                  {...register('legalName')}
                />
              )}
            </Field>

            <Field id="onb-trading-name" label="Trading name" error={errors.tradingName?.message}>
              {(control) => (
                <Input {...control} placeholder="If different" {...register('tradingName')} />
              )}
            </Field>

            <Field id="onb-abn" label="ABN" required error={errors.abn?.message}>
              {(control) => (
                <Input
                  {...control}
                  inputMode="numeric"
                  placeholder="24 118 552 901"
                  className="font-mono"
                  {...register('abn')}
                />
              )}
            </Field>

            <Field
              id="onb-address"
              label="Registered address"
              required
              error={errors.addressLine?.message}
            >
              {(control) => (
                <Input {...control} placeholder="12 Kembla Street" {...register('addressLine')} />
              )}
            </Field>

            <Field id="onb-suburb" label="Suburb" required error={errors.suburb?.message}>
              {(control) => <Input {...control} {...register('suburb')} />}
            </Field>

            <Field id="onb-postcode" label="Postcode" required error={errors.postcode?.message}>
              {(control) => (
                <Input {...control} inputMode="numeric" maxLength={4} {...register('postcode')} />
              )}
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Where things go</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              id="onb-accounts-name"
              label="Who handles your invoices"
              required
              error={errors.accountsContactName?.message}
            >
              {(control) => <Input {...control} {...register('accountsContactName')} />}
            </Field>

            <Field
              id="onb-accounts-email"
              label="Invoices emailed to"
              required
              error={errors.accountsContactEmail?.message}
            >
              {(control) => (
                <Input
                  {...control}
                  type="email"
                  inputMode="email"
                  placeholder="accounts@company.com.au"
                  {...register('accountsContactEmail')}
                />
              )}
            </Field>

            {/*
              Asked here because the customer knows the answer and we do not.
              Matt, 31:04: certificates go to a compliance or ESG team that has
              nothing to do with accounts payable.
            */}
            <Field
              id="onb-certificate-email"
              label="Recycling certificates emailed to"
              error={errors.certificateEmail?.message}
              hint="Often a compliance or sustainability address. Leave blank to use your accounts email."
            >
              {(control) => (
                <Input
                  {...control}
                  type="email"
                  inputMode="email"
                  placeholder="esg@company.com.au"
                  {...register('certificateEmail')}
                />
              )}
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheckIcon aria-hidden className="size-4 text-muted-foreground" />
              Terms and conditions
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/*
              The scrollable terms are here rather than behind a link on purpose:
              this tick is the record that replaces a signed PDF (Matt, 7:49), and
              "I was never shown them" is the objection it has to survive.
            */}
            <div className="max-h-56 space-y-3 overflow-y-auto rounded-lg border border-border bg-muted/40 p-4 text-xs leading-relaxed">
              <p className="font-medium">PlastaGo Pty Ltd — Terms of Trade (version {data.termsVersion})</p>
              <p>
                1. <strong>Payment.</strong> Invoices are payable within the terms agreed on your
                account. Amounts outstanding beyond those terms may attract interest and recovery
                costs.
              </p>
              <p>
                2. <strong>Director&rsquo;s guarantee.</strong> The person accepting these terms
                warrants that they are authorised to bind the customer, and where the customer is a
                company, personally guarantees payment of all amounts owing.
              </p>
              <p>
                3. <strong>Site access and readiness.</strong> The customer is responsible for safe
                truck access and for the material being stacked, ready and free of contaminants on
                the nominated date. Futile pickups and contaminated loads are chargeable.
              </p>
              <p>
                4. <strong>Purchase orders.</strong> Where your account requires a purchase order,
                additional charges arising on site require their own order before they can be
                invoiced.
              </p>
              <p>
                5. <strong>Certificates.</strong> Diversion certificates are issued only for loads
                whose weight was measured at the weighbridge.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                id="onb-accepted-name"
                label="Full name of the person accepting"
                required
                error={errors.acceptedByName?.message}
              >
                {(control) => <Input {...control} {...register('acceptedByName')} />}
              </Field>

              <Field
                id="onb-accepted-role"
                label="Their position"
                required
                error={errors.acceptedByRole?.message}
                hint="Director, Owner, Accounts Manager"
              >
                {(control) => <Input {...control} {...register('acceptedByRole')} />}
              </Field>
            </div>

            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3">
              <Checkbox id="onb-terms" className="mt-0.5" {...register('termsAccepted')} />
              <span>
                <span className="block text-sm font-medium">
                  I accept these terms on behalf of the customer
                </span>
                <span className="block text-xs text-muted-foreground">
                  Recorded with your name, position and today&rsquo;s date.
                </span>
              </span>
            </label>
            {errors.termsAccepted && (
              <p className="text-sm text-destructive">{errors.termsAccepted.message}</p>
            )}
          </CardContent>
        </Card>

        {errors.root && <Alert variant="destructive" title="Could not activate the account">{errors.root.message}</Alert>}

        <Button type="submit" disabled={isSubmitting} className="w-full sm:w-auto">
          {isSubmitting ? <Spinner label="Activating" /> : <CheckCircle2Icon aria-hidden />}
          Accept and activate the account
        </Button>
      </form>
    </div>
  );
}
