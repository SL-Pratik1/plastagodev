import {
  BRAND_LABELS,
  CAPTURE_MODE_LABELS,
  CONTACT_ROLE_LABELS,
  PO_POLICY_LABELS,
  RATE_CARD_LABELS,
  ZONE_LABELS,
  type InvoiceListItem,
  type JobListItem,
  type Site,
} from '@plastago/shared';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Pagination,
  Skeleton,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTrigger,
} from '@plastago/ui';
import { BriefcaseIcon, MailIcon, MapPinIcon, ReceiptIcon, SmartphoneIcon } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { DetailList } from '@/components/detail-list';
import { InvoiceStatusBadge, JobStatusBadge } from '@/components/domain-badges';
import { PageHeader } from '@/components/page-header';
import {
  useCustomer,
  useCustomerInvoices,
  useCustomerJobs,
  useCustomerSites,
} from '@/features/customers/queries';
import { describeError } from '@/lib/error-message';
import { formatDate, formatMobile, formatMoney } from '@/lib/format';

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
export function AdminCustomerDetailPage() {
  const { customerId } = useParams();
  const [params, setParams] = useSearchParams();

  const { data: account, error, isPending, refetch } = useCustomer(customerId);

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

  const siteQuery = useListQuery({
    paramPrefix: 'sites',
    filterKeys: ['zone'],
    defaultPageSize: 10,
  });
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

  const sites = useCustomerSites(customerId, siteQuery.query, tab === 'sites');
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
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList label="Account sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="sites" badge={account.siteCount}>
            Sites
          </TabsTrigger>
          <TabsTrigger value="contacts" badge={account.contacts.length}>
            Contacts
          </TabsTrigger>
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="preferences">Preferences</TabsTrigger>
        </TabsList>

        {/* ── Overview ─────────────────────────────────────────────────── */}
        <TabsPanel value="overview">
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Billing and terms</CardTitle>
              </CardHeader>
              <CardContent>
                <DetailList
                  columns={2}
                  items={[
                    { label: 'ABN', value: account.abn },
                    { label: 'Payment terms', value: `${String(account.paymentTermsDays)} days` },
                    { label: 'Rate card', value: RATE_CARD_LABELS[account.rateCardId] },
                    { label: 'Primary zone', value: ZONE_LABELS[account.primaryZone] },
                    { label: 'PO policy', value: PO_POLICY_LABELS[account.poPolicy] },
                    { label: 'Capture', value: CAPTURE_MODE_LABELS[account.captureMode] },
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

        {/* ── Sites ────────────────────────────────────────────────────── */}
        <TabsPanel value="sites">
          <Card className="overflow-hidden p-0">
            <DataTableToolbar
              controller={siteQuery}
              searchPlaceholder="Search site, lot, suburb or builder…"
              filters={[
                {
                  key: 'zone',
                  label: 'Zone',
                  allLabel: 'All zones',
                  options: Object.entries(ZONE_LABELS).map(([value, label]) => ({ value, label })),
                },
              ]}
            />
            <DataTable
              caption={`Sites for ${account.name}`}
              columns={SITE_COLUMNS}
              rows={sites.data?.data ?? []}
              getRowId={(row) => row.id}
              isPending={sites.isPending}
              isFetching={sites.isFetching && !sites.isPending}
              error={sites.error}
              onRetry={() => void sites.refetch()}
              sort={siteQuery.sort}
              onToggleSort={siteQuery.toggleSort}
              isFiltered={siteQuery.isFiltered}
              onClearFilters={siteQuery.clearFilters}
              empty={{
                icon: MapPinIcon,
                title: 'No sites yet',
                description: 'Sites are added when the first job is booked at an address.',
              }}
            />
            {sites.data && (
              <Pagination
                page={sites.data.meta.page}
                pageSize={sites.data.meta.pageSize}
                total={sites.data.meta.total}
                onPageChange={siteQuery.setPage}
                onPageSizeChange={siteQuery.setPageSize}
                pageSizeOptions={[10, 25, 50]}
              />
            )}
          </Card>
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
                pageSizeOptions={[10, 25, 50]}
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
              columns={INVOICE_COLUMNS}
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
                pageSizeOptions={[10, 25, 50]}
              />
            )}
          </Card>
        </TabsPanel>

        {/* ── Preferences ──────────────────────────────────────────────── */}
        <TabsPanel value="preferences">
          <Card>
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

const SITE_COLUMNS: readonly DataTableColumn<Site>[] = [
  {
    id: 'name',
    header: 'Site',
    sortKey: 'name',
    priority: 'primary',
    cell: (row) => (
      <span className="block">
        <span className="font-medium">{row.name}</span>
        <span className="block text-xs text-muted-foreground">
          {row.addressLine}, {row.suburb} {row.postcode}
        </span>
      </span>
    ),
  },
  {
    id: 'builderName',
    header: 'Builder',
    sortKey: 'builderName',
    priority: 'secondary',
    // The builder is a property of the SITE, not the account (M1.2).
    cell: (row) => <Badge variant="outline">{row.builderName}</Badge>,
  },
  {
    id: 'zone',
    header: 'Zone',
    priority: 'detail',
    cell: (row) => <span className="text-muted-foreground">{ZONE_LABELS[row.zone]}</span>,
  },
  {
    id: 'access',
    header: 'Access',
    priority: 'detail',
    cell: (row) => (
      <span className="flex flex-wrap gap-1">
        {row.craneAvailable && <Badge variant="secondary">Crane</Badge>}
        {row.inductionRequired && <Badge variant="warning">Induction</Badge>}
        {row.gateHours && <Badge variant="outline">{row.gateHours}</Badge>}
      </span>
    ),
  },
  {
    id: 'jobCount',
    header: 'Jobs',
    sortKey: 'jobCount',
    numeric: true,
    priority: 'detail',
    className: 'w-20',
    cell: (row) => row.jobCount,
  },
];

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
    cell: (row) => row.expectedAreaM2.toLocaleString('en-AU'),
  },
  {
    id: 'totalExGst',
    header: 'Total ex GST',
    numeric: true,
    priority: 'detail',
    cell: (row) => formatMoney(row.totalExGst),
  },
];

const INVOICE_COLUMNS: readonly DataTableColumn<InvoiceListItem>[] = [
  {
    id: 'invoiceNumber',
    header: 'Invoice',
    sortKey: 'invoiceNumber',
    priority: 'primary',
    cell: (row) => (
      <span className="block">
        <span className="font-mono font-medium">#{row.invoiceNumber}</span>
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
