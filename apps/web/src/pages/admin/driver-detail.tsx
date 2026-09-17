import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Skeleton,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTrigger,
} from '@plastago/ui';
import { useParams, useSearchParams } from 'react-router';
import { DetailList } from '@/components/detail-list';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { useDriverProfile } from '@/features/fleet/queries';
import { describeError } from '@/lib/error-message';
import { formatMobile } from '@/lib/format';

const TABS = ['profile', 'performance'] as const;
type TabKey = (typeof TABS)[number];

/**
 * One driver (M9.9 · F22).
 *
 * ── Why this screen is thinner than F53 described ─────────────────────────
 * Licences and training were dropped: nothing in the product could ever WRITE
 * them — no form, no endpoint — so the tabs could only render empty, and an
 * empty compliance register reads as "all clear" rather than "never recorded",
 * which is the more dangerous of the two. The same reasoning retired the device
 * and sync card: device registration is never captured, so "Last synced —" was a
 * permanent state rather than a reading.
 *
 * What is left is what the system genuinely knows: who they are, what they
 * drive, and what their jobs did.
 */
export function AdminDriverDetailPage() {
  const { driverId } = useParams();
  const [params, setParams] = useSearchParams();
  const { data: driver, error, isPending, refetch } = useDriverProfile(driverId);

  const rawTab = params.get('tab');
  const tab: TabKey = (TABS as readonly string[]).includes(rawTab ?? '')
    ? (rawTab as TabKey)
    : 'profile';

  const setTab = (next: string) => {
    setParams(
      (current) => {
        const nextParams = new URLSearchParams(current);
        if (next === 'profile') nextParams.delete('tab');
        else nextParams.set('tab', next);
        return nextParams;
      },
      { replace: true },
    );
  };

  const breadcrumbs = [{ label: 'Drivers', to: '/admin/drivers' }];

  if (error) {
    const described = describeError(error);
    return (
      <div className="space-y-6">
        <PageHeader title="Driver" breadcrumbs={breadcrumbs} />
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

  if (isPending || !driver) {
    return (
      <div className="space-y-6">
        <PageHeader title="Loading…" breadcrumbs={breadcrumbs} />
        <Card className="p-5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-4 h-40 w-full" />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={driver.name}
        breadcrumbs={breadcrumbs}
        description={`${formatMobile(driver.mobile)}${driver.vehicleLabel ? ` · ${driver.vehicleLabel}` : ''}`}
        badge={
          <Badge variant={driver.active ? 'success' : 'outline'}>
            {driver.active ? 'Active' : 'Inactive'}
          </Badge>
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList label="Driver sections">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="performance">Performance</TabsTrigger>
        </TabsList>

        {/* ── Profile ──────────────────────────────────────────────────── */}
        <TabsPanel value="profile">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              {/* Four facts, every one of them written by something the office
                  actually does: the user record, the vehicle assignment on the
                  fleet screen, and today's allocation. */}
              <DetailList
                columns={2}
                items={[
                  { label: 'Mobile', value: formatMobile(driver.mobile) },
                  { label: 'Email', value: driver.email ?? '—' },
                  {
                    label: 'Vehicle',
                    value:
                      driver.vehicleRego === null
                        ? 'Unassigned'
                        : `${driver.vehicleRego} · ${driver.vehicleLabel ?? ''}`,
                  },
                  {
                    label: 'Jobs today',
                    value: `${String(driver.jobsToday)} of ${String(driver.dailyJobCapacity)}`,
                  },
                ]}
              />
            </CardContent>
          </Card>
        </TabsPanel>

        {/* ── Performance ──────────────────────────────────────────────── */}
        <TabsPanel value="performance">
          <div className="space-y-4">
            {/*
              F22 is IN scope, but with two drivers this has to be framed
              correctly. Its real value is feeding the cost-per-km and
              job-duration models — saying so on the screen is part of the
              requirement, not a disclaimer.
            */}
            <Alert variant="neutral" title="Operational insight, not performance management">
              With two drivers these figures are a costing and planning input, drawn from what the
              jobs themselves recorded.
            </Alert>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label="Jobs completed"
                value={driver.performance.jobsCompleted}
                hint={`${String(driver.performance.jobsPerWorkingDay)} per working day`}
              />
              <StatCard
                label="Median time on site"
                value={
                  driver.performance.medianOnSiteMinutes === null
                    ? '—'
                    : `${String(driver.performance.medianOnSiteMinutes)} min`
                }
                hint="Arrived → Complete"
              />
              <StatCard
                label="Futile rate"
                value={`${String(driver.performance.futileRatePercent)}%`}
                hint={`${String(driver.performance.futileCount)} futile attendances`}
                tone={driver.performance.futileRatePercent > 8 ? 'attention' : 'default'}
              />
              <StatCard
                label="Contamination rate"
                value={`${String(driver.performance.contaminationRatePercent)}%`}
                hint={`${String(driver.performance.contaminationCount)} charges raised`}
              />
            </div>

            <Card>
              <CardHeader>
                <CardTitle>{driver.performance.periodLabel}</CardTitle>
              </CardHeader>
              <CardContent>
                <DetailList
                  columns={2}
                  items={[
                    {
                      label: 'Photo compliance',
                      value: `${String(driver.performance.photoCompliancePercent)}%`,
                    },
                    {
                      label: 'SLA adherence',
                      value: `${String(driver.performance.slaAdherencePercent)}%`,
                    },
                  ]}
                />
                <p className="mt-4 text-xs text-muted-foreground">
                  Photo compliance is the share of completed jobs carrying every required shot —
                  front of site, pile before, pile after, and site closed. SLA adherence is
                  collection on or before the job’s target date.
                </p>
              </CardContent>
            </Card>
          </div>
        </TabsPanel>
      </Tabs>
    </div>
  );
}
