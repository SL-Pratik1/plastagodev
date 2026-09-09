import {
  BRAND_LABELS,
  NOTIFICATION_EVENT_LABELS,
  RATE_CARD_LABELS,
  ROLE_LABELS,
  ROLES,
  type Integration,
  type NotificationEvent,
  type Settings,
} from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  ErrorState,
  Field,
  Input,
  Skeleton,
  Spinner,
  Switch,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTrigger,
  Textarea,
  useToast,
} from '@plastago/ui';
import { CheckIcon, ChevronDownIcon, PlugIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { DetailList } from '@/components/detail-list';
import { PageHeader } from '@/components/page-header';
import { UnsavedBar } from '@/components/unsaved-bar';
import { CAPABILITY_GROUPS, ROLE_CAPABILITIES, can } from '@/features/auth/permissions';
import {
  useSaveCredentialTypes,
  useSaveInvoicingSettings,
  useSaveNotificationSettings,
  useSettings,
  useTestIntegration,
} from '@/features/settings/queries';
import { describeError } from '@/lib/error-message';
import { formatMoney, formatRelative } from '@/lib/format';
import { useUnsavedChanges } from '@/lib/use-unsaved-changes';

const TABS = ['roles', 'notifications', 'pricing', 'invoicing', 'integrations'] as const;
type TabKey = (typeof TABS)[number];

/** The tab shown when the URL carries no `?tab=`, and the one it omits. */
const DEFAULT_TAB: TabKey = 'roles';

/**
 * Settings (W3), plus brands (M1.1), rate cards (M6), invoice branding (M7.5)
 * and integrations (W7).
 *
 * ── Editable versus stated ─────────────────────────────────────────────────
 * Several things that belong on a settings screen are not settings, and a text
 * box around them would be a lie:
 *
 *  • **Rate cards are effective-dated** (M6.2): changing a rate means issuing a
 *    new schedule, never overwriting the old one, because pricing a job uses the
 *    rates in force on that job's date. Editing them here would silently reprice
 *    history — and pricing correctness is the highest-rated risk in the project.
 *
 * ── There is no General tab ───────────────────────────────────────────────
 * It held three cards and only one control. Timezone, data residency, the
 * retention floor and the two number sequences were read-only facts the office
 * never has to look up, and the zones card duplicated Pricing. That left the
 * SLA with a tab to itself, which the client did not want.
 *
 * ⚠️ So the SLA is settable by seed or migration only — the `general` block and
 * its route are gone from the contract entirely (see the note in
 * `@plastago/shared`'s settings schema). The VALUE is still live: it is what
 * every job's target date is computed from, read through
 * `settingsRepository.slaBusinessDays()`. Re-homing it on another tab means
 * adding a route back, not just a field.
 *
 * ── The invoice-template trap ─────────────────────────────────────────────
 * Branding and content control are in scope: logo, colours, company details,
 * terms, bank details, footer, visible columns. Layout authoring is not — there
 * is deliberately no concept of a band, expression or drag-and-drop canvas
 * anywhere on this screen. That absence is the design.
 */
export function AdminSettingsPage() {
  const [params, setParams] = useSearchParams();
  const { data, error, isPending, refetch } = useSettings();

  const rawTab = params.get('tab');
  const tab: TabKey = (TABS as readonly string[]).includes(rawTab ?? '')
    ? (rawTab as TabKey)
    : DEFAULT_TAB;

  const setTab = (next: string) => {
    setParams(
      (current) => {
        const nextParams = new URLSearchParams(current);
        if (next === DEFAULT_TAB) nextParams.delete('tab');
        else nextParams.set('tab', next);
        return nextParams;
      },
      { replace: true },
    );
  };

  if (error) {
    const described = describeError(error);
    return (
      <div className="space-y-6">
        <PageHeader title="Settings" />
        <Card>
          <ErrorState
            title={described.title}
            description={described.detail}
            onRetry={() => void refetch()}
          />
        </Card>
      </div>
    );
  }

  if (isPending || !data) {
    return (
      <div className="space-y-6">
        <PageHeader title="Settings" />
        <Card className="p-5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-4 h-48 w-full" />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="The values the whole platform reads, the brands it trades under, and the six systems it talks to."
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList label="Settings sections">
          <TabsTrigger value="roles">Users & roles</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="pricing">Pricing</TabsTrigger>
          <TabsTrigger value="invoicing">Invoicing</TabsTrigger>
          <TabsTrigger value="integrations" badge={data.integrations.length}>
            Integrations
          </TabsTrigger>
        </TabsList>

        {/*
          Each section is keyed on its own saved slice, so a successful save
          remounts it and the form re-initialises from the new values. That is
          React's documented way to reset state when data changes — the
          alternative, an effect that calls setState, cascades a render and was
          what the linter caught here.
        */}
        <TabsPanel value="roles">
          <RolesSection key={JSON.stringify(data.credentialTypes)} settings={data} />
        </TabsPanel>
        <TabsPanel value="notifications">
          <NotificationsSection key={JSON.stringify(data.notifications)} settings={data} />
        </TabsPanel>
        <TabsPanel value="pricing">
          <PricingSection settings={data} />
        </TabsPanel>
        <TabsPanel value="invoicing">
          <InvoicingSection key={JSON.stringify(data.invoicing)} settings={data} />
        </TabsPanel>
        <TabsPanel value="integrations">
          <IntegrationsSection settings={data} />
        </TabsPanel>
      </Tabs>
    </div>
  );
}

/* ── Users & roles ───────────────────────────────────────────────────────── */

function RolesSection({ settings }: { settings: Settings }) {
  const toast = useToast();
  const save = useSaveCredentialTypes();
  const [types, setTypes] = useState(settings.credentialTypes);

  /* Groups start open; the portal block is the one an office admin rarely needs. */
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());

  const dirty = JSON.stringify(types) !== JSON.stringify(settings.credentialTypes);
  useUnsavedChanges(dirty);

  const submit = async () => {
    try {
      await save.mutateAsync(types);
      toast.success('Credential types updated');
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Roles and permissions</CardTitle>
          <CardDescription>
            Access is granted to a role, never to an individual — that is what makes it auditable.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/*
            Read-only by design, and deliberately NOT checkboxes.

            A checkbox is a promise that clicking it changes something. This
            matrix is compiled into the build — the row a capability sits on is
            reviewed in a pull request, not toggled at 6pm on a Friday — so a
            checkbox here would be a control that silently does nothing, which
            is worse than the bare count it replaced.

            The count alone was the actual defect: "Operations — 18" cannot
            answer the only question this card exists for, which is *why can the
            allocator not see prices*. Reading down the "See prices" row answers
            it in about two seconds.
          */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <caption className="sr-only">
                Capabilities by role. A tick means the role holds that capability; a dash means it
                does not.
              </caption>
              <thead>
                <tr className="border-b border-border">
                  <th
                    scope="col"
                    className="w-[17rem] py-2 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                  >
                    Capability
                  </th>
                  {ROLES.map((role) => (
                    <th
                      key={role}
                      scope="col"
                      className="px-1 py-2 align-bottom text-center text-xs font-semibold text-muted-foreground"
                    >
                      {ROLE_LABELS[role]}
                    </th>
                  ))}
                </tr>
              </thead>
              {CAPABILITY_GROUPS.map((group) => {
                const collapsed = collapsedGroups.has(group.title);
                return (
                  <tbody key={group.title} className="border-b border-border last:border-b-0">
                    <tr>
                      <th
                        scope="colgroup"
                        colSpan={ROLES.length + 1}
                        className="bg-muted/40 px-0 py-0 text-left"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            const next = new Set(collapsedGroups);
                            if (collapsed) next.delete(group.title);
                            else next.add(group.title);
                            setCollapsedGroups(next);
                          }}
                          aria-expanded={!collapsed}
                          className="focus-ring flex w-full items-center gap-2 px-2 py-2 text-left"
                        >
                          <ChevronDownIcon
                            className={`size-4 shrink-0 text-muted-foreground transition-transform ${
                              collapsed ? '-rotate-90' : ''
                            }`}
                            aria-hidden
                          />
                          <span className="text-sm font-semibold">{group.title}</span>
                          <span className="min-w-0 flex-1 truncate text-xs font-normal text-muted-foreground">
                            {group.note}
                          </span>
                        </button>
                      </th>
                    </tr>

                    {!collapsed &&
                      group.capabilities.map(({ capability, label }) => (
                        <tr key={capability} className="border-t border-border/60">
                          <th
                            scope="row"
                            className="py-2 pr-3 text-left font-normal"
                            title={capability}
                          >
                            {label}
                          </th>
                          {ROLES.map((role) => {
                            const held = can(role, capability);
                            return (
                              <td key={role} className="px-1 py-2 text-center">
                                <span
                                  className={
                                    held ? 'font-medium text-primary' : 'text-muted-foreground/40'
                                  }
                                >
                                  {held ? '✓' : '—'}
                                </span>
                                <span className="sr-only">
                                  {ROLE_LABELS[role]}: {held ? 'yes' : 'no'}
                                </span>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                  </tbody>
                );
              })}
              <tfoot>
                <tr className="border-t-2 border-border">
                  <th scope="row" className="py-2 text-left text-xs font-semibold uppercase">
                    Total capabilities
                  </th>
                  {ROLES.map((role) => (
                    <td
                      key={role}
                      className="px-1 py-2 text-center text-sm font-medium tabular-nums"
                    >
                      {ROLE_CAPABILITIES[role].length}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>

          <Alert variant="neutral" title="Mirrors their existing security groups">
            The seven roles match the groups they already use, so nothing has to be re-learned. This
            table is a reference, not a control — the rows are fixed in the build so that a change
            to what a role may reach is reviewed rather than clicked. To change what one person can
            reach, change their role on{' '}
            <Link
              to="/admin/users"
              className="focus-ring rounded text-primary underline underline-offset-4"
            >
              Users
            </Link>
            .
          </Alert>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Driver credential types</CardTitle>
          <CardDescription>
            Define the type once and set its reminder lead time; it then applies to every driver
            profile.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ul className="divide-y divide-border">
            {types.map((type, index) => (
              <li key={type.type} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1 text-sm font-medium">{type.label}</span>

                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  Remind
                  <Input
                    type="number"
                    min={1}
                    max={180}
                    value={type.reminderLeadDays}
                    onChange={(event) => {
                      const next = [...types];
                      next[index] = { ...type, reminderLeadDays: Number(event.target.value) };
                      setTypes(next);
                    }}
                    className="w-20"
                    aria-label={`Reminder lead days for ${type.label}`}
                  />
                  days before
                </label>

                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={type.requiredForDrivers}
                    onChange={() => {
                      const next = [...types];
                      next[index] = { ...type, requiredForDrivers: !type.requiredForDrivers };
                      setTypes(next);
                    }}
                  />
                  Required
                </label>
              </li>
            ))}
          </ul>

          <p className="text-xs text-muted-foreground">
            Chain of Responsibility under the Heavy Vehicle National Law makes licence currency an
            operator obligation, not just the driver’s — which is why the reminder is the feature.
          </p>
        </CardContent>
      </Card>

      <UnsavedBar
        visible={dirty}
        pending={save.isPending}
        onSave={() => void submit()}
        onDiscard={() => {
          setTypes(settings.credentialTypes);
        }}
      />
    </div>
  );
}

/* ── Notifications ───────────────────────────────────────────────────────── */

function NotificationsSection({ settings }: { settings: Settings }) {
  const toast = useToast();
  const save = useSaveNotificationSettings();
  const [draft, setDraft] = useState(settings.notifications);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.notifications);
  useUnsavedChanges(dirty);

  const setRule = (event: NotificationEvent, patch: Partial<(typeof draft.rules)[number]>) => {
    setDraft({
      ...draft,
      rules: draft.rules.map((rule) => (rule.event === event ? { ...rule, ...patch } : rule)),
    });
  };

  const submit = async () => {
    try {
      await save.mutateAsync(draft);
      toast.success('Notification settings saved');
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Customer notifications</CardTitle>
          <CardDescription>Which events reach the customer, and on which channel.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Notification events and channels</caption>
              <thead>
                <tr className="border-b border-border">
                  <th
                    scope="col"
                    className="py-2 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                  >
                    Event
                  </th>
                  <th
                    scope="col"
                    className="py-2 text-center text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                  >
                    SMS
                  </th>
                  <th
                    scope="col"
                    className="py-2 text-center text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                  >
                    Email
                  </th>
                  <th
                    scope="col"
                    className="py-2 text-center text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                  >
                    Photos
                  </th>
                </tr>
              </thead>
              <tbody>
                {draft.rules.map((rule) => (
                  <tr key={rule.event} className="border-b border-border">
                    <td className="py-2.5">{NOTIFICATION_EVENT_LABELS[rule.event]}</td>
                    <td className="py-2.5 text-center">
                      <Checkbox
                        checked={rule.sms}
                        onChange={() => {
                          setRule(rule.event, { sms: !rule.sms });
                        }}
                        aria-label={`SMS for ${NOTIFICATION_EVENT_LABELS[rule.event]}`}
                      />
                    </td>
                    <td className="py-2.5 text-center">
                      <Checkbox
                        checked={rule.email}
                        onChange={() => {
                          setRule(rule.event, { email: !rule.email });
                        }}
                        aria-label={`Email for ${NOTIFICATION_EVENT_LABELS[rule.event]}`}
                      />
                    </td>
                    <td className="py-2.5 text-center">
                      <Checkbox
                        checked={rule.includePhotos}
                        disabled={!rule.email}
                        onChange={() => {
                          setRule(rule.event, { includePhotos: !rule.includePhotos });
                        }}
                        aria-label={`Attach photos for ${NOTIFICATION_EVENT_LABELS[rule.event]}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-muted-foreground">
            Photos ride on the completion email — a promise their booking form already makes: “job
            alerts and photos will be sent to this email address”. Today that is a link on a PDF.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Upcoming-job reminder</CardTitle>
          <CardDescription>
            The reminder that asks a site whether the job is actually ready.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="sm:max-w-xs">
            <Field
              id="reminder-lead"
              label="Days before the ready date"
              required
              hint="Between 1 and 7."
            >
              {(aria) => (
                <Input
                  {...aria}
                  type="number"
                  min={1}
                  max={7}
                  value={draft.reminderLeadDays}
                  onChange={(event) => {
                    setDraft({ ...draft, reminderLeadDays: Number(event.target.value) });
                  }}
                />
              )}
            </Field>
          </div>

          <div className="flex items-start gap-3">
            <Switch
              checked={draft.reminderIncludeRescheduleLink}
              onCheckedChange={(checked) => {
                setDraft({ ...draft, reminderIncludeRescheduleLink: checked });
              }}
              id="reschedule-link"
              aria-label="Include a reschedule link"
            />
            <label htmlFor="reschedule-link" className="text-sm">
              Include a tap-through reschedule link
              <span className="block text-xs text-muted-foreground">
                “Not ready? Pick a new date →”. A link rather than SMS-reply parsing: cheaper,
                unambiguous, fully audited, and identical for email and SMS.
              </span>
            </label>
          </div>

          <Alert variant="info" title="If they do not reply, go anyway">
            That is the stated rule. If they reply not-ready they supply a new date and the job
            reschedules — which attacks futile pickups directly, the most expensive failure mode in
            the business.
          </Alert>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Internal queue digest</CardTitle>
          <CardDescription>The daily email that stops a queue being forgotten.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-3">
            <Switch
              checked={draft.queueDigestEnabled}
              onCheckedChange={(checked) => {
                setDraft({ ...draft, queueDigestEnabled: checked });
              }}
              id="queue-digest"
              aria-label="Send the daily queue digest"
            />
            <label htmlFor="queue-digest" className="text-sm">
              Send a daily digest of the futile, approvals and awaiting-PO queues
            </label>
          </div>

          {draft.queueDigestEnabled && (
            <div className="sm:max-w-xs">
              <Field id="digest-hour" label="Send at" hint="24-hour, Australia/Sydney.">
                {(aria) => (
                  <Input
                    {...aria}
                    type="number"
                    min={0}
                    max={23}
                    value={draft.queueDigestHour}
                    onChange={(event) => {
                      setDraft({ ...draft, queueDigestHour: Number(event.target.value) });
                    }}
                  />
                )}
              </Field>
            </div>
          )}

          <Alert variant="warning" title="Why this exists">
            One futile pickup has sat unactioned in the current system since August 2025 — a year,
            at $120, because nothing ever chased it. The system has to chase.
          </Alert>
        </CardContent>
      </Card>

      <UnsavedBar
        visible={dirty}
        pending={save.isPending}
        onSave={() => void submit()}
        onDiscard={() => {
          setDraft(settings.notifications);
        }}
      />
    </div>
  );
}

/* ── Pricing ─────────────────────────────────────────────────────────────── */

function PricingSection({ settings }: { settings: Settings }) {
  return (
    <div className="space-y-4">
      {/*
        Read-only, and that is a deliberate safety decision rather than an
        omission. Rates are effective-dated: pricing a job always uses the rates
        in force on that job's date, so editing a rate in place would silently
        reprice history. Invoice correctness is the highest-rated risk in the
        project, so issuing a new schedule is a guarded workflow, not a text box.
      */}
      <Alert variant="warning" title="Rates are effective-dated, so they are not edited in place">
        Pricing a job always uses the rates in force on that job’s date. Changing a rate means
        issuing a new schedule with its own start date — reissuing or crediting a March invoice has
        to use March’s rates. Editing here would silently reprice history.
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Rate cards</CardTitle>
          <CardDescription>Resolution order is named card → tier → default.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {settings.pricing.rateCards.map((card) => (
              <li key={card.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{RATE_CARD_LABELS[card.id]}</span>
                  <span className="block text-xs text-muted-foreground tabular-nums">
                    Effective {card.effectiveFrom} → {card.effectiveTo}
                  </span>
                </span>
                <Badge variant="secondary">
                  {card.accountCount} account{card.accountCount === 1 ? '' : 's'}
                </Badge>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Additional services</CardTitle>
          <CardDescription>All nine, fixed and percentage.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Additional service charges</caption>
              <thead>
                <tr className="border-b border-border">
                  {['Charge', 'Rate', 'Raised by', 'Approval'].map((heading, index) => (
                    <th
                      key={heading}
                      scope="col"
                      className={`py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase ${index === 1 ? 'text-right' : 'text-left'}`}
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {settings.pricing.additionalServices.map((service) => (
                  <tr key={service.code} className="border-b border-border">
                    <td className="py-2.5">{service.label}</td>
                    <td className="py-2.5 text-right tabular-nums">
                      {service.kind === 'percentage'
                        ? `${service.value}%`
                        : formatMoney(service.value)}
                    </td>
                    <td className="py-2.5">
                      <Badge variant="outline">
                        {service.systemGenerated
                          ? 'System'
                          : service.driverRaisable
                            ? 'Driver'
                            : 'Office'}
                      </Badge>
                    </td>
                    <td className="py-2.5">
                      {service.requiresApproval ? (
                        <Badge variant="warning">Requires approval</Badge>
                      ) : (
                        <span className="text-muted-foreground">Automatic</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-muted-foreground">
            Extra load time is system-generated from on-site duration and cannot be raised by a
            driver — which is why the approvals queue shows it as “Created By: System”. Its
            free-time threshold is still an open question with the client.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Margin assumption</CardTitle>
        </CardHeader>
        <CardContent>
          <DetailList
            columns={2}
            items={[
              {
                label: 'Assumed cost per job',
                value: formatMoney(settings.pricing.assumedCostPerJob),
              },
              { label: 'Used by', value: 'Job margin view and the financial summary report' },
            ]}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            Reproduces the flat per-job cost the current system applies. Real per-vehicle cost is
            the improvement to make once the vehicle expense log has history.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/* ── Invoicing ───────────────────────────────────────────────────────────── */

function InvoicingSection({ settings }: { settings: Settings }) {
  const toast = useToast();
  const save = useSaveInvoicingSettings();
  const [draft, setDraft] = useState(settings.invoicing);
  const [termsError, setTermsError] = useState<string | null>(null);
  const [prefixError, setPrefixError] = useState<string | null>(null);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.invoicing);
  useUnsavedChanges(dirty);

  const submit = async () => {
    if (draft.defaultPaymentTermsDays < 0 || draft.defaultPaymentTermsDays > 90) {
      setTermsError('Enter between 0 and 90 days');
      return;
    }
    setTermsError(null);

    // Letters, digits and hyphens only. A prefix with a slash or a space in it
    // ends up in Xero and in a builder's accounts system, where it is somebody
    // else's problem to unpick.
    if (!/^[A-Za-z0-9-]*$/.test(draft.invoiceNumberPrefix.trim())) {
      setPrefixError('Letters, digits and hyphens only');
      return;
    }
    setPrefixError(null);

    try {
      await save.mutateAsync(draft);
      toast.success('Invoicing settings saved');
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Workflow</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-3">
            <Switch
              checked={draft.splitAdditionalCharges}
              onCheckedChange={(checked) => {
                setDraft({ ...draft, splitAdditionalCharges: checked });
              }}
              id="split-charges"
              aria-label="Invoice additional charges separately"
            />
            <label htmlFor="split-charges" className="text-sm">
              Invoice additional charges separately
              <span className="block text-xs text-muted-foreground">
                The base invoice goes out on completion against the original PO; additional charges
                follow once their own PO arrives, so cash for the job is never delayed.
              </span>
            </label>
          </div>

          {/*
            Matt, 7:07: *"customisable invoice number prefixes… select the prefix
            like, for example, if we had PGA, it would put PGA dash in front of
            the invoice number."*

            Presentation only. The stored number is a bare sequence Xero matches
            on, so changing this renumbers nothing.
          */}
          <div className="sm:max-w-xs">
            <Field
              id="invoice-prefix"
              label="Invoice number prefix"
              error={prefixError ?? undefined}
              hint={
                draft.invoiceNumberPrefix.trim() === ''
                  ? 'Leave blank for plain numbers, e.g. #104312.'
                  : `Invoices will read ${draft.invoiceNumberPrefix.trim()}-104312.`
              }
            >
              {(aria) => (
                <Input
                  {...aria}
                  value={draft.invoiceNumberPrefix}
                  maxLength={8}
                  placeholder="PGA"
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setDraft({ ...draft, invoiceNumberPrefix: event.target.value });
                    setPrefixError(null);
                  }}
                />
              )}
            </Field>
          </div>

          <div className="sm:max-w-xs">
            <Field
              id="payment-terms"
              label="Default payment terms"
              required
              error={termsError ?? undefined}
              hint="Days. Their standard is 7."
            >
              {(aria) => (
                <Input
                  {...aria}
                  type="number"
                  min={0}
                  max={90}
                  value={draft.defaultPaymentTermsDays}
                  onChange={(event) => {
                    setDraft({ ...draft, defaultPaymentTermsDays: Number(event.target.value) });
                  }}
                />
              )}
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Branding and content</CardTitle>
          <CardDescription>
            What appears on the invoice PDF. Layout authoring is a separate decision.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field id="footer-text" label="Footer text">
            {(aria) => (
              <Textarea
                {...aria}
                rows={2}
                value={draft.footerText}
                onChange={(event) => {
                  setDraft({ ...draft, footerText: event.target.value });
                }}
              />
            )}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="bank-bsb" label="BSB">
              {(aria) => (
                <Input
                  {...aria}
                  value={draft.bankBsb}
                  onChange={(event) => {
                    setDraft({ ...draft, bankBsb: event.target.value });
                  }}
                />
              )}
            </Field>
            <Field id="bank-account" label="Account number">
              {(aria) => (
                <Input
                  {...aria}
                  value={draft.bankAccount}
                  onChange={(event) => {
                    setDraft({ ...draft, bankAccount: event.target.value });
                  }}
                />
              )}
            </Field>
          </div>

          <div className="flex items-center gap-3">
            <Switch
              checked={draft.showGbcaBadge}
              onCheckedChange={(checked) => {
                setDraft({ ...draft, showGbcaBadge: checked });
              }}
              id="gbca-badge"
              aria-label="Show the GBCA member badge"
            />
            <label htmlFor="gbca-badge" className="text-sm">
              Show the GBCA member badge
            </label>
          </div>

          <Alert variant="neutral" title="Branding is in scope; layout authoring is not">
            Logo, colours, company details, terms, bank details, footer and visible columns are all
            editable. A drag-and-drop band designer is a product in its own right and the single
            biggest scope trap in this project.
          </Alert>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Templates</CardTitle>
          <CardDescription>
            Resolved per customer — the granular priority-and-filter model was explicitly not
            wanted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {settings.invoicing.templates.map((template) => (
              <li key={template.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1 text-sm font-medium">{template.name}</span>
                <Badge variant="outline">{BRAND_LABELS[template.brandId]}</Badge>
                <Badge variant="secondary">{template.showsWeight ? 'kg & m²' : 'm² only'}</Badge>
                <span className="text-xs text-muted-foreground">
                  {template.assignedAccountCount} assigned
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <UnsavedBar
        visible={dirty}
        pending={save.isPending}
        onSave={() => void submit()}
        onDiscard={() => {
          setDraft(settings.invoicing);
          setTermsError(null);
        }}
      />
    </div>
  );
}

/* ── Integrations ────────────────────────────────────────────────────────── */

function IntegrationsSection({ settings }: { settings: Settings }) {
  const toast = useToast();
  const test = useTestIntegration();
  const [testing, setTesting] = useState<string | null>(null);

  const run = async (integration: Integration) => {
    setTesting(integration.id);
    try {
      await test.mutateAsync(integration.id);
      toast.success(`${integration.name} responded`, 'Connection is working.');
    } catch (caught) {
      const described = describeError(caught);
      toast.error(`${integration.name} test failed`, described.detail ?? described.title);
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="space-y-4">
      <Alert variant="neutral" title="Credentials are never handled in the browser">
        Testing a connection asks the server to make one call and report back. Keys and tokens live
        on the API only.
      </Alert>

      <div className="grid gap-3 lg:grid-cols-2">
        {settings.integrations.map((integration) => (
          <Card key={integration.id}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <PlugIcon aria-hidden className="size-4 text-muted-foreground" />
                  {integration.name}
                </span>
                <Badge
                  variant={
                    integration.state === 'connected'
                      ? 'success'
                      : integration.state === 'error'
                        ? 'destructive'
                        : 'outline'
                  }
                >
                  {integration.state === 'connected'
                    ? 'Connected'
                    : integration.state === 'error'
                      ? 'Needs attention'
                      : 'Not configured'}
                </Badge>
              </CardTitle>
              <CardDescription>{integration.purpose}</CardDescription>
            </CardHeader>

            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Last successful call {formatRelative(integration.lastSuccessAt)}
              </p>

              {integration.detail && (
                <p className="text-sm text-muted-foreground">{integration.detail}</p>
              )}

              {/* Stated caveats belong on screen, not in a document nobody reopens. */}
              {integration.caveat && (
                <Alert variant="warning" title="Worth knowing">
                  {integration.caveat}
                </Alert>
              )}

              <Button
                variant="outline"
                size="sm"
                onClick={() => void run(integration)}
                disabled={testing !== null}
              >
                {testing === integration.id ? (
                  <Spinner className="text-current" />
                ) : integration.state === 'connected' ? (
                  <CheckIcon aria-hidden />
                ) : (
                  <TriangleAlertIcon aria-hidden />
                )}
                Test connection
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Two integrations were dropped by the client: card payments, because payment is 7-day EFT
        against a purchase order, and the old public form, because two intake paths mean two sources
        of truth.
      </p>
    </div>
  );
}
