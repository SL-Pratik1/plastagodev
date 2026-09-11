import { CREDENTIAL_TYPE_LABELS } from '@plastago/shared';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  Skeleton,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTrigger,
} from '@plastago/ui';
import { GraduationCapIcon, IdCardIcon } from 'lucide-react';
import { useParams, useSearchParams } from 'react-router';
import { DetailList } from '@/components/detail-list';
import { ExpiryBadge } from '@/components/domain-badges';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { useDriverProfile } from '@/features/fleet/queries';
import { describeError } from '@/lib/error-message';
import { formatDate, formatMobile, formatRelative } from '@/lib/format';

const TABS = ['profile', 'licence', 'training', 'performance'] as const;
type TabKey = (typeof TABS)[number];

/**
 * One driver (M9.8 · F53, M9.9 · F22).
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

  const problems = [
    ...driver.credentials.filter((credential) => credential.state !== 'valid'),
    ...driver.training.filter((record) => record.state !== 'valid'),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={driver.name}
        breadcrumbs={breadcrumbs}
        description={`${formatMobile(driver.mobile)}${driver.vehicleLabel ? ` · ${driver.vehicleLabel}` : ''}`}
        badge={
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge variant={driver.active ? 'success' : 'outline'}>
              {driver.active ? 'Active' : 'Inactive'}
            </Badge>
            <Badge variant="secondary">Subcontractor</Badge>
            <ExpiryBadge state={driver.nextExpiryState} />
          </span>
        }
      />

      {problems.length > 0 && (
        <Alert variant="warning" title="Credentials or training need attention">
          {problems
            .map((item) => ('type' in item ? CREDENTIAL_TYPE_LABELS[item.type] : item.name))
            .join(' · ')}
        </Alert>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList label="Driver sections">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="licence" badge={driver.credentials.length}>
            Licence
          </TabsTrigger>
          <TabsTrigger value="training" badge={driver.training.length}>
            Training
          </TabsTrigger>
          <TabsTrigger value="performance">Performance</TabsTrigger>
        </TabsList>

        {/* ── Profile ──────────────────────────────────────────────────── */}
        <TabsPanel value="profile">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Details</CardTitle>
              </CardHeader>
              <CardContent>
                <DetailList
                  columns={2}
                  items={[
                    { label: 'Mobile', value: formatMobile(driver.mobile) },
                    { label: 'Email', value: driver.email ?? '—' },
                    { label: 'Engagement', value: 'Subcontractor' },
                    { label: 'Started', value: formatDate(driver.startedOn) },
                    {
                      label: 'Vehicle',
                      value:
                        driver.vehicleRego === null
                          ? 'Unassigned'
                          : `${driver.vehicleRego} · ${driver.vehicleLabel ?? ''}`,
                    },
                    { label: 'Daily capacity', value: `${String(driver.dailyJobCapacity)} jobs` },
                    { label: 'Notes', value: driver.notes || '—', wide: true },
                  ]}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Device and sync</CardTitle>
              </CardHeader>
              <CardContent>
                {/* §6A.8 — with no error tracking, this is where a stuck offline
                    queue becomes visible before the driver rings the office. */}
                <DetailList
                  columns={1}
                  items={[
                    { label: 'Last synced', value: formatRelative(driver.lastSyncAt) },
                    {
                      label: 'Queued actions',
                      value:
                        driver.pendingSyncActions === 0 ? (
                          <Badge variant="success">In sync</Badge>
                        ) : (
                          <Badge variant="warning">{driver.pendingSyncActions} waiting</Badge>
                        ),
                    },
                    {
                      label: 'Jobs today',
                      value: `${String(driver.jobsToday)} of ${String(driver.dailyJobCapacity)}`,
                    },
                  ]}
                />
              </CardContent>
            </Card>
          </div>
        </TabsPanel>

        {/* ── Licence ──────────────────────────────────────────────────── */}
        <TabsPanel value="licence">
          <Card>
            <CardHeader>
              <CardTitle>Licences and tickets</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-border">
                {driver.credentials.map((credential) => (
                  <li key={credential.id} className="flex flex-wrap items-center gap-3 py-3">
                    <IdCardIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {CREDENTIAL_TYPE_LABELS[credential.type]}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {credential.reference ?? 'No reference'} · issued{' '}
                        {formatDate(credential.issuedOn)} · expires{' '}
                        {formatDate(credential.expiresOn)}
                      </p>
                    </div>
                    {/* F53 names a licence PHOTO specifically. */}
                    <Badge variant={credential.hasDocument ? 'secondary' : 'outline'}>
                      {credential.hasDocument ? 'Document on file' : 'No document'}
                    </Badge>
                    <ExpiryBadge state={credential.state} />
                  </li>
                ))}
              </ul>

              <Alert variant="info" title="Why expiry is tracked here" className="mt-4">
                Chain of Responsibility under the Heavy Vehicle National Law makes licence currency
                an operator obligation, not just the driver’s — so an expiring ticket is the
                office’s problem before it is theirs.
              </Alert>
            </CardContent>
          </Card>
        </TabsPanel>

        {/* ── Training ─────────────────────────────────────────────────── */}
        <TabsPanel value="training">
          <Card>
            <CardHeader>
              <CardTitle>Training records</CardTitle>
            </CardHeader>
            <CardContent>
              {driver.training.length === 0 ? (
                <EmptyState
                  icon={GraduationCapIcon}
                  title="No training recorded"
                  description="Completed courses and their expiry appear here."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {driver.training.map((record) => (
                    <li key={record.id} className="flex flex-wrap items-center gap-3 py-3">
                      <GraduationCapIcon
                        aria-hidden
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{record.name}</p>
                        <p className="text-xs text-muted-foreground">
                          Completed {formatDate(record.completedOn)}
                          {record.provider ? ` · ${record.provider}` : ''}
                          {record.expiresOn ? ` · expires ${formatDate(record.expiresOn)}` : ''}
                        </p>
                      </div>
                      <ExpiryBadge state={record.state} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsPanel>

        {/* ── Performance ──────────────────────────────────────────────── */}
        <TabsPanel value="performance">
          <div className="space-y-4">
            {/*
              F22 is IN scope, but with two drivers this has to be framed
              correctly. Its real value is feeding the cost-per-km and job-duration
              models — saying so on the screen is part of the requirement, not a
              disclaimer.
            */}
            <Alert variant="neutral" title="Operational insight, not performance management">
              With two drivers these figures are a costing and planning input. Distance and drive
              time are measurable because the driver app captures continuous location.
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
                  columns={3}
                  items={[
                    {
                      label: 'Photo compliance',
                      value: `${String(driver.performance.photoCompliancePercent)}%`,
                    },
                    {
                      label: 'SLA adherence',
                      value: `${String(driver.performance.slaAdherencePercent)}%`,
                    },
                    {
                      label: 'Distance travelled',
                      value:
                        driver.performance.distanceKm === null
                          ? '—'
                          : `${driver.performance.distanceKm.toLocaleString('en-AU')} km`,
                    },
                  ]}
                />
                <p className="mt-4 text-xs text-muted-foreground">
                  Photo compliance is the share of completed jobs with at least eight photos,
                  against their protocol of front of site, pile before, pile after, site closed, and
                  cars on site where it could not be closed. SLA adherence is collection on or
                  before the customer’s ready date plus five business days.
                </p>
              </CardContent>
            </Card>
          </div>
        </TabsPanel>
      </Tabs>
    </div>
  );
}
