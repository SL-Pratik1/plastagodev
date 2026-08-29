import type { Certificate } from '@plastago/shared';
import { Alert, Badge, Button, Card, Pagination, Spinner, useToast } from '@plastago/ui';
import { AwardIcon, DownloadIcon } from 'lucide-react';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn, FilterDefinition } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { StatCard } from '@/components/stat-card';
import {
  usePortalCertificatePdf,
  usePortalCertificates,
  usePortalScope,
} from '@/features/portal/queries';
import { describeError } from '@/lib/error-message';
import { formatArea, formatDate, formatWeight } from '@/lib/format';

/**
 * Certificates of Recycling (M5.12 · F52, W84) — Customer Administrator only.
 *
 * ── These documents go into Green Star submissions ────────────────────────
 * Which is why the tonnage on them is the *recovered* weight from the tip-off
 * reconciliation, not something derived from the priced square metres. On an
 * m²-only account the figure is an estimate, and this screen says so on the row
 * rather than in a footnote: a certificate that quietly presents an estimate as
 * a measurement is the one thing here that could fail an audit.
 *
 * ── Per job now, per project later ────────────────────────────────────────
 * M5.12 offers "a project, a period or a job". The scope of a certificate is a
 * field on the record (`scope`), and only job-level ones exist in this build —
 * the period and project rollups need the tip-off reconciliation history behind
 * them, which arrives with M4.4.
 */
const FILTER_KEYS = ['state'] as const;

const STATIC_FILTERS: readonly FilterDefinition[] = [
  {
    key: 'state',
    label: 'Status',
    allLabel: 'All certificates',
    options: [
      { value: 'issued', label: 'Issued' },
      { value: 'draft', label: 'Pending finalisation' },
    ],
  },
];

export function PortalCertificatesPage() {
  const toast = useToast();
  const scope = usePortalScope();
  const controller = useListQuery({ filterKeys: FILTER_KEYS, defaultPageSize: 20 });
  const { data, error, isPending, isFetching, refetch } = usePortalCertificates(controller.query);
  const requestPdf = usePortalCertificatePdf();

  const capturesWeight = scope.data?.capturesWeight ?? false;
  const rows = data?.data ?? [];
  const issued = rows.filter((row) => row.state === 'issued');
  const totalTonnes = issued.reduce((sum, row) => sum + row.tonnesDiverted, 0);

  const download = async (certificate: Certificate) => {
    try {
      await requestPdf.mutateAsync(certificate.id);
      toast.success(
        `${certificate.reference} on the way`,
        'The PDF will appear in your downloads shortly.',
      );
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
      cell: (row) => (
        <span className="block">
          <span className="font-mono font-medium">{row.reference}</span>
          <span className="block text-xs text-muted-foreground">
            Pickup #{row.jobNumber ?? '—'}
          </span>
        </span>
      ),
    },
    {
      id: 'siteName',
      header: 'Site',
      priority: 'detail',
      cell: (row) => row.siteName ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: 'periodFrom',
      header: 'Date',
      sortKey: 'periodFrom',
      priority: 'secondary',
      cell: (row) => <span className="tabular-nums">{formatDate(row.periodFrom)}</span>,
    },
    {
      id: 'areaM2',
      header: 'Plasterboard',
      numeric: true,
      priority: 'detail',
      cell: (row) => formatArea(row.areaM2),
    },
    {
      id: 'tonnesDiverted',
      header: 'Diverted',
      sortKey: 'tonnesDiverted',
      numeric: true,
      priority: 'secondary',
      cell: (row) => (
        <span className="block">
          <span className="block tabular-nums">{formatWeight(row.tonnesDiverted * 1000)}</span>
          {/* Stated on the row, not buried: these go into Green Star. */}
          {!capturesWeight && <span className="block text-xs text-warning">Estimated from m²</span>}
        </span>
      ),
    },
    {
      id: 'state',
      header: 'Status',
      priority: 'secondary',
      cell: (row) =>
        row.state === 'issued' ? (
          <Badge variant="success">Issued</Badge>
        ) : (
          <Badge variant="outline">Pending</Badge>
        ),
    },
    {
      id: 'download',
      header: 'PDF',
      priority: 'secondary',
      className: 'w-32',
      cell: (row) =>
        row.state === 'issued' ? (
          <Button
            size="sm"
            variant="outline"
            disabled={requestPdf.isPending}
            onClick={() => void download(row)}
          >
            <DownloadIcon aria-hidden />
            Download
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">Not yet issued</span>
        ),
    },
  ];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-display text-xl font-semibold tracking-tight">
          Certificates of Recycling
        </h1>
        <p className="text-sm text-muted-foreground">
          Evidence of diversion from landfill, per pickup — for Green Star submissions and council
          reporting.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Certificates issued"
          value={issued.length}
          hint="On this page"
          icon={AwardIcon}
          isPending={isPending}
        />
        <StatCard
          label="Diverted from landfill"
          value={totalTonnes > 0 ? formatWeight(totalTonnes * 1000) : '—'}
          hint={capturesWeight ? 'Measured at the tip' : 'Estimated from square metres'}
          tone="positive"
          isPending={isPending}
        />
        <StatCard
          label="Pending"
          value={rows.length - issued.length}
          hint="Issued once the pickup is finalised"
          isPending={isPending}
        />
      </div>

      <Card className="overflow-hidden p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search certificate reference, site or pickup number…"
          filters={STATIC_FILTERS}
          actions={requestPdf.isPending ? <Spinner label="Preparing" /> : undefined}
        />

        <DataTable
          caption="Your certificates of recycling"
          columns={columns}
          rows={rows}
          getRowId={(row) => row.id}
          isPending={isPending}
          isFetching={isFetching && !isPending}
          error={error}
          onRetry={() => void refetch()}
          sort={controller.sort}
          onToggleSort={controller.toggleSort}
          isFiltered={controller.isFiltered}
          onClearFilters={controller.clearFilters}
          empty={{
            icon: AwardIcon,
            title: 'No certificates yet',
            description:
              'A certificate is issued for each completed pickup once it has been finalised.',
          }}
        />

        {data && (
          <Pagination
            page={data.meta.page}
            pageSize={data.meta.pageSize}
            total={data.meta.total}
            onPageChange={controller.setPage}
            onPageSizeChange={controller.setPageSize}
            disabled={isFetching}
          />
        )}
      </Card>

      {capturesWeight ? (
        <Alert variant="info" title="Where the tonnage comes from">
          The diverted weight on your certificates is the actual recovered weight recorded when the
          load is tipped and reconciled — not a figure worked back from square metres. That is what
          makes it defensible in a Green Star submission.
        </Alert>
      ) : (
        <Alert variant="warning" title="Your tonnage figures are estimates">
          Your account records square metres, so the diverted weight shown here is estimated from
          the area collected. If you need measured tonnage for a submission, call the office on{' '}
          <a href="tel:1300395438" className="font-medium underline underline-offset-4">
            1300 395 438
          </a>{' '}
          and we will start recording weight at the tip for your pickups.
        </Alert>
      )}
    </div>
  );
}
