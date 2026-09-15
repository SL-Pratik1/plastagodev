import { AccountUpdateSchema, type Account, type AccountUpdate } from '@plastago/shared';
import { Alert, Button, Dialog, Field, Input, Spinner, Textarea, useToast } from '@plastago/ui';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useUpdateCustomer } from '@/features/customers/queries';
import { normaliseAbnInput } from '@/lib/format';
import { describeError } from '@/lib/error-message';
import { isServiceError } from '@/services/service-error';

/**
 * Correct an account's details.
 *
 * ── Why this screen exists ────────────────────────────────────────────────
 * Because an account could be created and then never edited. The only two
 * things the API would change afterwards were the risk-assessment switch and
 * builder ↔ contractor, so a misspelt company name, a wrong ABN, a moved
 * registered address or a mistyped accounts email were permanent — and the only
 * workaround was a second account with the same ABN, which splits a customer's
 * invoices and their history down the middle.
 *
 * Four of these fields were worse than uneditable: they could only ever be
 * written by the CUSTOMER, on a portal form, and were returned by no endpoint at
 * all. The office that raises the invoices could neither see nor fix the details
 * the invoice is printed from.
 *
 * ── What is deliberately NOT here ─────────────────────────────────────────
 * The rate card, the payment terms, the PO policy and the capture mode. Every
 * one of them re-prices the account, and this is the form somebody opens to fix
 * a suburb. They are absent from `AccountUpdate` entirely, so this dialog could
 * not send them if it tried — a commercial change is a deliberate act, and a
 * deliberate act deserves its own screen and its own conversation.
 */
export function CustomerEditDialog({
  account,
  open,
  onClose,
}: {
  account: Account;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const update = useUpdateCustomer(account.id);

  /*
   * The accounts contact, which is a separate record from the account.
   *
   * Read off the contacts list rather than passed in separately: this dialog
   * shows what the detail page shows, and resolving it twice in two places is
   * how the form ends up editing a different contact from the one displayed.
   */
  const accounts = account.contacts.find((contact) => contact.role === 'accounts');

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
    setValue,
  } = useForm<AccountUpdate>({
    resolver: zodResolver(AccountUpdateSchema),
    mode: 'onTouched',
    /*
     * ⚠️ `values`, not `defaultValues`. The dialog is mounted alongside the
     * detail page and stays mounted between openings, so a form initialised
     * once would still be showing the previous account's details after a save
     * and a reopen.
     */
    values: {
      legalName: account.name,
      tradingName: account.tradingName ?? '',
      abn: account.abn,
      addressLine: account.addressLine ?? '',
      suburb: account.suburb ?? '',
      postcode: account.postcode ?? '',
      accountsContactName: accounts?.name ?? '',
      accountsContactEmail: accounts?.email ?? '',
      certificateEmail: account.certificateEmail ?? '',
      notes: account.notes,
    },
  });

  const submit = handleSubmit(async (values) => {
    try {
      const saved = await update.mutateAsync(values);
      toast.success(`${saved.name} updated`, 'The changes are on the account now.');
      onClose();
    } catch (caught) {
      /*
       * Field errors go back to their fields. The server owns rules the browser
       * cannot check — chiefly the ABN checksum and the "an email needs a name"
       * pairing — and a banner the reader has to map back to a box themselves
       * is how a correctable mistake turns into a support call.
       */
      if (isServiceError(caught) && Object.keys(caught.fieldErrors).length > 0) {
        for (const [field, message] of Object.entries(caught.fieldErrors)) {
          setError(field as keyof AccountUpdate, { type: 'server', message });
        }
        return;
      }
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={`Edit ${account.name}`}
      description="Their registered details and where their paperwork goes. Nothing here changes what a pickup costs."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={isSubmitting}>
            {isSubmitting && <Spinner label="Saving" />}
            Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Alert variant="neutral" title="Commercial terms are not on this form">
          The rate card, payment terms, PO policy and capture mode stay as they were agreed. Change
          those from the Preferences tab or by raising it with the account owner.
        </Alert>

        <section className="space-y-4">
          <h3 className="text-sm font-semibold">The business</h3>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              id="ce-legal-name"
              label="Registered company name"
              required
              error={errors.legalName?.message}
              hint="As registered — this prints on every invoice."
            >
              {(aria) => <Input {...aria} {...register('legalName')} />}
            </Field>

            <Field
              id="ce-trading-name"
              label="Trading name"
              error={errors.tradingName?.message}
              hint="Only if they trade under a different name."
            >
              {(aria) => (
                <Input {...aria} placeholder="If different" {...register('tradingName')} />
              )}
            </Field>

            <Field id="ce-abn" label="ABN" required error={errors.abn?.message}>
              {(aria) => (
                <Input
                  {...aria}
                  inputMode="numeric"
                  className="font-mono"
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
          </div>
        </section>

        <section className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold">Registered address</h3>
            <p className="text-xs text-muted-foreground">
              Where the company is registered, not where the truck goes — a pickup address is typed
              on the booking.
            </p>
          </div>

          <Field id="ce-address" label="Address" error={errors.addressLine?.message}>
            {(aria) => (
              <Input {...aria} placeholder="12 Kembla Street" {...register('addressLine')} />
            )}
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field id="ce-suburb" label="Suburb" error={errors.suburb?.message}>
              {(aria) => <Input {...aria} {...register('suburb')} />}
            </Field>

            <Field id="ce-postcode" label="Postcode" error={errors.postcode?.message}>
              {(aria) => (
                <Input {...aria} inputMode="numeric" maxLength={4} {...register('postcode')} />
              )}
            </Field>
          </div>
        </section>

        <section className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold">Where their paperwork goes</h3>
            <p className="text-xs text-muted-foreground">
              Invoices and certificates frequently go to different teams.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              id="ce-contact-name"
              label="Who handles their invoices"
              error={errors.accountsContactName?.message}
              hint="Leave blank to keep the contact they already have."
            >
              {(aria) => (
                <Input {...aria} placeholder="Marcus Webb" {...register('accountsContactName')} />
              )}
            </Field>

            <Field
              id="ce-contact-email"
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
          </div>

          <Field
            id="ce-certificate-email"
            label="Recycling certificates emailed to"
            error={errors.certificateEmail?.message}
            hint="Often a compliance or sustainability mailbox. Blank falls back to the accounts contact."
          >
            {(aria) => (
              <Input
                {...aria}
                type="email"
                inputMode="email"
                placeholder="esg@company.com.au"
                {...register('certificateEmail')}
              />
            )}
          </Field>
        </section>

        <Field id="ce-notes" label="Notes" error={errors.notes?.message}>
          {(aria) => (
            <Textarea
              {...aria}
              rows={3}
              placeholder="Anything the office should know about this account."
              {...register('notes')}
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}
