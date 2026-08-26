import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Skeleton,
  Spinner,
} from '@plastago/ui';
import {
  BanknoteIcon,
  BriefcaseIcon,
  CircleSlashIcon,
  ClockIcon,
  GaugeIcon,
  RecycleIcon,
  TriangleAlertIcon,
  TruckIcon,
} from 'lucide-react';
import { Link } from 'react-router';
import {
  DailyVolumeChart,
  ExceptionRateChart,
  JobsByStatusChart,
} from '@/components/charts/job-charts';
import { PageHeader } from '@/components/page-header';
import { QueueCard } from '@/components/queue-card';
import { StatCard } from '@/components/stat-card';
import { useDashboardSummary } from '@/features/dashboard/queries';
import { describeError } from '@/lib/error-message';
import { useAuth } from '@/features/auth/auth-context';
import { formatMoney, formatRelative, formatTime } from '@/lib/format';
import { useNow } from '@/lib/use-now';

/**
 * Operations dashboard (M9.4 / F15).
 *
 * ── What this screen is for ────────────────────────────────────────────────
 * One question: *what needs a decision today?* So it is ordered by urgency of
 * action, not by data source — the counters that mean "go and do something" sit
 * at the top, the four queues that hold actual work come next, and the trends
 * that inform rather than demand are below the fold.
 *
 * ── The observability tiles are a requirement, not an extra ────────────────
 * Error tracking was removed from this project by decision (§6A.8). The stated
 * mitigation is that failures become visible *in the product*: a sync-failure
 * counter and last-successful-sync per driver device, plus dead-lettered
 * background jobs. With no vendor watching, this panel is the only place a stuck
 * offline queue surfaces before a driver rings the office.
 */
export function AdminDashboardPage() {
  const { can } = useAuth();
  const { data, error, isPending, isFetching, refetch } = useDashboardSummary();

  /*
   * ── What the Allocator's dashboard drops ──────────────────────────────────
   * The money tile, the money on each queue card, and the queues they cannot
   * work. What is left is the whole point of the screen for them: open jobs,
   * unallocated jobs, breaches, completions, exception rates, time on site and
   * driver sync health — every one of which is a logistics fact.
   */
  const seesPricing = can('pricing:view');
  // All four dashboard queue cards are the exception queues, so one check
  // covers them. A card linking to a screen the role gets a 403 on is worse
  // than no card — it promises work it will not let them do.
  const visibleQueues = can('queues:action') ? (data?.queues ?? []) : [];

  if (error && !data) {
    const described = describeError(error);
    return (
      <div className="space-y-6">
        <PageHeader title="Operations dashboard" />
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Operations dashboard"
        description="What is outstanding, what is about to breach, and what needs a decision today."
        badge={isFetching && data ? <Spinner label="Refreshing" /> : undefined}
        actions={
          data ? (
            <p className="text-xs text-muted-foreground">
              Updated {formatTime(data.generatedAt)} · refreshes every minute
            </p>
          ) : undefined
        }
      />

      {/* ── Act now ─────────────────────────────────────────────────────── */}
      <section aria-labelledby="today-heading" className="space-y-3">
        <h2 id="today-heading" className="text-sm font-semibold tracking-tight">
          Today
        </h2>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Open jobs"
            value={data?.openJobs ?? 0}
            hint="Booked through to on site"
            icon={BriefcaseIcon}
            to="/admin/jobs"
            isPending={isPending}
          />
          <StatCard
            label="Unallocated"
            value={data?.unallocatedJobs ?? 0}
            hint="No driver assigned yet"
            icon={TruckIcon}
            tone={(data?.unallocatedJobs ?? 0) > 0 ? 'attention' : 'default'}
            to="/admin/dispatch"
            isPending={isPending}
          />
          <StatCard
            label="At risk"
            value={data?.atRiskJobs ?? 0}
            hint="Past or nearing ready date + 5 business days"
            icon={TriangleAlertIcon}
            tone={(data?.atRiskJobs ?? 0) > 0 ? 'alert' : 'positive'}
            to="/admin/jobs?risk=at-risk"
            isPending={isPending}
          />
          <StatCard
            label="Completed today"
            value={data?.completedToday ?? 0}
            hint="Driver marked complete"
            icon={RecycleIcon}
            tone="positive"
            isPending={isPending}
          />
        </div>
      </section>

      {/* ── Queues ────────────────────────────────────────────────────────
          The whole section goes, heading and all, for a role that cannot work
          them. An empty "Queues" heading is worse than no heading: it tells the
          reader something exists that they are not being shown. */}
      {(isPending || visibleQueues.length > 0) && (
        <section aria-labelledby="queues-heading" className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="queues-heading" className="text-sm font-semibold tracking-tight">
              Queues
            </h2>
            <p className="text-xs text-muted-foreground">
              Each one holds work. The age of the oldest item is the thing to watch.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {isPending
              ? Array.from({ length: 4 }, (_, index) => (
                  <Card key={index} className="p-4">
                    <Skeleton className="h-8 w-16" />
                    <Skeleton className="mt-2 h-3 w-32" />
                  </Card>
                ))
              : visibleQueues.map((queue) => (
                  <QueueCard
                    key={queue.key}
                    label={queue.label}
                    count={queue.count}
                    oldestAt={queue.oldestAt}
                    // A queue's dollar figure is the argument for actioning it —
                    // and it is money, so it goes with the rest of the money.
                    valueExGst={seesPricing ? queue.valueExGst : null}
                    to={queue.href}
                  />
                ))}
          </div>
        </section>
      )}

      {/* ── Exceptions and finance ──────────────────────────────────────── */}
      <section aria-labelledby="commercial-heading" className="space-y-3">
        <h2 id="commercial-heading" className="text-sm font-semibold tracking-tight">
          This month
        </h2>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Futile pickups"
            value={data?.futileThisMonth ?? 0}
            // The rate is money. Shown to anyone who can see pricing, because
            // "3 × $120" is the argument for chasing the queue; dropped for the
            // Allocator, who gets the count and the rate without the dollars.
            hint={
              seesPricing
                ? `${String(data?.futileRatePercent ?? 0)}% of jobs · $120 each`
                : `${String(data?.futileRatePercent ?? 0)}% of jobs attempted`
            }
            icon={CircleSlashIcon}
            tone={(data?.futileRatePercent ?? 0) > 5 ? 'attention' : 'default'}
            to="/admin/jobs?status=futile"
            isPending={isPending}
          />
          <StatCard
            label="Contamination"
            value={data?.contaminationThisMonth ?? 0}
            hint={
              seesPricing
                ? `${String(data?.contaminationRatePercent ?? 0)}% of jobs · $90 each`
                : `${String(data?.contaminationRatePercent ?? 0)}% of jobs`
            }
            icon={TriangleAlertIcon}
            isPending={isPending}
          />
          {seesPricing && (
            <StatCard
              label="Invoiced"
              value={formatMoney(data?.invoicedThisMonthExGst)}
              hint={`ex GST · ${String(data?.overdueInvoiceCount ?? 0)} past 7-day terms`}
              icon={BanknoteIcon}
              tone={(data?.overdueInvoiceCount ?? 0) > 0 ? 'attention' : 'default'}
              isPending={isPending}
            />
          )}
          <StatCard
            label="Median time on site"
            value={
              data?.medianOnSiteMinutes === null || data?.medianOnSiteMinutes === undefined
                ? '—'
                : `${String(data.medianOnSiteMinutes)} min`
            }
            hint="Arrived → Complete, the basis of extra load time"
            icon={ClockIcon}
            isPending={isPending}
          />
        </div>
      </section>

      {/* ── Trends ──────────────────────────────────────────────────────── */}
      <section aria-labelledby="trends-heading" className="space-y-3">
        <h2 id="trends-heading" className="text-sm font-semibold tracking-tight">
          Trends
        </h2>

        {isPending ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="mt-4 h-52 w-full" />
            </Card>
            <Card className="p-5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="mt-4 h-52 w-full" />
            </Card>
          </div>
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-2">
              <DailyVolumeChart data={data?.dailyVolume ?? []} />
              <ExceptionRateChart data={data?.exceptionRates ?? []} />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <JobsByStatusChart data={data?.statusCounts ?? []} />
              <ActivityAndHealth
                driverHealth={data?.driverHealth ?? []}
                recentActivity={data?.recentActivity ?? []}
                failedBackgroundJobs={data?.failedBackgroundJobs ?? 0}
              />
            </div>
          </>
        )}
      </section>
    </div>
  );
}

