import {
  CAPTURE_MODE_LABELS,
  PO_POLICY_LABELS,
  ZONE_LABELS,
  type PortalAccount,
} from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  ErrorState,
  Field,
  Input,
  Label,
  Skeleton,
  Spinner,
  Switch,
  useToast,
} from '@plastago/ui';
import { MailIcon, PhoneIcon, SaveIcon } from 'lucide-react';
import { useState } from 'react';
import { DetailList } from '@/components/detail-list';
import { usePortalAccount, usePortalUpdateAccount } from '@/features/portal/queries';
import { describeError } from '@/lib/error-message';
import { formatMobile } from '@/lib/format';

/**
 * Account preferences (M5.15 · F29, W71, W81) — Customer Administrator only.
 *
 * ── What is editable and what is not ──────────────────────────────────────
 * Notification preferences and pickup windows are the customer's to set. Payment
 * terms, the rate card and the PO policy are **read-only here**: those are
 * commercially negotiated, and a portal that let a customer change their own
 * payment terms would be a finance incident waiting to happen. They are still
 * *shown*, because "what are our terms again" is a real question and the answer
 * being visible saves a call.
 *
 * ── Why per-contact channels matter more than they look ───────────────────
 * M8.4's observation is that today there is exactly one email on the account —
 * the site contact. The AP person who needs the invoice and the sustainability
 * manager who needs the diversion data get nothing. This grid is where that gets
 * fixed, by the person who actually knows who is who.
 */
const CONTACT_ROLE_LABELS = {
  site: 'Site contact',
  accounts: 'Accounts payable',
  sustainability: 'Sustainability / ESG',
} as const;

export function PortalAccountPage() {
  const { data: account, error, isPending, refetch } = usePortalAccount();

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

  if (isPending || !account) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-7 w-48" />
        <Card className="p-5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-4 h-48 w-full" />
        </Card>
      </div>
    );
  }

  return <AccountSettings key={account.accountId} account={account} />;
}

