import type { Certificate, FinancialRow, ReportFilters, VolumeRow } from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  DatePicker,
  ErrorState,
  Pagination,
  Select,
  Skeleton,
  Spinner,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTrigger,
  useToast,
} from '@plastago/ui';
import { AwardIcon, FileTextIcon, LayoutDashboardIcon, SendIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { useDocumentTab } from '@/features/documents/use-document-tab';
import {
  useCertificatePdf,
  useCertificates,
  useFinancialReport,
  useIssueCertificate,
  useMonthlyVolumeReport,
  useResendCertificate,
  useZoneVolumeReport,
} from '@/features/reports/queries';
import { useAccountOptions, useDriverOptions, useZoneOptions } from '@/features/lookups/queries';
import { firstOfMonthsAgo, todayInSydney } from '@/lib/business-day';
import { describeError } from '@/lib/error-message';
import { formatArea, formatDate, formatMoney, formatWeight } from '@/lib/format';

const TABS = ['volumes', 'zones', 'financial', 'certificates'] as const;
type TabKey = (typeof TABS)[number];

/**
 * Reports (M9.1–M9.3, M9.6) and diversion certificates (M9.5 · F52).
 *
 * ── Fixed reports, and that is the point ───────────────────────────────────
 * Four named reports with parameters. There is no report builder and no way to
 * become one: F31 is v1.1 and Risk 5 names the WYSIWYG designer as the biggest
 * single scope trap in the project.
 *
 * The operations dashboard lives at its own route rather than as a tab here —
 * it is opened hourly and everything on this page is opened monthly.
 */
export function AdminReportsPage() {
  const [params, setParams] = useSearchParams();
  const accounts = useAccountOptions();
  const drivers = useDriverOptions();

  const rawTab = params.get('tab');
  const tab: TabKey = (TABS as readonly string[]).includes(rawTab ?? '')
    ? (rawTab as TabKey)
    : 'volumes';

  const setParam = (name: string, value: string, clearWhen?: string) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (!value || value === clearWhen) next.delete(name);
        else next.set(name, value);
        return next;
      },
      { replace: true },
    );
  };

  /**
   * Report parameters live in the URL like every other filter set in this
   * console, so a monthly report someone runs can be sent as a link rather than
   * described over the phone.
   */
  const filters = useMemo<ReportFilters>(
    () => ({
      from: params.get('from') ?? firstOfMonthsAgo(2),
      to: params.get('to') ?? todayInSydney(),
      zoneId: params.get('zoneId'),
      accountId: params.get('account'),
      // Narrowed by suburb now — there is no site record to key on (Matt, 0:29).
      suburb: params.get('suburb'),
      driverId: params.get('driver'),
    }),
    [params],
  );

  const certificateQuery = useListQuery({
    paramPrefix: 'cert',
    filterKeys: ['state', 'account'],
    defaultPageSize: 10,
  });

  const monthly = useMonthlyVolumeReport(filters, tab === 'volumes');
  const zones = useZoneVolumeReport(filters, tab === 'zones');
  /*
   * The zone REGISTER, for the filter dropdown — distinct from `zones` above,
   * which is the volume report itself.
   */
  const zoneOptions = useZoneOptions().data ?? [];
  const financial = useFinancialReport(filters, tab === 'financial');
  const certificates = useCertificates(certificateQuery.query, tab === 'certificates');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description="The fixed reports the office sends today, self-serve — plus the diversion evidence their customers need."
        actions={
          <Link
            to="/admin"
            className="focus-ring flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <LayoutDashboardIcon aria-hidden className="size-4" />
            Operations dashboard
          </Link>
        }
      />

      {/* ── Shared parameters ────────────────────────────────────────────── */}
      {tab !== 'certificates' && (
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3 pt-5">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              From
              <DatePicker
                value={filters.from}
                onChange={(event) => {
                  setParam('from', event.target.value);
                }}
                className="w-auto"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              To
              <DatePicker
                value={filters.to}
                onChange={(event) => {
                  setParam('to', event.target.value);
                }}
                className="w-auto"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:w-56">
              Customer
              <Select
                value={filters.accountId ?? ''}
                onChange={(event) => {
                  setParam('account', event.target.value);
                }}
              >
                <option value="">All customers</option>
                {(accounts.data ?? []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:w-40">
              Zone
              <Select
                value={filters.zoneId ?? ''}
                onChange={(event) => {
                  setParam('zoneId', event.target.value);
                }}
              >
                <option value="">All zones</option>
                {/*
                  Retired zones are OFFERED, and marked as such. A report is
                  about work that has already happened, so a zone the office has
                  since stopped servicing is exactly the one somebody may need
                  to report on.
                */}
                {zoneOptions.map((zone) => (
                  <option key={zone.value} value={zone.value}>
                    {zone.archived ? `${zone.label} (retired)` : zone.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:w-44">
              Driver
              <Select
                value={filters.driverId ?? ''}
                onChange={(event) => {
                  setParam('driver', event.target.value);
                }}
              >
                <option value="">All drivers</option>
                {(drivers.data ?? []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setParams(
                  (current) => {
                    const next = new URLSearchParams(current);
                    for (const key of ['from', 'to', 'account', 'suburb', 'zone', 'driver']) {
                      next.delete(key);
                    }
                    return next;
                  },
                  { replace: true },
                );
              }}
            >
              Reset
            </Button>
          </CardContent>
        </Card>
      )}

      <Tabs
        value={tab}
        onValueChange={(next) => {
          setParam('tab', next, 'volumes');
        }}
      >
        <TabsList label="Reports">
          <TabsTrigger value="volumes">Pickup volumes</TabsTrigger>
          <TabsTrigger value="zones">By zone</TabsTrigger>
          <TabsTrigger value="financial">Financial</TabsTrigger>
          <TabsTrigger value="certificates">Certificates</TabsTrigger>
        </TabsList>

        {/* ── M9.1 ─────────────────────────────────────────────────────── */}
        <TabsPanel value="volumes">
          {monthly.error ? (
            <Card>
              <ErrorState
                title={describeError(monthly.error).title}
                description={describeError(monthly.error).detail}
                onRetry={() => void monthly.refetch()}
              />
            </Card>
          ) : monthly.isPending ? (
            <ReportSkeleton />
          ) : monthly.data ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <StatCard label="Jobs" value={monthly.data.totalJobs} />
                <StatCard label="Square metres" value={formatArea(monthly.data.totalAreaM2)} />
                <StatCard
                  label="Charges ex GST"
                  value={formatMoney(monthly.data.totalChargesExGst)}
                />
              </div>

              <Card className="overflow-hidden p-0">
                <div className="border-b border-border px-4 py-3">
                  <p className="text-sm font-medium">
                    {filters.accountId ? 'By suburb' : 'By customer'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {filters.accountId
                      ? 'Suburbs for the selected customer — the next question a customer asks.'
                      : 'Select a customer above to break this down by suburb.'}
                  </p>
                </div>
                <SimpleTable<VolumeRow>
                  caption="Pickup volumes"
                  rows={monthly.data.rows}
                  getRowId={(row) => row.key}
                  columns={[
                    {
                      id: 'label',
                      header: filters.accountId ? 'Site' : 'Customer',
                      priority: 'primary',
                      cell: (row) => row.label,
                    },
                    { id: 'jobs', header: 'Jobs', numeric: true, cell: (row) => row.jobs },
                    {
                      id: 'area',
                      header: 'm²',
                      numeric: true,
                      cell: (row) => row.areaM2.toLocaleString('en-AU'),
                    },
                    {
                      id: 'weight',
                      header: 'Recovered',
                      numeric: true,
                      // Blank, not zero, for m²-only accounts: a zero would read
                      // as "nothing recovered", which is a different claim.
                      cell: (row) => (row.weightKg === null ? '—' : formatWeight(row.weightKg)),
                    },
                    { id: 'bags', header: 'Bags', numeric: true, cell: (row) => row.bags },
                    {
                      id: 'charges',
                      header: 'Charges ex GST',
                      numeric: true,
                      cell: (row) => formatMoney(row.chargesExGst),
                    },
                  ]}
                  emptyTitle="No completed jobs in this period"
                />
              </Card>

              <Alert variant="info" title="This report is parity, not an improvement">
                They produce it today and send it to customers, and at least one customer requires
                it. It has to exist on day 20.
              </Alert>
            </div>
          ) : null}
        </TabsPanel>

        {/* ── M9.3 ─────────────────────────────────────────────────────── */}
        <TabsPanel value="zones">
          {zones.error ? (
            <Card>
              <ErrorState
                title={describeError(zones.error).title}
                onRetry={() => void zones.refetch()}
              />
            </Card>
          ) : zones.isPending ? (
            <ReportSkeleton />
          ) : zones.data ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <StatCard label="Jobs" value={zones.data.totalJobs} />
                <StatCard
                  label="Revenue ex GST"
                  value={formatMoney(zones.data.totalRevenueExGst)}
                />
              </div>

              <Card className="overflow-hidden p-0">
                <SimpleTable
                  caption="Volumes by zone"
                  rows={zones.data.rows}
                  getRowId={(row) => row.zoneId}
                  columns={[
                    {
                      id: 'zone',
                      header: 'Zone',
                      priority: 'primary',
                      cell: (row) => row.label,
                    },
                    { id: 'jobs', header: 'Jobs', numeric: true, cell: (row) => row.jobs },
                    {
                      id: 'area',
                      header: 'm²',
                      numeric: true,
                      cell: (row) => row.areaM2.toLocaleString('en-AU'),
                    },
                    {
                      id: 'revenue',
                      header: 'Revenue ex GST',
                      numeric: true,
                      cell: (row) => formatMoney(row.revenueExGst),
                    },
                    {
                      id: 'average',
                      header: 'Average job',
                      numeric: true,
                      cell: (row) => formatMoney(row.averageJobValueExGst),
                    },
                  ]}
                  emptyTitle="No jobs in this period"
                />
              </Card>

              <Alert variant="neutral" title="Why zone mix matters">
                Zone drives margin, because both the rate and the drive distance vary — Sydney is
                $220 + $0.16/m², Newcastle is $250 + $0.20/m².
              </Alert>
            </div>
          ) : null}
        </TabsPanel>

        {/* ── M9.6 ─────────────────────────────────────────────────────── */}
        <TabsPanel value="financial">
          {financial.error ? (
            <Card>
              <ErrorState
                title={describeError(financial.error).title}
                onRetry={() => void financial.refetch()}
              />
            </Card>
          ) : financial.isPending ? (
            <ReportSkeleton />
          ) : financial.data ? (
            <div className="space-y-4">
              <Alert variant="warning" title="The cost side is an assumption, not a measurement">
                Margin here applies a flat {formatMoney(financial.data.assumedCostPerJobExGst)} per
                job, reproducing the figure the current system shows. Real per-vehicle cost is the
                improvement to make once the vehicle expense log has history — which is what cost
                per kilometre is for.
              </Alert>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <StatCard
                  label="Revenue ex GST"
                  value={formatMoney(financial.data.totalRevenueExGst)}
                />
                <StatCard
                  label="Margin ex GST"
                  value={formatMoney(financial.data.totalMarginExGst)}
                  hint="Against the assumed cost"
                />
              </div>

              {(
                [
                  ['By customer', financial.data.byAccount],
                  ['By zone', financial.data.byZone],
                ] as const
              ).map(([label, rows]) => (
                <Card key={label} className="overflow-hidden p-0">
                  <div className="border-b border-border px-4 py-3">
                    <p className="text-sm font-medium">{label}</p>
                  </div>
                  <SimpleTable<FinancialRow>
                    caption={`Financial summary ${label.toLowerCase()}`}
                    rows={rows}
                    getRowId={(row) => row.key}
                    columns={[
                      {
                        id: 'label',
                        header: label.replace('By ', ''),
                        priority: 'primary',
                        cell: (row) => row.label,
                      },
                      { id: 'jobs', header: 'Jobs', numeric: true, cell: (row) => row.jobs },
                      {
                        id: 'base',
                        header: 'Base',
                        numeric: true,
                        cell: (row) => formatMoney(row.baseRevenueExGst),
                      },
                      {
                        id: 'extra',
                        header: 'Additional',
                        numeric: true,
                        cell: (row) => formatMoney(row.additionalServicesExGst),
                      },
                      {
                        id: 'total',
                        header: 'Revenue',
                        numeric: true,
                        cell: (row) => formatMoney(row.totalRevenueExGst),
                      },
                      {
                        id: 'margin',
                        header: 'Margin',
                        numeric: true,
                        cell: (row) => formatMoney(row.marginExGst),
                      },
                      {
                        id: 'percent',
                        header: 'Margin %',
                        numeric: true,
                        cell: (row) => (
                          <Badge
                            variant={
                              row.marginPercent >= 60
                                ? 'success'
                                : row.marginPercent >= 40
                                  ? 'secondary'
                                  : 'warning'
                            }
                          >
                            {row.marginPercent.toFixed(1)}%
                          </Badge>
                        ),
                      },
                    ]}
                    emptyTitle="No completed jobs in this period"
                  />
                </Card>
              ))}
            </div>
          ) : null}
        </TabsPanel>

        {/* ── M9.5 ─────────────────────────────────────────────────────── */}
        <TabsPanel value="certificates">
          <CertificatesTab
            controller={certificateQuery}
            data={certificates.data}
            error={certificates.error}
            isPending={certificates.isPending}
            isFetching={certificates.isFetching}
            onRetry={() => void certificates.refetch()}
          />
        </TabsPanel>
      </Tabs>
    </div>
  );
}

/* ── Certificates ────────────────────────────────────────────────────────── */

function CertificatesTab({
  controller,
  data,
  error,
  isPending,
  isFetching,
  onRetry,
}: {
  controller: ReturnType<typeof useListQuery>;
  data:
    { data: Certificate[]; meta: { page: number; pageSize: number; total: number } } | undefined;
  error: unknown;
  isPending: boolean;
  isFetching: boolean;
  onRetry: () => void;
}) {
  const toast = useToast();
  const issue = useIssueCertificate();
  const preview = useCertificatePdf();
  const resend = useResendCertificate();
  const [issuing, setIssuing] = useState<string | null>(null);
  const openTab = useDocumentTab();

  const run = async (certificate: Certificate) => {
    setIssuing(certificate.id);
    try {
      const result = await issue.mutateAsync(certificate.id);

      /*
       * ⚠️ Reports where it ACTUALLY went, never "emailed to the customer".
       *
       * Certificates go to a separate address from invoices (Matt, 31:04), and
       * an account that has none gets no email at all — the document waits in
       * the portal instead. Saying it was sent when it was not is how somebody
       * finds out three weeks later, from the customer.
       */
      toast.success(
        `Certificate ${result.reference} issued`,
        result.issuedTo === null
          ? `${result.tonnesDiverted.toFixed(2)} tonnes diverted. No certificate email is set on this account — it is in their portal.`
          : `${result.tonnesDiverted.toFixed(2)} tonnes diverted, emailed to ${result.issuedTo}.`,
      );
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    } finally {
      setIssuing(null);
    }
  };

  /* Reserved before the await — see `useDocumentTab`. */
  const view = async (certificate: Certificate) => {
    const deliver = openTab();

    try {
      const { url } = await preview.mutateAsync(certificate.id);
      deliver(url);
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const sendAgain = async (certificate: Certificate) => {
    try {
      const { sentTo } = await resend.mutateAsync(certificate.id);
      if (sentTo === null) {
        toast.error(
          'Nowhere to send it',
          'This account has no certificate email address. Add one on the account, then resend.',
        );
        return;
      }
      toast.success(`${certificate.reference} sent again`, `Emailed to ${sentTo}.`);
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const columns: readonly DataTableColumn<Certificate>[] = [
    {
      id: 'reference',
      header: 'Certificate',
      sortKey: 'reference',
      priority: 'primary',
      cell: (row) => <span className="font-mono font-medium">{row.reference}</span>,
    },
    {
      id: 'accountName',
      header: 'Customer',
      sortKey: 'accountName',
      priority: 'detail',
      cell: (row) => (
        <span className="block">
          <span>{row.accountName}</span>
          {row.siteName && (
            <span className="block text-xs text-muted-foreground">{row.siteName}</span>
          )}
        </span>
      ),
    },
    {
      id: 'state',
      header: 'State',
      priority: 'secondary',
      cell: (row) => (
        <Badge variant={row.state === 'issued' ? 'success' : 'outline'}>
          {row.state === 'issued' ? 'Issued' : 'Draft'}
        </Badge>
      ),
    },
    {
      id: 'periodFrom',
      header: 'Period',
      sortKey: 'periodFrom',
      priority: 'detail',
      cell: (row) => formatDate(row.periodFrom),
    },
    {
      id: 'areaM2',
      header: 'm²',
      numeric: true,
      priority: 'detail',
      cell: (row) => row.areaM2?.toLocaleString('en-AU') ?? '—',
    },
    {
      id: 'tonnes',
      header: 'Tonnes diverted',
      sortKey: 'tonnesDiverted',
      numeric: true,
      priority: 'secondary',
      cell: (row) => <span className="font-medium">{row.tonnesDiverted.toFixed(2)}</span>,
    },
    {
      id: 'action',
      header: 'Action',
      className: 'w-48',
      cell: (row) =>
        row.state === 'issued' ? (
          /*
           * An issued certificate can never be re-issued, so the only two
           * things left to do with it are look at it and send it again.
           */
          <span className="flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={preview.isPending}
              onClick={() => void view(row)}
            >
              <FileTextIcon aria-hidden />
              View
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={resend.isPending}
              onClick={() => void sendAgain(row)}
            >
              <SendIcon aria-hidden />
              Resend
            </Button>
          </span>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={issuing !== null}
            onClick={() => void run(row)}
          >
            {issuing === row.id && <Spinner className="text-current" />}
            Issue
          </Button>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      {/*
        M9.5 is called the single highest-value differentiator in the build — their
        customers need auditable diversion evidence for Green Star, council waste
        management plans and their own ESG reporting, and neither TransVirtual nor
        REGYP offers it.
      */}
      <Alert variant="info" title="Both square metres and tonnage, and the tonnage is measured">
        The tonnes figure is the recovered weight reconciled against the tip-off weighbridge total —
        not derived from the m² used for pricing. These go into builders’ Green Star submissions and
        have to be defensible under audit.
      </Alert>

      <Alert variant="warning" title="Layout still pending a sample">
        A sample certificate has been requested from the client so the exact data points and wording
        match what their customers already accept. The figures here are real; the document layout is
        not final.
      </Alert>

      <Card className="overflow-hidden p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search reference, customer or job…"
          filters={[
            {
              key: 'state',
              label: 'State',
              allLabel: 'Any state',
              options: [
                { value: 'draft', label: 'Draft' },
                { value: 'issued', label: 'Issued' },
              ],
            },
          ]}
        />

        <DataTable
          caption="Diversion certificates"
          columns={columns}
          rows={data?.data ?? []}
          getRowId={(row) => row.id}
          isPending={isPending}
          isFetching={isFetching && !isPending}
          error={error}
          onRetry={onRetry}
          sort={controller.sort}
          onToggleSort={controller.toggleSort}
          isFiltered={controller.isFiltered}
          onClearFilters={controller.clearFilters}
          empty={{
            icon: AwardIcon,
            title: 'No certificates yet',
            description: 'A certificate becomes available once a job is complete.',
          }}
        />

        {data && (
          <Pagination
            page={data.meta.page}
            pageSize={data.meta.pageSize}
            total={data.meta.total}
            onPageChange={controller.setPage}
            onPageSizeChange={controller.setPageSize}
            pageSizeOptions={[5, 10, 15, 20]}
          />
        )}
      </Card>
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * A report table.
 *
 * Reuses `DataTable` with sorting and paging turned off, because a report is a
 * complete result set rather than a page through a domain — but it still gets the
 * same responsive card collapse, empty state and column contract, which is the
 * whole reason not to write a second table component.
 */
function SimpleTable<TRow>({
  caption,
  rows,
  columns,
  getRowId,
  emptyTitle,
}: {
  caption: string;
  rows: readonly TRow[];
  columns: readonly DataTableColumn<TRow>[];
  getRowId: (row: TRow) => string;
  emptyTitle: string;
}) {
  return (
    <DataTable
      caption={caption}
      columns={columns}
      rows={rows}
      getRowId={getRowId}
      empty={{ title: emptyTitle, description: 'Try widening the date range.' }}
    />
  );
}

function ReportSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <Card key={index} className="p-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-3 h-7 w-24" />
          </Card>
        ))}
      </div>
      <Card className="p-5">
        <Skeleton className="h-4 w-40" />
        <div className="mt-4 space-y-2.5">
          {[0, 1, 2, 3, 4].map((index) => (
            <Skeleton key={index} className="h-4 w-full" />
          ))}
        </div>
      </Card>
    </div>
  );
}
