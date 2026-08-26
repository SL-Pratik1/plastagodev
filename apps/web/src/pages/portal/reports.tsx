import type { ReportFilters } from '@plastago/shared';
import {
  Alert,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Input,
  Select,
  Skeleton,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@plastago/ui';
import { useSearchParams } from 'react-router';
import { MonthlyVolumeChart } from '@/components/charts/portal-charts';
import { StatCard } from '@/components/stat-card';
import { usePortalMonthlyReport, usePortalScope, usePortalSites } from '@/features/portal/queries';
import { describeError } from '@/lib/error-message';
import { formatArea, formatMoney, formatWeight } from '@/lib/format';
import { useNow } from '@/lib/use-now';

/**
 * Monthly reports (M5.11 · F1, W74, W76, W78, W82) — Customer Administrator only.
 *
 * ── This is the report PlastaGo currently produces by hand ────────────────
 * M5.11's whole value is that it is self-serve: the office sends this to
 * customers today, one at a time, on request. Four separate workflows in §12
 * (W74, W76, W78, W82) are all "ask PlastaGo for a report" — and every one of
 * them disappears the moment the customer can pull it themselves.
 *
 * ── Grouped by site, not by account ───────────────────────────────────────
 * The admin console groups the same report by account because it serves many.
 * A customer has one account and several sites, so "which of my sites produced
 * this" is the only grouping that answers a question they actually have.
 *
 * ── No report builder ─────────────────────────────────────────────────────
 * Two dates and an optional site. Risk 5 names the generic report builder as the
 * biggest scope trap in the project, and a parameterised grid is the first step
 * onto it.
 */
export function PortalReportsPage() {
  const [params, setParams] = useSearchParams();
  const now = useNow(600_000);
  const scope = usePortalScope();
  const sites = usePortalSites({ page: 1, pageSize: 200 });

  // Default window: the last three months, which is what a customer opening a
  // "monthly report" almost always wants. A single month hides the trend.
  const today = new Date(now);
  const defaultTo = today.toISOString().slice(0, 10);
  const start = new Date(today);
  start.setUTCMonth(start.getUTCMonth() - 2);
  start.setUTCDate(1);
  const defaultFrom = start.toISOString().slice(0, 10);

  const filters: ReportFilters = {
    from: params.get('from') ?? defaultFrom,
    to: params.get('to') ?? defaultTo,
    accountId: null,
    siteId: params.get('site') || null,
    zone: null,
    driverId: null,
  };

  const setParam = (name: string, value: string) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(name, value);
        else next.delete(name);
        return next;
      },
      { replace: true },
    );
  };

  const report = usePortalMonthlyReport(filters);
  const capturesWeight = scope.data?.capturesWeight ?? false;

  const totalWeightKg = (report.data?.rows ?? []).reduce(
    (sum, row) => sum + (row.weightKg ?? 0),
    0,
  );

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-display text-xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground">
          Your pickup volumes by site and by month — the report we used to email you.
        </p>
      </header>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-5">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            From
            <Input
              type="date"
              value={filters.from}
              max={filters.to}
              onChange={(event) => {
                setParam('from', event.target.value);
              }}
              className="w-auto"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            To
            <Input
              type="date"
              value={filters.to}
              min={filters.from}
              onChange={(event) => {
                setParam('to', event.target.value);
              }}
              className="w-auto"
            />
          </label>
          {(sites.data?.data.length ?? 0) > 1 && (
            <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:w-64">
              Site
              <Select
                value={filters.siteId ?? ''}
                onChange={(event) => {
                  setParam('site', event.target.value);
                }}
              >
                <option value="">All sites</option>
                {(sites.data?.data ?? []).map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name} — {site.suburb}
                  </option>
                ))}
              </Select>
            </label>
          )}
          {report.isFetching && <Spinner label="Loading report" />}
        </CardContent>
      </Card>

      {report.error ? (
        <Card>
          <ErrorState
            title={describeError(report.error).title}
            description={describeError(report.error).detail}
            onRetry={() => void report.refetch()}
          />
        </Card>
      ) : report.isPending ? (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
          <Skeleton className="h-72" />
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Pickups"
              value={report.data.totalJobs}
              hint="Completed in this period"
            />
            <StatCard
              label="Plasterboard"
              value={formatArea(report.data.totalAreaM2)}
              hint="Square metres collected"
            />
            {capturesWeight ? (
              <StatCard
                label="Diverted from landfill"
                value={totalWeightKg > 0 ? formatWeight(totalWeightKg) : '—'}
                hint="Recovered weight, measured at the tip"
                tone="positive"
              />
            ) : (
              <StatCard
                label="Sites serviced"
                value={report.data.rows.length}
                hint="With at least one completed pickup"
              />
            )}
            <StatCard
              label="Charges"
              value={formatMoney(report.data.totalChargesExGst)}
              hint="Ex GST, this period"
            />
          </div>

          {report.data.byMonth.length > 0 && <MonthlyVolumeChart data={report.data.byMonth} />}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">By site</CardTitle>
              <p className="text-xs text-muted-foreground">
                Completed pickups only, largest first.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              {report.data.rows.length === 0 ? (
                <p className="px-6 pb-6 text-sm text-muted-foreground">
                  No completed pickups in this period. Try widening the dates.
                </p>
              ) : (
                <TableContainer>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Site</TableHead>
                        <TableHead numeric>Pickups</TableHead>
                        <TableHead numeric>m²</TableHead>
                        {capturesWeight && <TableHead numeric>Recovered</TableHead>}
                        <TableHead numeric>Bags</TableHead>
                        <TableHead numeric>Charges ex GST</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.data.rows.map((row) => (
                        <TableRow key={row.key}>
                          <TableCell>{row.label}</TableCell>
                          <TableCell numeric>{row.jobs}</TableCell>
                          <TableCell numeric>{row.areaM2.toLocaleString('en-AU')}</TableCell>
                          {capturesWeight && (
                            <TableCell numeric>
                              {row.weightKg === null ? '—' : formatWeight(row.weightKg)}
                            </TableCell>
                          )}
                          <TableCell numeric>{row.bags}</TableCell>
                          <TableCell numeric>{formatMoney(row.chargesExGst)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </CardContent>
          </Card>

          {!capturesWeight && (
            <Alert variant="info" title="Your account records square metres, not weight">
              We measure the board we collect in m². If you need recovered tonnage for ESG or Green
              Star reporting, we can switch your account to record weight at the tip as well — call
              the office on 1300 395 438.
            </Alert>
          )}
        </>
      )}
    </div>
  );
}