function AccountSettings({ account }: { account: PortalAccount }) {
  const toast = useToast();
  const update = usePortalUpdateAccount();

  const [preferredWindow, setPreferredWindow] = useState(account.preferredPickupWindow ?? '');
  const [approveNew, setApproveNew] = useState(account.approveNewSupervisors);
  const [channels, setChannels] = useState(
    () =>
      new Map(
        account.contacts.map((contact) => [
          contact.id,
          { notifyBySms: contact.notifyBySms, notifyByEmail: contact.notifyByEmail },
        ]),
      ),
  );

  const dirty =
    preferredWindow !== (account.preferredPickupWindow ?? '') ||
    approveNew !== account.approveNewSupervisors ||
    account.contacts.some((contact) => {
      const current = channels.get(contact.id);
      return (
        current !== undefined &&
        (current.notifyBySms !== contact.notifyBySms ||
          current.notifyByEmail !== contact.notifyByEmail)
      );
    });

  const setChannel = (id: string, key: 'notifyBySms' | 'notifyByEmail', value: boolean) => {
    setChannels((current) => {
      const next = new Map(current);
      const existing = next.get(id) ?? { notifyBySms: false, notifyByEmail: false };
      next.set(id, { ...existing, [key]: value });
      return next;
    });
  };

  const save = async () => {
    try {
      await update.mutateAsync({
        preferredPickupWindow: preferredWindow,
        approveNewSupervisors: approveNew,
        contacts: account.contacts.map((contact) => ({
          id: contact.id,
          notifyBySms: channels.get(contact.id)?.notifyBySms ?? contact.notifyBySms,
          notifyByEmail: channels.get(contact.id)?.notifyByEmail ?? contact.notifyByEmail,
        })),
      });
      toast.success('Preferences saved', 'Notifications will follow these settings from now on.');
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-display text-xl font-semibold tracking-tight">Account</h1>
        <p className="text-sm text-muted-foreground">
          Who we contact, when we prefer to collect, and how new supervisors get access.
        </p>
      </header>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {/* ── M8.4 · per-contact, per-channel preferences ───────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Who we contact</CardTitle>
              <p className="text-xs text-muted-foreground">
                Different people need different messages. Invoices go to accounts, diversion data to
                sustainability, pickup updates to site.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {account.contacts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No contacts on file. Call the office on 1300 395 438 to add one.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {account.contacts.map((contact) => {
                    const current = channels.get(contact.id) ?? {
                      notifyBySms: contact.notifyBySms,
                      notifyByEmail: contact.notifyByEmail,
                    };

                    return (
                      <li
                        key={contact.id}
                        className="flex flex-wrap items-start justify-between gap-4 py-3 first:pt-0 last:pb-0"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{contact.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {CONTACT_ROLE_LABELS[contact.role]}
                          </p>
                          <div className="mt-1 space-y-0.5">
                            {contact.email !== null && (
                              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <MailIcon aria-hidden className="size-3 shrink-0" />
                                <span className="truncate">{contact.email}</span>
                              </p>
                            )}
                            {contact.mobile !== null && (
                              <p className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
                                <PhoneIcon aria-hidden className="size-3 shrink-0" />
                                {formatMobile(contact.mobile)}
                              </p>
                            )}
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-4">
                          {/* A channel with no address behind it is disabled and
                              says why — a checkbox that silently does nothing is
                              worse than one that is visibly unavailable. */}
                          <div className="flex items-center gap-2">
                            <Checkbox
                              id={`sms-${contact.id}`}
                              checked={current.notifyBySms}
                              disabled={contact.mobile === null}
                              onChange={(event) => {
                                setChannel(contact.id, 'notifyBySms', event.target.checked);
                              }}
                            />
                            <Label
                              htmlFor={`sms-${contact.id}`}
                              className="text-xs font-normal text-muted-foreground"
                            >
                              {contact.mobile === null ? 'No mobile' : 'Text'}
                            </Label>
                          </div>
                          <div className="flex items-center gap-2">
                            <Checkbox
                              id={`email-${contact.id}`}
                              checked={current.notifyByEmail}
                              disabled={contact.email === null}
                              onChange={(event) => {
                                setChannel(contact.id, 'notifyByEmail', event.target.checked);
                              }}
                            />
                            <Label
                              htmlFor={`email-${contact.id}`}
                              className="text-xs font-normal text-muted-foreground"
                            >
                              {contact.email === null ? 'No email' : 'Email'}
                            </Label>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Collection preferences</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field
                id="account-window"
                label="Preferred pickup window"
                hint="Applies across your sites. A site can override it with its own window."
              >
                {(control) => (
                  <Input
                    {...control}
                    value={preferredWindow}
                    placeholder="Weekdays 7am–2pm"
                    onChange={(event) => {
                      setPreferredWindow(event.target.value);
                    }}
                  />
                )}
              </Field>
            </CardContent>
          </Card>

          {/* ── B.2 — the safety valve, configurable per account ──────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">New supervisor access</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Approve people who join with our code</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    On — someone using your customer code waits for your approval before they can
                    book. Off — they get access straight away, which suits a small team where
                    everyone is known.
                  </p>
                </div>
                <Switch
                  checked={approveNew}
                  onCheckedChange={setApproveNew}
                  aria-label="Require approval for people joining with the customer code"
                />
              </div>
            </CardContent>
          </Card>

          <div className="sticky bottom-20 z-10 flex flex-wrap items-center justify-end gap-3 rounded-xl border border-border bg-card/95 p-3 backdrop-blur md:static md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none">
            {dirty && (
              <span className="mr-auto text-xs text-muted-foreground">Unsaved changes</span>
            )}
            <Button disabled={!dirty || update.isPending} onClick={() => void save()}>
              {update.isPending && <Spinner label="Saving" />}
              <SaveIcon aria-hidden />
              Save preferences
            </Button>
          </div>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Your account</CardTitle>
              <p className="text-xs text-muted-foreground">
                Set when your account was opened. Call us to change any of it.
              </p>
            </CardHeader>
            <CardContent>
              <DetailList
                columns={1}
                items={[
                  { label: 'Company', value: account.name },
                  {
                    label: 'Customer code',
                    value: <span className="font-mono">{account.customerCode}</span>,
                  },
                  { label: 'ABN', value: account.abn || '—' },
                  { label: 'Payment terms', value: `${String(account.paymentTermsDays)} days` },
                  { label: 'Purchase orders', value: PO_POLICY_LABELS[account.poPolicy] },
                  { label: 'We record', value: CAPTURE_MODE_LABELS[account.captureMode] },
                  { label: 'Service area', value: ZONE_LABELS[account.primaryZone] },
                ]}
              />
              <p className="mt-3">
                <Badge variant="outline">Read-only</Badge>
              </p>
            </CardContent>
          </Card>

          <Alert variant="info" title="Need something changed?">
            Payment terms, rates and purchase-order rules are set with your account manager. Call
            the office on{' '}
            <a href="tel:1300395438" className="font-medium underline underline-offset-4">
              1300 395 438
            </a>
            .
          </Alert>
        </div>
      </div>
    </div>
  );
}
