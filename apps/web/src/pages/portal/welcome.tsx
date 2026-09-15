import { AccountOnboardingSchema, type AccountOnboarding } from '@plastago/shared';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Field,
  Input,
  Skeleton,
  Spinner,
  useToast,
} from '@plastago/ui';
import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2Icon } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { PageHeader } from '@/components/page-header';
import { useCompleteOnboarding, useOnboardingInvite } from '@/features/portal/queries';
import { describeError } from '@/lib/error-message';
import { formatDateTime, normaliseAbnInput } from '@/lib/format';

/**
 * The customer completes their own company details.
 *
 * ── The division of labour ────────────────────────────────────────────────
 * The office set the rate card, the PO policy and the payment terms when they
 * opened the account. None of those appear here, and that is the point: a
 * commercial term is negotiated, not filled in by whoever opens the email. This
 * form asks only for what the customer is the authority on — their registered
 * details, who handles their invoices, and where certificates go.
 *
 * ── What used to be here ──────────────────────────────────────────────────
 * A set of terms of trade, the name and position of the person accepting them,
 * and a tick that gated the whole portal until it was made. Removed on the
 * client's instruction; see the note in `packages/shared/src/schemas/party.ts`.
 *
 * ⚠️ Consequence: nothing blocks anybody now, so this screen has to work as a
 * page somebody visits ON PURPOSE and possibly more than once. It opens on what
 * is already on file rather than blank, and it can be submitted again — a
 * customer who has moved office is the one person who knows their new address.
 */
export function PortalWelcomePage() {
  const invite = useOnboardingInvite();
  const complete = useCompleteOnboarding();
  const toast = useToast();
  const navigate = useNavigate();

  /*
   * ⚠️ Opened on WHAT IS ON FILE, via `values` rather than `defaultValues`.
   *
   * The invite arrives after the first render, and `defaultValues` is read once
   * — so a form built from it stays blank no matter what the server said. That
   * was survivable while this screen could only ever be filled in once and was
   * always empty; it is not now, because somebody correcting one line of their
   * address would silently blank the other six.
   *
   * `values` re-syncs when the query resolves and leaves fields the person has
   * already edited alone, which is exactly the behaviour this needs.
   */
  const details = invite.data?.details ?? null;

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
    setValue,
  } = useForm<AccountOnboarding>({
    resolver: zodResolver(AccountOnboardingSchema),
    mode: 'onTouched',
    values: {
      legalName: invite.data?.suggestedLegalName ?? '',
      tradingName: details?.tradingName ?? '',
      abn: details?.abn ?? '',
      addressLine: details?.addressLine ?? '',
      suburb: details?.suburb ?? '',
      postcode: details?.postcode ?? '',
      accountsContactName: details?.accountsContactName ?? '',
      accountsContactEmail: details?.accountsContactEmail ?? '',
      certificateEmail: details?.certificateEmail ?? '',
    },
  });

  const submit = handleSubmit(async (values) => {
    try {
      await complete.mutateAsync(values);
      toast.success(
        'Your details are saved',
        'We will use these on your invoices and certificates.',
      );
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
   * ⚠️ Returning here is NORMAL now, so a completed form is not a dead end.
   *
   * This used to render a terminal "account active" panel with no way back into
   * the form, which was right when the form could only be filled in once. A
   * customer who has moved office or changed accounts clerk has to be able to
   * say so, so the state below is a note above the same editable form.
   */
  const completed = data.completedAt;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title={completed ? 'Your company details' : `Welcome, ${data.suggestedLegalName}`}
        description={
          completed
            ? `Account ${data.customerCode}`
            : `Account ${data.customerCode} — a few details and we have everything we need.`
        }
      />

      {completed ? (
        <Alert variant="success" title="We have your details">
          Last confirmed on {formatDateTime(completed)}. Change anything that is out of date and
          save again.
        </Alert>
      ) : (
        <Alert variant="info" title="Your pricing is already set">
          We agreed your rate card and payment terms when we opened the account. Nothing on this
          page changes what a pickup costs — these are your company details.
        </Alert>
      )}

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
              {(control) => <Input {...control} {...register('legalName')} />}
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
                  {...register('abn', {
                    // Digits only, capped at eleven. The placeholder still shows
                    // the spaced form, because that is how it is printed — the
                    // spacing is dropped on the way in, not refused.
                    onChange: (event: { target: { value: string } }) => {
                      setValue('abn', normaliseAbnInput(event.target.value));
                    },
                  })}
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

        {errors.root && (
          <Alert variant="destructive" title="Could not save your details">
            {errors.root.message}
          </Alert>
        )}

        <Button type="submit" disabled={isSubmitting} className="w-full sm:w-auto">
          {isSubmitting ? <Spinner label="Saving" /> : <CheckCircle2Icon aria-hidden />}
          {completed ? 'Save changes' : 'Save my details'}
        </Button>
      </form>
    </div>
  );
}
