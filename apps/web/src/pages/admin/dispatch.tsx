import { ZONE_LABELS, type MapPin, type RunSheet } from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  cn,
  DatePicker,
  EmptyState,
  ErrorState,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Select,
  Skeleton,
  Spinner,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTrigger,
  useToast,
} from '@plastago/ui';
import {
  MapIcon,
  MapPinIcon,
  MoreHorizontalIcon,
  NavigationIcon,
  PackageIcon,
  PhoneIcon,
  PrinterIcon,
  TruckIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AtRiskBadge, JobStatusBadge, UrgentBadge } from '@/components/domain-badges';
import { PageHeader } from '@/components/page-header';
import {
  useAllocationBoard,
  useAssignJob,
  useDrivers,
  useMapPins,
  useRunSheet,
  useUnassignJob,
} from '@/features/dispatch/queries';
import { describeError } from '@/lib/error-message';
import { formatArea, formatDate, formatMobile } from '@/lib/format';

const TABS = ['board', 'run-sheet', 'map'] as const;
type TabKey = (typeof TABS)[number];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Allocation & dispatch (M3).
 *
 * Three views of one day's work, sharing a date: the board (who gets what), the
 * run sheet (what a driver actually takes with them), and the map (where it all
 * is).
 *
 * ── Deliberately manual ────────────────────────────────────────────────────
 * There is no auto-assign and no route optimisation. Both are explicitly out of
 * scope, and with two active drivers and ~7 jobs a day manual allocation is
 * faster, safer and more transparent than a rules engine. The map exists for
 * *visual clustering to support a human decision* — six jobs in Oran Park and one
 * in Newcastle is 80% of the value at 5% of the cost — not to compute a route.
 */
export function AdminDispatchPage() {
  const [params, setParams] = useSearchParams();

  const date = params.get('date') ?? todayIso();
  const rawTab = params.get('tab');
  const tab: TabKey = (TABS as readonly string[]).includes(rawTab ?? '')
    ? (rawTab as TabKey)
    : 'board';

  const setParam = (name: string, value: string, clearDefault?: string) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (clearDefault !== undefined && value === clearDefault) next.delete(name);
        else next.set(name, value);
        return next;
      },
      { replace: true },
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dispatch"
        description="Allocate the day, produce the run sheets, and see where the work is."
        actions={
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Date</span>
            <DatePicker
              value={date}
              onChange={(event) => {
                setParam('date', event.target.value, todayIso());
              }}
              className="w-auto"
            />
          </label>
        }
      />

      <Tabs
        value={tab}
        onValueChange={(next) => {
          setParam('tab', next, 'board');
        }}
      >
        <TabsList label="Dispatch views">
          <TabsTrigger value="board">Allocation board</TabsTrigger>
          <TabsTrigger value="run-sheet">Run sheet</TabsTrigger>
          <TabsTrigger value="map">Map</TabsTrigger>
        </TabsList>

        <TabsPanel value="board">
          <AllocationBoardView date={date} />
        </TabsPanel>
        <TabsPanel value="run-sheet">
          <RunSheetView date={date} />
        </TabsPanel>
        <TabsPanel value="map">
          <MapView date={date} />
        </TabsPanel>
      </Tabs>
    </div>
  );
}

/* ── A. Allocation board ────────────────────────────────────────────────── */