type Summary = NonNullable<ReturnType<typeof useDashboardSummary>['data']>;

/**
 * Driver sync health and the activity feed.
 *
 * Paired on purpose: both answer "is anything quietly wrong?" — the first for
 * the offline apps, the second for anything a human did that you might have
 * missed. Together they are the §6A.8 substitute for an error-tracking vendor.
 */
function ActivityAndHealth({
  driverHealth,
  recentActivity,
  failedBackgroundJobs,
}: {
  driverHealth: Summary['driverHealth'];
  recentActivity: Summary['recentActivity'];
  failedBackgroundJobs: number;
}) {
  const now = useNow();
  const staleSync = driverHealth.filter(
    (driver) =>
      driver.pendingSyncActions > 0 ||
      (driver.lastSyncAt !== null && now - new Date(driver.lastSyncAt).getTime() > 3600_000),
  );

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GaugeIcon aria-hidden className="size-4 text-muted-foreground" />
          Drivers and activity
        </CardTitle>
      </CardHeader>

      <CardContent className="flex-1 space-y-4">
        {(staleSync.length > 0 || failedBackgroundJobs > 0) && (
          <Alert variant="warning" title="Something needs looking at">
            {staleSync.length > 0 && (
              <p>
                {staleSync.length === 1
                  ? 'One device has'
                  : `${String(staleSync.length)} devices have`}{' '}
                not synced recently or has actions queued.
              </p>
            )}
            {failedBackgroundJobs > 0 && (
              <p>{failedBackgroundJobs} background jobs failed and were dead-lettered.</p>
            )}
          </Alert>
        )}

        <ul className="space-y-2">
          {driverHealth.map((driver) => {
            const full = driver.jobsToday >= driver.capacity;
            return (
              <li key={driver.driverId} className="flex items-center gap-3 text-sm">
                <TruckIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-medium">{driver.driverName}</span>
                <span className="text-xs text-muted-foreground">
                  synced {formatRelative(driver.lastSyncAt)}
                </span>
                <Badge variant={full ? 'warning' : 'secondary'}>
                  {driver.jobsToday}/{driver.capacity}
                </Badge>
              </li>
            );
          })}
        </ul>

        <div className="border-t border-border pt-3">
          <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Recent activity
          </p>
          <ul className="max-h-56 space-y-2 overflow-y-auto pr-1">
            {recentActivity.map((entry) => (
              <li key={entry.id} className="text-sm">
                <div className="flex items-baseline gap-2">
                  {entry.jobNumber !== null && entry.jobId !== null ? (
                    <Link
                      to={`/admin/jobs/${entry.jobId}`}
                      className="focus-ring shrink-0 rounded font-mono text-xs font-medium text-primary underline-offset-4 hover:underline"
                    >
                      #{entry.jobNumber}
                    </Link>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {entry.summary}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {entry.actor} · {formatRelative(entry.at)}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
