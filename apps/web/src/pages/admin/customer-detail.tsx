import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_DESCRIPTIONS,
  ACCOUNT_TYPE_LABELS,
  BRAND_LABELS,
  CAPTURE_MODE_LABELS,
  CONTACT_ROLE_LABELS,
  PO_POLICY_LABELS,
  type Account,
  type AccountType,
  type InvoiceListItem,
  type InvoiceTemplate,
  type JobListItem,
} from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  ErrorState,
  Field,
  Pagination,
  Select,
  Spinner,
  Skeleton,
  Switch,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTrigger,
  useToast,
} from '@plastago/ui';
import {
  BriefcaseIcon,
  MailIcon,
  PencilIcon,
  ReceiptIcon,
  RouteIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { DetailList } from '@/components/detail-list';
import { AccountTypeBadge, InvoiceStatusBadge, JobStatusBadge } from '@/components/domain-badges';
import { PageHeader } from '@/components/page-header';
import { CustomerEditDialog } from '@/features/customers/components/customer-edit-dialog';
import {
  useCustomer,
  useCustomerInvoices,
  useCustomerJobs,
  useSetAccountType,
  useSetInvoiceTemplate,
  useSetRiskAssessmentRequired,
} from '@/features/customers/queries';
import { useRateCardOptions } from '@/features/lookups/queries';
import { useSettings } from '@/features/settings/queries';
import { describeError } from '@/lib/error-message';
import {
  formatDate,
  formatDateTime,
  formatInvoiceNumber,
  formatMobile,
  formatMoney,
} from '@/lib/format';

const TABS = ['overview', 'sites', 'contacts', 'jobs', 'invoices', 'preferences'] as const;
type TabKey = (typeof TABS)[number];

/**
 * One account (M2.8).
 *
 * ── Why six tabs and not one long page ─────────────────────────────────────
 * The six answer six different questions, asked by different people at
 * different times: what are their terms, where do we go, who do we call, what
 * have we done, what do they owe, what do they want. A single scrolling page
 * makes every one of those a hunt.
 *
 * Each tab's list is its own query, `enabled` only when open, with its own
 * URL-namespaced pagination — so the jobs tab does not load for someone who came
 * to check a phone number, and the tab survives a refresh or a shared link.
 */
/**
 * The registered address as one line, or null when there is nothing to show.
 *
 * Built from the parts that are present rather than a fixed template: an
 * account whose suburb is known but whose street is not should read
 * "Wollongong 2500", not ", Wollongong 2500".
 */
function formatAddress(account: Account): string | null {
  const parts = [account.addressLine, [account.suburb, account.postcode].filter(Boolean).join(' ')]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(', ') : null;
}

export function AdminCustomerDetailPage() {
  const { customerId } = useParams();
  const [params, setParams] = useSearchParams();

  const { data: account, error, isPending, refetch } = useCustomer(customerId);
  const settings = useSettings().data;
  const invoicePrefix = settings?.invoicing.invoiceNumberPrefix ?? '';
  /* M6.1 — a card's name is on the record, not derivable from its id any more. */
  const rateCardLabels = new Map(
    (useRateCardOptions().data ?? []).map((card) => [card.value, card.label]),
  );

  /*
   * M7.5 — the NAME of the template this account names, or null.
   *
   * Resolved from the settings list rather than stored on the account,
   * because a template can be renamed and the account only carries its id.
   * Null covers both "nothing chosen" and "the chosen one has since been
   * deleted" — and both render the same way, as the brand fallback, which is
   * exactly what the server would do.
   */
  const templateName =
    account?.invoiceTemplateId == null
      ? null
      : (settings?.invoicing.templates.find((template) => template.id === account.invoiceTemplateId)
          ?.name ?? null);

  const rawTab = params.get('tab');
  const tab: TabKey = (TABS as readonly string[]).includes(rawTab ?? '')
    ? (rawTab as TabKey)
    : 'overview';

  const setTab = (next: string) => {
    setParams(
      (current) => {
        const nextParams = new URLSearchParams(current);
        if (next === 'overview') nextParams.delete('tab');
        else nextParams.set('tab', next);
        return nextParams;
      },
      { replace: true },
    );
  };

  const [editing, setEditing] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);

  const jobQuery = useListQuery({
    paramPrefix: 'jobs',
    filterKeys: ['status'],
    defaultPageSize: 10,
  });
  const invoiceQuery = useListQuery({
    paramPrefix: 'inv',
    filterKeys: ['status'],
    defaultPageSize: 10,
  });

  const jobs = useCustomerJobs(customerId, jobQuery.query, tab === 'jobs');
  const invoices = useCustomerInvoices(customerId, invoiceQuery.query, tab === 'invoices');

  const breadcrumbs = [{ label: 'Customers', to: '/admin/customers' }];

  if (error) {
    const described = describeError(error);
    return (
      <div className="space-y-6">
        <PageHeader title="Customer" breadcrumbs={breadcrumbs} />
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

  if (isPending || !account) {
    return (
      <div className="space-y-6">
        <PageHeader title="Loading…" breadcrumbs={breadcrumbs} />
        <Card className="p-5">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="mt-4 h-40 w-full" />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={account.name}
        breadcrumbs={breadcrumbs}
        description={`${account.code} · ${BRAND_LABELS[account.brandId]}`}
        badge={
          <Badge variant={account.status === 'active' ? 'success' : 'outline'}>
            {account.status === 'active' ? 'Active' : 'Inactive'}
          </Badge>
        }
        actions={
          <Button
            variant="outline"
            onClick={() => {
              setEditing(true);
            }}
          >
            <PencilIcon aria-hidden />
            Edit details
          </Button>
        }
      />

      <CustomerEditDialog
        account={account}
        open={editing}
        onClose={() => {
          setEditing(false);
        }}
      />

      <InvoiceTemplateDialog
        account={account}
        templates={settings?.invoicing.templates ?? []}
        open={templateOpen}
        onClose={() => {
          setTemplateOpen(false);
        }}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList label="Account sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="contacts" badge={account.contacts.length}>
            Contacts
          </TabsTrigger>
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="preferences">Preferences</TabsTrigger>
        </TabsList>

        {/* ── Overview ─────────────────────────────────────────────────── */}
        <TabsPanel value="overview">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Billing and terms</CardTitle>
              </CardHeader>
              <CardContent>
                <DetailList
                  columns={2}
                  items={[
                    {
                      // First, because it is what tells the reader whether the
                      // rest of this account has POs and supervisors at all.
                      label: 'Type',
                      value: (
                        <span className="flex flex-wrap items-center gap-2">
                          <AccountTypeBadge type={account.accountType} />
                          <span className="text-xs text-muted-foreground">
                            {ACCOUNT_TYPE_DESCRIPTIONS[account.accountType]}
                          </span>
                        </span>
                      ),
                      wide: true,
                    },
                    { label: 'ABN', value: account.abn },
                    {
                      /*
                       * ⚠️ Shown at last. The portal onboarding form has always
                       * written the trading name and the registered address, and
                       * no endpoint returned them — so a customer's own details
                       * were stored where the office that invoices them could not
                       * look, and could not be corrected by anybody.
                       */
                      label: 'Trading name',
                      value: account.tradingName ?? (
                        <span className="text-muted-foreground">Trades under its legal name</span>
                      ),
                    },
                    {
                      label: 'Registered address',
                      value: formatAddress(account) ?? (
                        <span className="text-muted-foreground">Not recorded</span>
                      ),
                      wide: true,
                    },
                    { label: 'Payment terms', value: `${String(account.paymentTermsDays)} days` },
                    /*
                     * The card's NAME, from the loaded lookup, falling back to
                     * its id. The fallback matters on a detail page: a retired
                     * card still priced this account's history, and `tier-2`
                     * tells the office something a blank row does not.
                     */
                    {
                      label: 'Rate card',
                      value: rateCardLabels.get(account.rateCardId) ?? account.rateCardId,
                    },
                    {
                      /*
                       * M7.5 — which template this account's invoices print
                       * on. Null is the common case and is stated as a
                       * FALLBACK rather than as "none": the invoice still
                       * renders, on the brand's own template, and "not set"
                       * alone would read as broken.
                       */
                      label: 'Invoice template',
                      value: (
                        <span className="flex flex-wrap items-center gap-2">
                          {templateName ?? (
                            <span className="text-muted-foreground">
                              Follows the {BRAND_LABELS[account.brandId]} default
                            </span>
                          )}
                          {/*
                            ⚠️ The control this row was missing.

                            `invoiceTemplateId` was read at render time and shown
                            here, but no route and no control could SET it — so
                            every account fell back to the first template for its
                            brand, and a second template was unreachable. The
                            Templates card could create configurations nothing
                            could ever use.
                          */}
                          <button
                            type="button"
                            onClick={() => {
                              setTemplateOpen(true);
                            }}
                            className="focus-ring rounded text-xs text-primary underline underline-offset-4"
                          >
                            Change
                          </button>
                        </span>
                      ),
                    },
                    { label: 'Primary zone', value: account.primaryZoneLabel },
                    { label: 'PO policy', value: PO_POLICY_LABELS[account.poPolicy] },
                    { label: 'Capture', value: CAPTURE_MODE_LABELS[account.captureMode] },
                    {
                      /*
                       * Certificates go somewhere different from invoices.
                       * Matt, 31:04 — for most builders it is a compliance or
                       * ESG mailbox with no connection to accounts payable.
                       */
                      label: 'Certificates emailed to',
                      value: account.certificateEmail ?? (
                        <span className="text-muted-foreground">
                          Not set — falls back to the accounts contact
                        </span>
                      ),
                    },
                    {
                      /*
                       * Whether the CUSTOMER has confirmed the details above, and
                       * when. A date rather than a tick: "they filled this in" and
                       * "what they filled in is still current" are the same
                       * question a year later, and only a date answers both.
                       */
                      label: 'Details confirmed by the customer',
                      value: account.detailsCompletedAt ? (
                        formatDateTime(account.detailsCompletedAt)
                      ) : (
                        <span className="text-muted-foreground">
                          Not yet — whatever is above was typed by the office
                        </span>
                      ),
                    },
                    { label: 'Notes', value: account.notes || '—', wide: true },
                  ]}
                />
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card className="p-4">
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Open jobs
                </p>
                <p className="mt-1 font-display text-2xl font-semibold tabular-nums">
                  {account.openJobCount}
                </p>
                <Link
                  to="?tab=jobs"
                  className="focus-ring mt-2 inline-block rounded text-xs font-medium text-primary underline-offset-4 hover:underline"
                >
                  View all jobs
                </Link>
              </Card>

              {account.poPolicy === 'required-before-invoice' && (
                <Alert variant="warning" title="PO required before invoicing">
                  Additional charges need a separate PO, so they are invoiced on their own once it
                  arrives — the base invoice is never held up waiting.
                </Alert>
              )}

              {account.captureMode === 'area-only' && (
                <Alert variant="info" title="m² only">
                  Drivers are not asked for a weight on this account’s jobs.
                </Alert>
              )}
            </div>
          </div>
        </TabsPanel>

        {/* ── Contacts ─────────────────────────────────────────────────── */}
        <TabsPanel value="contacts">
          <Card>
            <CardHeader>
              <CardTitle>Contacts and notification preferences</CardTitle>
            </CardHeader>
            <CardContent>
              {account.contacts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No contacts recorded. Jobs for this account are booked by the office.
                </p>
              ) : (
                <>
                  {/*
                    M8.4 — today there is exactly one email, the site contact, so
                    the AP person who needs the invoice and the sustainability
                    manager who needs the diversion data get nothing. Roles are
                    shown per contact for that reason.
                  */}
                  <ul className="divide-y divide-border">
                    {account.contacts.map((contact) => (
                      <li key={contact.id} className="flex flex-wrap items-center gap-3 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">{contact.name}</p>
                          <p className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                            {contact.email && (
                              <span className="flex items-center gap-1">
                                <MailIcon aria-hidden className="size-3" />
                                {contact.email}
                              </span>
                            )}
                            {contact.mobile && (
                              <span className="flex items-center gap-1">
                                <SmartphoneIcon aria-hidden className="size-3" />
                                {formatMobile(contact.mobile)}
                              </span>
                            )}
                          </p>
                        </div>
                        <Badge variant="secondary">{CONTACT_ROLE_LABELS[contact.role]}</Badge>
                        <span className="flex gap-1">
                          {contact.notifyByEmail && <Badge variant="outline">Email</Badge>}
                          {contact.notifyBySms && <Badge variant="outline">SMS</Badge>}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </CardContent>
          </Card>
        </TabsPanel>

        {/* ── Jobs ─────────────────────────────────────────────────────── */}
        <TabsPanel value="jobs">
          <Card className="overflow-hidden p-0">
            <DataTableToolbar
              controller={jobQuery}
              searchPlaceholder="Search job number or site…"
            />
            <DataTable
              caption={`Jobs for ${account.name}`}
              columns={ACCOUNT_JOB_COLUMNS}
              rows={jobs.data?.data ?? []}
              getRowId={(row) => row.id}
              isPending={jobs.isPending}
              isFetching={jobs.isFetching && !jobs.isPending}
              error={jobs.error}
              onRetry={() => void jobs.refetch()}
              sort={jobQuery.sort}
              onToggleSort={jobQuery.toggleSort}
              isFiltered={jobQuery.isFiltered}
              onClearFilters={jobQuery.clearFilters}
              rowHref={(row) => `/admin/jobs/${row.id}`}
              empty={{ icon: BriefcaseIcon, title: 'No jobs yet' }}
            />
            {jobs.data && (
              <Pagination
                page={jobs.data.meta.page}
                pageSize={jobs.data.meta.pageSize}
                total={jobs.data.meta.total}
                onPageChange={jobQuery.setPage}
                onPageSizeChange={jobQuery.setPageSize}
                pageSizeOptions={[5, 10, 15, 20]}
              />
            )}
          </Card>
        </TabsPanel>

        {/* ── Invoices ─────────────────────────────────────────────────── */}
        <TabsPanel value="invoices">
          <Card className="overflow-hidden p-0">
            <DataTableToolbar
              controller={invoiceQuery}
              searchPlaceholder="Search invoice or PO number…"
            />
            <DataTable
              caption={`Invoices for ${account.name}`}
              columns={invoiceColumns(invoicePrefix)}
              rows={invoices.data?.data ?? []}
              getRowId={(row) => row.id}
              isPending={invoices.isPending}
              isFetching={invoices.isFetching && !invoices.isPending}
              error={invoices.error}
              onRetry={() => void invoices.refetch()}
              sort={invoiceQuery.sort}
              onToggleSort={invoiceQuery.toggleSort}
              isFiltered={invoiceQuery.isFiltered}
              onClearFilters={invoiceQuery.clearFilters}
              empty={{ icon: ReceiptIcon, title: 'No invoices yet' }}
            />
            {invoices.data && (
              <Pagination
                page={invoices.data.meta.page}
                pageSize={invoices.data.meta.pageSize}
                total={invoices.data.meta.total}
                onPageChange={invoiceQuery.setPage}
                onPageSizeChange={invoiceQuery.setPageSize}
                pageSizeOptions={[5, 10, 15, 20]}
              />
            )}
          </Card>
        </TabsPanel>

        {/* ── Preferences ──────────────────────────────────────────────── */}
        <TabsPanel value="preferences">
          {/*
            M4.8b — the switch that decides what a DRIVER is made to do on site.

            First on the tab, above the read-only service preferences, because it
            is the only thing here that is both editable and a safety obligation.
            Everything below it is a commercial setting someone glances at.
          */}
          <RiskAssessmentCard account={account} />

          {/*
            The journey, changeable — see `AccountTypeCard`.

            Below site safety because it is a correction rather than a standing
            obligation: most accounts are set right at conversion and nobody
            comes back to this card. It sits on Preferences and not on Overview
            so the Overview stays a page you can read without changing anything.
          */}
          <AccountTypeCard account={account} />

          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Service preferences</CardTitle>
            </CardHeader>
            <CardContent>
              <DetailList
                columns={2}
                items={[
                  {
                    label: 'Preferred pickup window',
                    value: account.preferredPickupWindow ?? 'No preference recorded',
                  },
                  {
                    label: 'Capture configuration',
                    value: CAPTURE_MODE_LABELS[account.captureMode],
                  },
                  { label: 'PO policy', value: PO_POLICY_LABELS[account.poPolicy] },
                  { label: 'Payment terms', value: `${String(account.paymentTermsDays)} days` },
                ]}
              />
            </CardContent>
          </Card>
        </TabsPanel>
      </Tabs>
    </div>
  );
}

/**
 * M4.8b — the account's Site Risk Assessment rule.
 *
 * ── Why this is a switch and not a read-only row ──────────────────────────
 * Until now the requirement existed only as a flag baked into fixture data,
 * with no screen anywhere that could set it. That made a contractual obligation
 * of the CUSTOMER'S — Matt's words were "required by some clients" — into
 * something only a developer could change, which is the wrong owner entirely.
 *
 * ── Why the copy names the consequence ────────────────────────────────────
 * Turning this on adds a form a driver must complete standing at a fence,
 * before they may start, on every job for this account. That is a real cost to
 * someone who is not in the room, so the switch says so rather than reading as
 * a preference.
 */
function RiskAssessmentCard({ account }: { account: Account }) {
  const toast = useToast();
  const setRequired = useSetRiskAssessmentRequired(account.id);

  const toggle = async (next: boolean) => {
    try {
      await setRequired.mutateAsync(next);
      /*
       * ⚠️ The "off" message used to say "Sites with their own override are
       * unaffected". No such override exists — there is no Sites tab and no
       * per-site rule — so it promised something the product cannot do.
       */
      toast.success(
        next ? 'Risk assessment now required' : 'Risk assessment no longer required',
        next
          ? `Drivers must complete it at every ${account.name} site. Their open jobs are updated too.`
          : `Their open jobs are updated too. Finished jobs keep the rule they were done under.`,
      );
    } catch (error) {
      toast.error(describeError(error).title, describeError(error).detail);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Site safety</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 gap-3">
            <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground">
              <ShieldCheckIcon aria-hidden className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">Site Risk Assessment required</p>
              <p className="text-sm text-muted-foreground">
                {account.name} requires a written assessment before a driver may start. The form
                opens by itself when the driver taps Arrived, and the job cannot be completed until
                it is done.
              </p>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Changing this also updates their open jobs, including one a driver is on now.
                Finished jobs keep the rule they were done under.
              </p>
            </div>
          </div>

          <Switch
            checked={account.riskAssessmentRequired}
            disabled={setRequired.isPending}
            onCheckedChange={(next) => void toggle(next)}
            aria-label="Site Risk Assessment required"
          />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Builder or contractor — the account's journey (Matt, 21:55).
 *
 * ── Why this became editable ──────────────────────────────────────────────
 * The type was write-once at creation, and conversion from a lead did not even
 * ask — every converted account was a builder. So a contractor onboarded that
 * way was stuck with site supervisors they never use and a booking form that
 * omits the area and bag count, which are the only figures a contractor can
 * give us. The workaround was a second account on the same ABN, which splits
 * the customer's invoices and their history.
 *
 * ── Why the copy names what changes ───────────────────────────────────────
 * This is not a label. It changes the portal under a customer who is not in the
 * room: a menu item appears or vanishes, and their booking form gains or loses
 * two required fields. The card says which, so nobody flips it to correct a
 * badge.
 *
 * The server refuses builder → contractor while supervisors can still sign in,
 * and that refusal arrives here as the toast — the office cannot leave a
 * customer with logins nobody can manage.
 */
function AccountTypeCard({ account }: { account: Account }) {
  const toast = useToast();
  const setType = useSetAccountType(account.id);

  const change = async (next: AccountType) => {
    if (next === account.accountType) return;

    try {
      const updated = await setType.mutateAsync(next);
      toast.success(
        `${account.name} is now a ${ACCOUNT_TYPE_LABELS[updated.accountType].toLowerCase()}`,
        updated.accountType === 'builder'
          ? 'Their portal gains the Site supervisors screen, and their booking form no longer asks for the area and bag count — those come off the purchase order.'
          : 'Their portal loses the Site supervisors screen, and their booking form now asks for the area and bag count.',
      );
    } catch (error) {
      const described = describeError(error);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Customer type</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground">
              <RouteIcon aria-hidden className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {ACCOUNT_TYPE_LABELS[account.accountType]} journey
              </p>
              <p className="text-sm text-muted-foreground">
                {ACCOUNT_TYPE_DESCRIPTIONS[account.accountType]}
              </p>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Changing this changes their portal: the Site supervisors screen, and whether their
                booking form asks for the area and bag count.
              </p>
            </div>
          </div>

          {/*
            `w-full sm:w-auto` so this is a full-width control on a phone and a
            compact one beside the copy on a desktop — the office opens accounts
            on both.
          */}
          <Select
            className="w-full sm:w-44"
            value={account.accountType}
            disabled={setType.isPending}
            aria-label="Customer type"
            onChange={(event) => void change(event.target.value as AccountType)}
          >
            {ACCOUNT_TYPES.map((type) => (
              <option key={type} value={type}>
                {ACCOUNT_TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * One site's exception to the account rule.
 *
 * Rendered inside the grid rather than behind a row action: the whole reason to
 * open this tab is to see which sites differ, and a control you have to click
 * into to read is not an answer to that question.
 */

const ACCOUNT_JOB_COLUMNS: readonly DataTableColumn<JobListItem>[] = [
  {
    id: 'jobNumber',
    header: 'Job',
    sortKey: 'jobNumber',
    priority: 'primary',
    cell: (row) => <span className="font-mono font-medium">#{row.jobNumber}</span>,
  },
  {
    id: 'status',
    header: 'Status',
    sortKey: 'status',
    priority: 'secondary',
    cell: (row) => <JobStatusBadge status={row.status} />,
  },
  {
    id: 'site',
    header: 'Site',
    priority: 'detail',
    cell: (row) => (
      <span className="text-muted-foreground">
        {row.siteName}, {row.suburb}
      </span>
    ),
  },
  {
    id: 'readyDate',
    header: 'Ready',
    sortKey: 'readyDate',
    priority: 'detail',
    cell: (row) => formatDate(row.readyDate),
  },
  {
    id: 'expectedAreaM2',
    header: 'm²',
    numeric: true,
    priority: 'detail',
    cell: (row) => row.expectedAreaM2?.toLocaleString('en-AU') ?? '—',
  },
  {
    id: 'totalExGst',
    header: 'Total ex GST',
    numeric: true,
    priority: 'detail',
    cell: (row) => formatMoney(row.totalExGst),
  },
];

function invoiceColumns(prefix: string): readonly DataTableColumn<InvoiceListItem>[] {
  return [
    {
      id: 'invoiceNumber',
      header: 'Invoice',
      sortKey: 'invoiceNumber',
      priority: 'primary',
      cell: (row) => (
        <span className="block">
          <span className="font-mono font-medium">
            {formatInvoiceNumber(row.invoiceNumber, prefix)}
          </span>
          <span className="block text-xs text-muted-foreground">
            {row.kind === 'base' ? 'Base invoice' : 'Additional charges'}
          </span>
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortKey: 'status',
      priority: 'secondary',
      cell: (row) => <InvoiceStatusBadge status={row.status} />,
    },
    {
      id: 'jobNumber',
      header: 'Job',
      priority: 'detail',
      cell: (row) =>
        row.jobId ? (
          <Link
            to={`/admin/jobs/${row.jobId}`}
            className="focus-ring rounded font-mono text-primary underline-offset-4 hover:underline"
          >
            #{row.jobNumber}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'poNumber',
      header: 'PO',
      priority: 'detail',
      cell: (row) => (
        <span className="font-mono text-xs text-muted-foreground">{row.poNumber ?? '—'}</span>
      ),
    },
    {
      id: 'issuedOn',
      header: 'Issued',
      sortKey: 'issuedOn',
      priority: 'detail',
      cell: (row) => formatDate(row.issuedOn),
    },
    {
      id: 'totalIncGst',
      header: 'Total inc GST',
      numeric: true,
      priority: 'detail',
      cell: (row) => formatMoney(row.totalIncGst),
    },
  ];
}

/* ── M7.5 · which template this account's invoices print on ─────────────── */

/**
 * Choose the invoice template, or hand the account back to its brand.
 *
 * ── Why "follow the brand" is an option and not an empty selection ────────
 * Null is a real, and usually correct, answer: a new account should look right
 * without anybody choosing, and changing the brand's template should carry
 * those accounts with it. Offering it as a named choice is what stops somebody
 * reading a blank row as a configuration they forgot to finish.
 *
 * ⚠️ Changing this affects the NEXT invoice only. Every invoice already
 * rendered stores the template's name and its own PDF, so nothing a customer
 * has been sent moves.
 */
function InvoiceTemplateDialog({
  account,
  templates,
  open,
  onClose,
}: {
  account: Account;
  templates: readonly InvoiceTemplate[];
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const assign = useSetInvoiceTemplate(account.id);

  /* `''` is the sentinel for "follow the brand" — a select cannot hold null. */
  const [choice, setChoice] = useState(account.invoiceTemplateId ?? '');

  const submit = async () => {
    try {
      await assign.mutateAsync(choice === '' ? null : choice);
      onClose();
      toast.success(
        'Invoice template updated',
        'It applies to the next invoice raised for this account.',
      );
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Invoice template"
      description="What this customer's invoices look like. Invoices already sent keep the template they were drawn with."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={assign.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={assign.isPending}>
            {assign.isPending && <Spinner className="text-current" />}
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field id="account-template" label="Template">
          {(aria) => (
            <Select
              {...aria}
              value={choice}
              onChange={(event) => {
                setChoice(event.target.value);
              }}
            >
              <option value="">Follow the {BRAND_LABELS[account.brandId]} default</option>
              {/*
                Only this account's own brand. A PlastaGo customer invoiced on
                an EasyLift template would receive the wrong company's
                letterhead, which is not a preference anybody should be able to
                express by accident.
              */}
              {templates
                .filter((template) => template.brandId === account.brandId)
                .map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
            </Select>
          )}
        </Field>

        <Alert variant="neutral" title="Preview it first">
          Settings → Invoicing → Templates has a Preview on every template, so you can see what
          this customer will receive before you choose it.
        </Alert>
      </div>
    </Dialog>
  );
}