function AllocationBoardView({ date }: { date: string }) {
  const toast = useToast();
  const { data, error, isPending, isFetching, refetch } = useAllocationBoard(date);
  const assign = useAssignJob();
  const unassign = useUnassignJob();

  const doAssign = async (
    jobId: string,
    jobNumber: number,
    driverId: string,
    driverName: string,
  ) => {
    try {
      await assign.mutateAsync({ jobId, driverId, date });
      toast.success(`Job #${String(jobNumber)} allocated`, `${driverName} · ${formatDate(date)}`);
    } catch (caught) {
      // Capacity is a real constraint, so this failure is expected and must be
      // explained rather than swallowed.
      const described = describeError(caught);
      toast.error('Could not allocate that job', described.detail ?? described.title);
    }
  };

  const doUnassign = async (jobId: string, jobNumber: number) => {
    try {
      await unassign.mutateAsync(jobId);
      toast.success(`Job #${String(jobNumber)} returned to unallocated`);
    } catch (caught) {
      const described = describeError(caught);
      toast.error('Could not unallocate that job', described.detail ?? described.title);
    }
  };

  if (error) {
    const described = describeError(error);
    return (
      <Card>
        <ErrorState
          title={described.title}
          description={described.detail}
          onRetry={() => void refetch()}
        />
      </Card>
    );
  }

  if (isPending || !data) {
    return (
      <div className="grid gap-4 lg:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <Card key={index} className="p-4">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="mt-3 h-20 w-full" />
            <Skeleton className="mt-2 h-20 w-full" />
          </Card>
        ))}
      </div>
    );
  }

  const drivers = data.drivers;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {data.unallocated.length === 0
            ? 'Everything for this day is allocated.'
            : `${String(data.unallocated.length)} job${data.unallocated.length === 1 ? '' : 's'} to allocate.`}
        </p>
        {isFetching && <Spinner label="Refreshing board" />}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Unallocated, ordered urgent → at-risk → soonest target date. */}
        <Card className="flex flex-col lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <PackageIcon aria-hidden className="size-4 text-muted-foreground" />
                Unallocated
              </span>
              <Badge variant={data.unallocated.length > 0 ? 'warning' : 'secondary'}>
                {data.unallocated.length}
              </Badge>
            </CardTitle>
          </CardHeader>

          <CardContent className="flex-1">
            {data.unallocated.length === 0 ? (
              <EmptyState
                title="Nothing waiting"
                description="Every job with this ready date has a driver."
              />
            ) : (
              <ul className="space-y-2">
                {data.unallocated.map((job) => (
                  <li
                    key={job.id}
                    className={cn(
                      'rounded-lg border p-3',
                      job.atRisk ? 'border-destructive/40 bg-destructive/5' : 'border-border',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Link
                          to={`/admin/jobs/${job.id}`}
                          className="focus-ring rounded font-mono text-sm font-medium text-primary underline-offset-4 hover:underline"
                        >
                          #{job.jobNumber}
                        </Link>
                        <p className="truncate text-sm font-medium">{job.accountName}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {job.siteName} · {job.suburb}
                        </p>
                      </div>

                      <Menu
                        align="end"
                        triggerLabel={`Allocate job ${String(job.jobNumber)}`}
                        triggerClassName="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        trigger={<MoreHorizontalIcon aria-hidden className="size-4" />}
                      >
                        <MenuLabel>Allocate to</MenuLabel>
                        {drivers.map((driver) => (
                          <MenuItem
                            key={driver.driverId}
                            icon={TruckIcon}
                            disabled={driver.assignedCount >= driver.capacity}
                            onSelect={() => {
                              void doAssign(
                                job.id,
                                job.jobNumber,
                                driver.driverId,
                                driver.driverName,
                              );
                            }}
                          >
                            {driver.driverName} ({driver.assignedCount}/{driver.capacity})
                          </MenuItem>
                        ))}
                      </Menu>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {job.serviceLevel === 'urgent' && <UrgentBadge />}
                      {job.atRisk && <AtRiskBadge label={`Target ${formatDate(job.targetDate)}`} />}
                      <Badge variant="outline">{formatArea(job.expectedAreaM2)}</Badge>
                      <Badge variant="secondary">{ZONE_LABELS[job.zone]}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* One column per driver. */}
        {drivers.map((driver) => {
          const full = driver.assignedCount >= driver.capacity;

          return (
            <Card key={driver.driverId} className="flex flex-col">
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <TruckIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{driver.driverName}</span>
                  </span>
                  <Badge variant={full ? 'warning' : 'secondary'}>
                    {driver.assignedCount}/{driver.capacity}
                  </Badge>
                </CardTitle>
                {/* M3.4 — a simple capacity indicator, not a scheduling engine. */}
                <div
                  aria-hidden
                  className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className={cn('h-full rounded-full', full ? 'bg-warning' : 'bg-brand-500')}
                    style={{
                      width: `${String(Math.min(100, (driver.assignedCount / driver.capacity) * 100))}%`,
                    }}
                  />
                </div>
              </CardHeader>

              <CardContent className="flex-1">
                {driver.jobs.length === 0 ? (
                  <EmptyState
                    title="No jobs yet"
                    description="Allocate from the unallocated column."
                  />
                ) : (
                  <ol className="space-y-2">
                    {driver.jobs.map((job) => (
                      <li
                        key={job.id}
                        className={cn(
                          'rounded-lg border p-3',
                          job.atRisk ? 'border-destructive/40' : 'border-border',
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="flex items-center gap-2">
                              <span className="grid size-5 shrink-0 place-items-center rounded bg-accent text-[10px] font-semibold text-accent-foreground">
                                {job.sequence}
                              </span>
                              <Link
                                to={`/admin/jobs/${job.id}`}
                                className="focus-ring rounded font-mono text-sm text-primary underline-offset-4 hover:underline"
                              >
                                #{job.jobNumber}
                              </Link>
                            </p>
                            <p className="mt-1 truncate text-sm font-medium">{job.accountName}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {job.siteName} · {job.suburb}
                            </p>
                          </div>

                          <Menu
                            align="end"
                            triggerLabel={`Change allocation for job ${String(job.jobNumber)}`}
                            triggerClassName="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            trigger={<MoreHorizontalIcon aria-hidden className="size-4" />}
                          >
                            <MenuLabel>Move to</MenuLabel>
                            {drivers
                              .filter((other) => other.driverId !== driver.driverId)
                              .map((other) => (
                                <MenuItem
                                  key={other.driverId}
                                  icon={TruckIcon}
                                  disabled={other.assignedCount >= other.capacity}
                                  onSelect={() => {
                                    void doAssign(
                                      job.id,
                                      job.jobNumber,
                                      other.driverId,
                                      other.driverName,
                                    );
                                  }}
                                >
                                  {other.driverName} ({other.assignedCount}/{other.capacity})
                                </MenuItem>
                              ))}
                            <MenuSeparator />
                            <MenuItem
                              tone="destructive"
                              onSelect={() => {
                                void doUnassign(job.id, job.jobNumber);
                              }}
                            >
                              Return to unallocated
                            </MenuItem>
                          </Menu>
                        </div>

                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <JobStatusBadge status={job.status} />
                          {job.serviceLevel === 'urgent' && <UrgentBadge />}
                          <Badge variant="outline">{formatArea(job.expectedAreaM2)}</Badge>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Alert variant="neutral" title="Allocation is a human decision">
        Jobs are ordered urgent first, then closest to breaching target date. Automatic assignment
        and route optimisation are both out of scope — with two drivers, a person clustering by
        suburb on the map is faster and easier to explain.
      </Alert>
    </div>
  );
}

/* ── B. Run sheet ───────────────────────────────────────────────────────── */

function RunSheetView({ date }: { date: string }) {
  const drivers = useDrivers();
  const active = (drivers.data ?? []).filter((driver) => driver.status !== 'off');
  const [driverId, setDriverId] = useState<string | null>(null);
  const selected = driverId ?? active[0]?.id ?? null;

  const { data, error, isPending, refetch } = useRunSheet(selected, date);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Driver</span>
          <Select
            value={selected ?? ''}
            onChange={(event) => {
              setDriverId(event.target.value);
            }}
            className="w-auto"
          >
            {active.map((driver) => (
              <option key={driver.id} value={driver.id}>
                {driver.name}
              </option>
            ))}
          </Select>
        </label>

        <Button
          variant="outline"
          onClick={() => {
            window.print();
          }}
          disabled={!data || data.stops.length === 0}
        >
          <PrinterIcon aria-hidden />
          Print run sheet
        </Button>
      </div>

      {error ? (
        <Card>
          <ErrorState
            title={describeError(error).title}
            description={describeError(error).detail}
            onRetry={() => void refetch()}
          />
        </Card>
      ) : isPending || !data ? (
        <Card className="p-5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-4 h-32 w-full" />
        </Card>
      ) : (
        <RunSheetCard runSheet={data} />
      )}
    </div>
  );
}

function RunSheetCard({ runSheet }: { runSheet: RunSheet }) {
  if (runSheet.stops.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={TruckIcon}
          title={`Nothing allocated to ${runSheet.driverName}`}
          description="Allocate jobs on the board and they appear here in order."
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span>
            {runSheet.driverName} · {formatDate(runSheet.date)}
          </span>
          <span className="flex flex-wrap items-center gap-2 text-sm font-normal text-muted-foreground">
            {runSheet.vehicleLabel && <Badge variant="outline">{runSheet.vehicleLabel}</Badge>}
            <Badge variant="secondary">
              {runSheet.stops.length} stop{runSheet.stops.length === 1 ? '' : 's'}
            </Badge>
            <Badge variant="secondary">{formatArea(runSheet.totalExpectedAreaM2)}</Badge>
            <Badge variant="secondary">{runSheet.totalBags} bags</Badge>
          </span>
        </CardTitle>
      </CardHeader>

      <CardContent>
        <ol className="divide-y divide-border">
          {runSheet.stops.map((stop) => (
            <li key={stop.id} className="py-4 first:pt-0 last:pb-0">
              <div className="flex gap-4">
                <span
                  aria-hidden
                  className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent font-display text-sm font-semibold text-accent-foreground"
                >
                  {stop.sequence}
                </span>

                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <Link
                      to={`/admin/jobs/${stop.id}`}
                      className="focus-ring rounded font-mono text-sm font-medium text-primary underline-offset-4 hover:underline"
                    >
                      #{stop.jobNumber}
                    </Link>
                    <span className="font-medium">{stop.accountName}</span>
                    <span className="text-sm text-muted-foreground">for {stop.builderName}</span>
                    <JobStatusBadge status={stop.status} />
                    {stop.serviceLevel === 'urgent' && <UrgentBadge />}
                  </div>

                  {/*
                    Lot number first, deliberately. In a half-built estate the
                    street number does not exist yet, and the lot is how the site
                    is actually identified on the ground.
                  */}
                  <p className="text-sm">
                    {stop.lotNumber && <span className="font-medium">Lot {stop.lotNumber} · </span>}
                    {stop.addressLine}, {stop.suburb}
                  </p>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>{formatArea(stop.expectedAreaM2)} expected</span>
                    {stop.bagCount > 0 && <span>{stop.bagCount} bags</span>}
                    {stop.customerReference && <span>Ref {stop.customerReference}</span>}
                    {stop.craneAvailable && <Badge variant="secondary">Crane</Badge>}
                    {stop.inductionRequired && <Badge variant="warning">Induction</Badge>}
                  </div>

                  {stop.accessNotes && (
                    <p className="rounded-md bg-muted px-2.5 py-1.5 text-xs">{stop.accessNotes}</p>
                  )}

                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    {stop.contactMobile && (
                      <a
                        href={`tel:${stop.contactMobile}`}
                        className="focus-ring inline-flex items-center gap-1.5 rounded text-primary underline-offset-4 hover:underline"
                      >
                        <PhoneIcon aria-hidden className="size-3.5" />
                        {stop.contactName ?? 'Site contact'} {formatMobile(stop.contactMobile)}
                      </a>
                    )}
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${String(stop.latitude)},${String(stop.longitude)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="focus-ring inline-flex items-center gap-1.5 rounded text-primary underline-offset-4 hover:underline"
                    >
                      <NavigationIcon aria-hidden className="size-3.5" />
                      Navigate
                    </a>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

/* ── C. Map ─────────────────────────────────────────────────────────────── */

function MapView({ date }: { date: string }) {
  const { data, error, isPending, refetch } = useMapPins(date);

  if (error) {
    const described = describeError(error);
    return (
      <Card>
        <ErrorState
          title={described.title}
          description={described.detail}
          onRetry={() => void refetch()}
        />
      </Card>
    );
  }

  if (isPending || !data) {
    return (
      <Card className="p-5">
        <Skeleton className="h-64 w-full" />
      </Card>
    );
  }

  if (data.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={MapIcon}
          title="Nothing to plot"
          description="No jobs with this ready date."
        />
      </Card>
    );
  }

  const byZone = new Map<string, MapPin[]>();
  for (const pin of data) {
    byZone.set(pin.zone, [...(byZone.get(pin.zone) ?? []), pin]);
  }

  return (
    <div className="space-y-4">
      <Alert variant="info" title="Geographic view">
        Plotted from each site’s confirmed pin. This is for <strong>visual clustering</strong> — six
        jobs in Oran Park and one in Newcastle tells the allocator what to do. It is not a computed
        route; route optimisation is out of scope.
      </Alert>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Job locations · {formatDate(date)}</CardTitle>
          </CardHeader>
          <CardContent>
            <PinScatter pins={data} />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>By zone</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {[...byZone.entries()].map(([zone, pins]) => (
              <div key={zone}>
                <p className="mb-1.5 flex items-center justify-between text-sm font-medium">
                  {ZONE_LABELS[zone as keyof typeof ZONE_LABELS]}
                  <Badge variant="secondary">{pins.length}</Badge>
                </p>
                <ul className="space-y-1">
                  {pins.map((pin) => (
                    <li key={pin.id} className="flex items-center gap-2 text-xs">
                      <MapPinIcon
                        aria-hidden
                        className={cn(
                          'size-3 shrink-0',
                          pin.atRisk ? 'text-destructive' : 'text-muted-foreground',
                        )}
                      />
                      <Link
                        to={`/admin/jobs/${pin.id}`}
                        className="focus-ring rounded font-mono text-primary underline-offset-4 hover:underline"
                      >
                        #{pin.jobNumber}
                      </Link>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {pin.suburb}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {pin.driverName ?? 'Unallocated'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * A plotted scatter of the day's pins.
 *
 * ── Why not a real map tile layer ──────────────────────────────────────────
 * Google Maps is the in-scope provider (I3) but it needs a key and a billed
 * account, and this build has no backend or credentials. Rendering a fake map
 * image would imply an integration that does not exist. So this plots the real
 * coordinates in a normalised space — the clustering is genuine, the geometry is
 * schematic — and it is replaced wholesale by the Maps component when the key
 * lands. Positions are latitude/longitude, so relative arrangement is correct.
 */
function PinScatter({ pins }: { pins: readonly MapPin[] }) {
  const lats = pins.map((pin) => pin.latitude);
  const lngs = pins.map((pin) => pin.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latSpan = maxLat - minLat || 1;
  const lngSpan = maxLng - minLng || 1;

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-muted/40">
      {/* Graticule, purely to give the eye a frame of reference. */}
      <svg aria-hidden className="absolute inset-0 size-full" preserveAspectRatio="none">
        {[20, 40, 60, 80].map((percent) => (
          <line
            key={`h${String(percent)}`}
            x1="0"
            y1={`${String(percent)}%`}
            x2="100%"
            y2={`${String(percent)}%`}
            stroke="var(--color-chart-grid)"
          />
        ))}
        {[20, 40, 60, 80].map((percent) => (
          <line
            key={`v${String(percent)}`}
            x1={`${String(percent)}%`}
            y1="0"
            x2={`${String(percent)}%`}
            y2="100%"
            stroke="var(--color-chart-grid)"
          />
        ))}
      </svg>

      <ul className="absolute inset-0">
        {pins.map((pin) => {
          // Latitude grows northward, so it is inverted for screen coordinates.
          const top = ((maxLat - pin.latitude) / latSpan) * 84 + 8;
          const left = ((pin.longitude - minLng) / lngSpan) * 84 + 8;

          return (
            <li
              key={pin.id}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ top: `${String(top)}%`, left: `${String(left)}%` }}
            >
              <Link
                to={`/admin/jobs/${pin.id}`}
                // The title is the tooltip for a mark with no room for a label.
                title={`#${String(pin.jobNumber)} · ${pin.accountName} · ${pin.suburb} · ${pin.driverName ?? 'Unallocated'}`}
                className={cn(
                  'focus-ring grid size-6 place-items-center rounded-full border-2 border-card text-[9px] font-semibold shadow-sm transition-transform hover:scale-125',
                  pin.atRisk
                    ? 'bg-destructive text-destructive-foreground'
                    : pin.driverName === null
                      ? 'bg-warning text-warning-foreground'
                      : 'bg-brand-600 text-white',
                )}
              >
                {pin.jobNumber % 100}
                <span className="sr-only">
                  Job {pin.jobNumber}, {pin.accountName}, {pin.suburb}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>

      <ul className="absolute bottom-2 left-2 flex flex-wrap gap-3 rounded-md bg-card/90 px-2 py-1 text-xs backdrop-blur">
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-full bg-brand-600" />
          Allocated
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-full bg-warning" />
          Unallocated
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-full bg-destructive" />
          At risk
        </li>
      </ul>
    </div>
  );
}
