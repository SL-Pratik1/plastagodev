import {
  RUN_STATUS_LABELS,
  type AllocationBoard,
  type MapPin,
  type Run,
  type RunSheet,
  type UnallocatedJob,
} from '@plastago/shared';
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
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
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
  type BadgeProps,
} from '@plastago/ui';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  MapIcon,
  MapPinIcon,
  MoreHorizontalIcon,
  NavigationIcon,
  PackageIcon,
  PhoneIcon,
  PlusIcon,
  PrinterIcon,
  RouteIcon,
  TruckIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AtRiskBadge, JobStatusBadge, UrgentBadge } from '@/components/domain-badges';
import { PageHeader } from '@/components/page-header';
import {
  useAddJobToRun,
  useAllocationBoard,
  useAssignRun,
  useCreateRun,
  useDeleteRun,
  useMapPins,
  useOptimiseRun,
  useRemoveJobFromRun,
  useRunSheet,
  useUnassignRun,
} from '@/features/dispatch/queries';
import { describeError } from '@/lib/error-message';
import { formatArea, formatDate, formatDateTime, formatMobile } from '@/lib/format';

const TABS = ['board', 'run-sheet', 'map'] as const;
type TabKey = (typeof TABS)[number];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const RUN_STATUS_VARIANT: Record<Run['status'], BadgeProps['variant']> = {
  planning: 'outline',
  assigned: 'secondary',
  'in-progress': 'default',
  'tipped-off': 'success',
  closed: 'secondary',
};

/**
 * Can this run still take a stop on or off?
 *
 * The mirror of `MUTABLE_STATUS` in `dispatch.service.ts`: **only `planning`.**
 * Once a driver has the run on his phone, changing its contents underneath him
 * is how a stop gets missed, so the API refuses it and the allocator unassigns
 * first — a deliberate speed bump.
 *
 * ⚠️ The board used to allow `assigned` here, which made every "Add to run" on a
 * staffed run a guaranteed 409. Keep this function and `MUTABLE_STATUS` in step:
 * an offer the server always refuses is worse than no offer, because the
 * allocator cannot tell it apart from a system that is broken.
 */
function acceptsStops(run: Run): boolean {
  return run.status === 'planning';
}

/** Why a run is closed to stop changes, in the words the allocator needs. */
function closedToStopsReason(run: Run): string {
  return run.status === 'assigned'
    ? 'take the driver off first'
    : `${RUN_STATUS_LABELS[run.status].toLowerCase()} — stops are fixed`;
}

/**
 * Allocation & dispatch (M3).
 *
 * Three views of one day's work, sharing a date: the board (which runs exist and
 * who is on them), the run sheet (what a driver takes with them), and the map
 * (where it all is).
 *
 * ── The board allocates RUNS, not jobs ─────────────────────────────────────
 * Matt, 39:41: *"I create a run and we are able to add jobs to that run… assign
 * that whole run to a driver rather than assigning jobs to the driver."*
 *
 * So this screen is a run *builder* first and an assignment board second, in
 * that order — the allocator shapes the day, then staffs it (44:50). Jobs are
 * offered grouped by suburb because that is how a run gets assembled: *"you
 * might have Kellyville, Box Hill — four or five suburbs close together, you'll
 * put them on one run"* (41:17).
 *
 * ── What is still a human decision ─────────────────────────────────────────
 * Which jobs belong together. Google Route Optimization orders the stops inside
 * a run once it exists (I11), but it has no view on whether a builder will
 * complain about a Thursday, and the allocator does.
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
        description="Build the day into runs, put a driver on each, and see where the work is."
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
          <TabsTrigger value="board">Runs</TabsTrigger>
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

/* ── A. The run board ───────────────────────────────────────────────────── */

function AllocationBoardView({ date }: { date: string }) {
  const toast = useToast();
  const { data, error, isPending, isFetching, refetch } = useAllocationBoard(date);

  const createRun = useCreateRun();
  const addJob = useAddJobToRun();
  const [creating, setCreating] = useState(false);
  /** Set when "New run" was opened from a job card, so it seeds with that job. */
  const [seedJob, setSeedJob] = useState<UnallocatedJob | null>(null);

  const doAddJob = async (runId: string, runName: string, job: UnallocatedJob) => {
    try {
      await addJob.mutateAsync({ runId, jobId: job.id });
      toast.success(`Job #${String(job.jobNumber)} added to ${runName}`);
    } catch (caught) {
      // Capacity and double-booking are real constraints, so these failures are
      // expected and have to be explained rather than swallowed.
      const described = describeError(caught);
      toast.error('Could not add that job', described.detail ?? described.title);
    }
  };

  const doCreateRun = async (name: string, driverId: string | null) => {
    const jobIds = seedJob ? [seedJob.id] : [];
    try {
      const run = await createRun.mutateAsync({ name, date, driverId, jobIds });
      toast.success(`${run.name} created`, seedJob ? `Job #${String(seedJob.jobNumber)} added` : undefined);
      setCreating(false);
      setSeedJob(null);
    } catch (caught) {
      const described = describeError(caught);
      toast.error('Could not create that run', described.detail ?? described.title);
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
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {data.runs.length === 0
            ? 'No runs yet for this day.'
            : `${String(data.runs.length)} run${data.runs.length === 1 ? '' : 's'}`}
          {data.unallocated.length > 0 &&
            ` · ${String(data.unallocated.length)} job${data.unallocated.length === 1 ? '' : 's'} still to place`}
        </p>
        <div className="flex items-center gap-3">
          {isFetching && <Spinner label="Refreshing board" />}
          <Button
            onClick={() => {
              setSeedJob(null);
              setCreating(true);
            }}
          >
            <PlusIcon aria-hidden />
            New run
          </Button>
        </div>
      </div>

      {/*
        `grid-cols-1` rather than relying on the implicit single column.

        The implicit column is `auto`-sized and its items keep `min-width: auto`,
        so below `lg` the board sized itself to the longest site name on it and
        the page scrolled sideways on a phone. Tailwind's `grid-cols-1` is
        `minmax(0, 1fr)`, which lets the column win and the cards wrap.
      */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <UnallocatedColumn
          board={data}
          onAddToRun={(runId, runName, job) => void doAddJob(runId, runName, job)}
          onNewRunWith={(job) => {
            setSeedJob(job);
            setCreating(true);
          }}
        />

        <div className="space-y-4 lg:col-span-2">
          {data.runs.length === 0 ? (
            <Card>
              <EmptyState
                icon={RouteIcon}
                title="No runs for this day"
                description="Create a run, drop the jobs for one area onto it, then put a driver on the whole run."
                action={
                  <Button
                    onClick={() => {
                      setSeedJob(null);
                      setCreating(true);
                    }}
                  >
                    <PlusIcon aria-hidden />
                    New run
                  </Button>
                }
              />
            </Card>
          ) : (
            data.runs.map((run) => <RunCard key={run.id} run={run} board={data} />)
          )}
        </div>
      </div>

      <Alert variant="neutral" title="A run is the unit of work">
        Jobs go onto a run, and the <strong>run</strong> goes to a driver — a driver often takes two
        in a day, tipping off between them. The weighbridge docket is recorded against the run, which
        is what makes per-job weights reconcilable afterwards.
      </Alert>

      <NewRunDialog
        open={creating}
        date={date}
        drivers={data.drivers}
        seedJob={seedJob}
        pending={createRun.isPending}
        onClose={() => {
          setCreating(false);
          setSeedJob(null);
        }}
        onCreate={(name, driverId) => void doCreateRun(name, driverId)}
      />
    </div>
  );
}

/**
 * Jobs waiting to be placed, bucketed by suburb.
 *
 * Suburb is the heading rather than a line of detail because it is what the
 * allocator groups on (Matt, 41:17). A flat list forces them to hold the
 * geography in their head; this puts "Kellyville — 3 jobs" on screen and lets
 * them build that run in one pass.
 */
function UnallocatedColumn({
  board,
  onAddToRun,
  onNewRunWith,
}: {
  board: AllocationBoard;
  onAddToRun: (runId: string, runName: string, job: UnallocatedJob) => void;
  onNewRunWith: (job: UnallocatedJob) => void;
}) {
  // Every bucket open by default: an allocator planning a day wants to see the
  // whole board, and collapsing is for getting a long one out of the way.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const toggle = (suburb: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(suburb)) next.delete(suburb);
      else next.add(suburb);
      return next;
    });
  };

  return (
    <Card className="flex flex-col lg:col-span-1">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <PackageIcon aria-hidden className="size-4 text-muted-foreground" />
            To place
          </span>
          <Badge variant={board.unallocated.length > 0 ? 'warning' : 'secondary'}>
            {board.unallocated.length}
          </Badge>
        </CardTitle>
      </CardHeader>

      <CardContent className="flex-1">
        {board.unallocatedBySuburb.length === 0 ? (
          <EmptyState
            title="Nothing waiting"
            description="Every job with this ready date is on a run."
          />
        ) : (
          <div className="space-y-4">
            {board.unallocatedBySuburb.map((bucket) => {
              const isCollapsed = collapsed.has(bucket.suburb);

              return (
                <section key={bucket.suburb}>
                  <button
                    type="button"
                    onClick={() => {
                      toggle(bucket.suburb);
                    }}
                    aria-expanded={!isCollapsed}
                    className="focus-ring flex w-full items-center justify-between gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-muted"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {isCollapsed ? (
                        <ChevronDownIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronUpIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate font-display text-sm font-semibold">
                        {bucket.suburb}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {bucket.atRiskCount > 0 && (
                        <Badge variant="destructive">{bucket.atRiskCount} at risk</Badge>
                      )}
                      <Badge variant="secondary">{bucket.jobs.length}</Badge>
                    </span>
                  </button>

                  {!isCollapsed && (
                    <ul className="mt-2 space-y-2">
                      {bucket.jobs.map((job) => (
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
                                {job.siteName}
                              </p>
                            </div>

                            <Menu
                              align="end"
                              triggerLabel={`Place job ${String(job.jobNumber)} on a run`}
                              triggerClassName="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                              trigger={<MoreHorizontalIcon aria-hidden className="size-4" />}
                            >
                              <MenuLabel>Add to run</MenuLabel>
                              {board.runs.map((run) => (
                                <MenuItem
                                  key={run.id}
                                  icon={RouteIcon}
                                  disabled={!acceptsStops(run)}
                                  onSelect={() => {
                                    onAddToRun(run.id, run.name, job);
                                  }}
                                >
                                  {run.name} ({run.stops.length})
                                  {!acceptsStops(run) && (
                                    <span className="text-muted-foreground">
                                      {' '}· {closedToStopsReason(run)}
                                    </span>
                                  )}
                                </MenuItem>
                              ))}
                              {board.runs.length > 0 && <MenuSeparator />}
                              <MenuItem
                                icon={PlusIcon}
                                onSelect={() => {
                                  onNewRunWith(job);
                                }}
                              >
                                New run with this job
                              </MenuItem>
                            </Menu>
                          </div>

                          {/*
                            Ready date earns its place here on Matt's own note
                            (45:46) — the allocator groups by what is ready in a
                            window, not by what exists.
                          */}
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            {job.serviceLevel === 'urgent' && <UrgentBadge />}
                            {job.atRisk && (
                              <AtRiskBadge label={`Target ${formatDate(job.targetDate)}`} />
                            )}
                            <Badge variant="outline">Ready {formatDate(job.readyDate)}</Badge>
                            <Badge variant="outline">{formatArea(job.expectedAreaM2)}</Badge>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** One run: its stops, who is on it, and the two actions that change either. */
function RunCard({ run, board }: { run: Run; board: AllocationBoard }) {
  const toast = useToast();
  const assignRun = useAssignRun();
  const unassignRun = useUnassignRun();
  const removeJob = useRemoveJobFromRun();
  const deleteRun = useDeleteRun();
  const optimise = useOptimiseRun();

  /*
   * ⚠️ Each action is gated by the rule the API enforces for THAT action, not
   * by one shared "editable" flag.
   *
   * There used to be one — `planning || assigned` — and it was wrong for every
   * action it guarded, because the API draws the line in a different place each
   * time: stops and deletion need `planning` (`assertPlanning`, `deleteRun`),
   * assigning a driver needs `planning`, and taking one off needs `assigned`.
   * A single flag cannot express that, so the board offered work the server
   * refuses and the allocator met a toast instead of a disabled item.
   */
  const planning = run.status === 'planning';
  const staffed = run.status === 'assigned';

  const guard = async (action: () => Promise<unknown>, failure: string) => {
    try {
      await action();
    } catch (caught) {
      const described = describeError(caught);
      toast.error(failure, described.detail ?? described.title);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-start justify-between gap-2">
          <span className="flex min-w-0 flex-col gap-1">
            <span className="flex min-w-0 items-center gap-2">
              <RouteIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{run.name}</span>
              <Badge variant={RUN_STATUS_VARIANT[run.status]}>
                {RUN_STATUS_LABELS[run.status]}
              </Badge>
            </span>
            {/* Suburbs, not job names, describe a run at a glance. */}
            <span className="flex flex-wrap items-center gap-1 text-xs font-normal text-muted-foreground">
              {run.suburbs.length === 0 ? 'No stops yet' : run.suburbs.join(' → ')}
            </span>
          </span>

          <span className="flex shrink-0 items-center gap-1.5">
            <Badge variant="secondary">
              {run.stops.length} stop{run.stops.length === 1 ? '' : 's'}
            </Badge>
            <Badge variant="secondary">{formatArea(run.totalExpectedAreaM2)}</Badge>

            <Menu
              align="end"
              triggerLabel={`Actions for ${run.name}`}
              triggerClassName="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              trigger={<MoreHorizontalIcon aria-hidden className="size-4" />}
            >
              <MenuLabel>Driver</MenuLabel>
              {board.drivers.map((driver) => (
                <MenuItem
                  key={driver.driverId}
                  icon={TruckIcon}
                  /*
                   * A driver who is not working is shown and disabled, not
                   * hidden: the board is also how the allocator sees who is off
                   * today, and somebody who vanishes from the list reads as a
                   * bug to whoever was expecting them. The API refuses this
                   * assignment too — a disabled item is a courtesy, not a
                   * boundary.
                   */
                  disabled={
                    driver.driverId === run.driverId || !planning || driver.status === 'off'
                  }
                  onSelect={() => {
                    void guard(
                      () =>
                        assignRun
                          .mutateAsync({ runId: run.id, driverId: driver.driverId })
                          .then(() => {
                            toast.success(`${run.name} → ${driver.driverName}`);
                          }),
                      'Could not assign that run',
                    );
                  }}
                >
                  {driver.driverName}{' '}
                  {driver.status === 'off'
                    ? '(not working)'
                    : `(${String(driver.assignedCount)}/${String(driver.capacity)})`}
                </MenuItem>
              ))}

              <MenuSeparator />
              <MenuItem
                icon={RouteIcon}
                // Reordering rewrites every stop's sequence, so it is a change
                // to the run's contents and carries the same `planning` guard.
                disabled={run.stops.length < 2 || !planning}
                onSelect={() => {
                  void guard(
                    () =>
                      optimise.mutateAsync(run.id).then((updated) => {
                        /*
                         * ⚠️ The two outcomes are told apart, because they are
                         * not the same thing. A real route sets `optimisedAt`;
                         * without it the server grouped the stops by suburb —
                         * which happens when a stop is still pinned to its
                         * suburb's centre, or Google could not be reached.
                         *
                         * Saying "reordered by Google" either way is how an
                         * allocator comes to trust a sequence nobody computed,
                         * and a driver then follows it.
                         */
                        if (updated.optimisedAt !== null) {
                          toast.success('Route optimised', `${run.name} reordered by Google`);
                          return;
                        }

                        /*
                         * The fallback names the stops that caused it.
                         *
                         * It used to say only "its stops need exact addresses",
                         * which states the rule and withholds the one fact the
                         * allocator needs: WHICH stop. With three stops that is
                         * a guessing game; with twelve the run is simply stuck,
                         * and the honest grouping reads as a broken button.
                         *
                         * `optimiseRun` refuses on ANY stop pinned to a suburb
                         * centre, so every offender is worth naming — capped at
                         * three so a whole unrouted run does not fill the
                         * screen, with a count for the rest.
                         */
                        const pinned = updated.stops.filter(
                          (stop) => stop.locationSource !== 'geocoded',
                        );
                        const named = pinned
                          .slice(0, 3)
                          .map((stop) => `#${String(stop.jobNumber)} ${stop.suburb}`)
                          .join(', ');
                        const rest = pinned.length - Math.min(pinned.length, 3);

                        toast.info(
                          'Grouped by suburb',
                          pinned.length === 0
                            ? /*
                               * No offending stop, so the address pins were not
                               * the reason — Google was unreachable or returned
                               * nothing usable. Saying "needs exact addresses"
                               * here would send the allocator to edit addresses
                               * that are already fine.
                               */
                              `${run.name} was tidied, but Google did not return a route. Try again shortly.`
                            : `${run.name} was tidied, but ${named}${
                                rest > 0 ? ` and ${String(rest)} more` : ''
                              } ${pinned.length === 1 ? 'sits' : 'sit'} on a suburb pin, not a street address — so no route was calculated.`,
                        );
                      }),
                    'Could not optimise that run',
                  );
                }}
              >
                Optimise route
              </MenuItem>

              {run.driverId !== null && (
                <MenuItem
                  // The one action that needs `assigned` rather than
                  // `planning`: a run already on the road cannot be handed back.
                  disabled={!staffed}
                  onSelect={() => {
                    void guard(
                      () =>
                        unassignRun.mutateAsync(run.id).then(() => {
                          toast.success(`${run.name} is back in planning`);
                        }),
                      'Could not take that run off the driver',
                    );
                  }}
                >
                  Take off driver
                </MenuItem>
              )}

              <MenuSeparator />
              <MenuItem
                tone="destructive"
                disabled={!planning}
                onSelect={() => {
                  void guard(
                    () =>
                      deleteRun.mutateAsync(run.id).then(() => {
                        toast.success(`${run.name} deleted`, 'Its jobs went back to the list');
                      }),
                    'Could not delete that run',
                  );
                }}
              >
                Delete run
              </MenuItem>
            </Menu>
          </span>
        </CardTitle>

        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          {run.driverName === null ? (
            <Badge variant="warning">No driver yet</Badge>
          ) : (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <TruckIcon aria-hidden className="size-3.5" />
              {run.driverName}
              {run.sequenceForDay !== null && (
                <Badge variant="outline">Run {run.sequenceForDay} of the day</Badge>
              )}
            </span>
          )}
          {run.optimisedAt !== null && (
            <Badge variant="outline">Route optimised {formatDateTime(run.optimisedAt)}</Badge>
          )}
          {/* The docket belongs to the run — this is the figure weights divide. */}
          {run.tipOff !== null && (
            <Badge variant="success">
              Tipped off {run.tipOff.netKg.toLocaleString('en-AU')} kg
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent>
        {run.stops.length === 0 ? (
          <EmptyState title="No stops yet" description="Add jobs from the list on the left." />
        ) : (
          <ol className="space-y-2">
            {run.stops.map((stop, index) => (
              <li key={stop.id}>
                {/*
                  A suburb heading whenever the run crosses into a new one.
                  Runs are built by area — *"you might have Kellyville, Box Hill,
                  four or five suburbs close together, you'll put them on one
                  run"* (Matt, 41:17) — so once the route is ordered, the point
                  at which the suburb changes is the shape of the driver's day.
                  Only rendered on change: a heading above every stop on a
                  single-suburb run is noise.
                */}
                {run.stops[index - 1]?.suburb !== stop.suburb && (
                  <p className="mt-3 mb-1.5 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase first:mt-0">
                    <MapPinIcon aria-hidden className="size-3" />
                    {stop.suburb}
                  </p>
                )}
                <div
                  className={cn(
                    'flex items-start justify-between gap-2 rounded-lg border p-3',
                    stop.atRisk ? 'border-destructive/40' : 'border-border',
                  )}
                >
                <div className="min-w-0">
                  <p className="flex items-center gap-2">
                    <span className="grid size-5 shrink-0 place-items-center rounded bg-accent text-[10px] font-semibold text-accent-foreground">
                      {stop.sequence}
                    </span>
                    <Link
                      to={`/admin/jobs/${stop.id}`}
                      className="focus-ring rounded font-mono text-sm text-primary underline-offset-4 hover:underline"
                    >
                      #{stop.jobNumber}
                    </Link>
                    <span className="truncate text-sm font-medium">{stop.accountName}</span>
                  </p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {stop.siteName} · {stop.suburb}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <JobStatusBadge status={stop.status} />
                    {stop.serviceLevel === 'urgent' && <UrgentBadge />}
                    <Badge variant="outline">Ready {formatDate(stop.readyDate)}</Badge>
                    <Badge variant="outline">{formatArea(stop.expectedAreaM2)}</Badge>
                    {/*
                      ⚠️ Why a stop says so on the card, not just in a toast.

                      `optimiseRun` refuses to route a run in which ANY stop is
                      pinned to its suburb's centre rather than a real address.
                      The refusal used to arrive as one sentence that named no
                      stop — "its stops need exact addresses" — so the allocator
                      knew the run would not route and had no way to find out
                      which card was the reason, or that a card was the reason
                      at all. Marked here, it is visible BEFORE they try.
                    */}
                    {stop.locationSource !== 'geocoded' && (
                      <Badge
                        variant="warning"
                        title="This stop sits on the centre of its suburb, not a street address. Google cannot route a run that contains one."
                      >
                        <MapPinIcon aria-hidden className="size-3" />
                        Suburb pin only
                      </Badge>
                    )}
                  </div>
                </div>

                <Menu
                  align="end"
                  triggerLabel={`Actions for job ${String(stop.jobNumber)}`}
                  triggerClassName="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  trigger={<MoreHorizontalIcon aria-hidden className="size-4" />}
                >
                  <MenuLabel>Move to</MenuLabel>
                  {board.runs
                    .filter((other) => other.id !== run.id)
                    .map((other) => (
                      <MenuItem
                        key={other.id}
                        icon={RouteIcon}
                        /*
                         * Both ends have to be open. This item only calls
                         * `removeJobFromRun` — it takes the stop off THIS run
                         * and leaves the allocator to place it on the other —
                         * so the removal needs this run in `planning`, and
                         * offering a destination that cannot then accept it
                         * would strand the job in the "to place" column.
                         *
                         * Ungated, this was the same guaranteed 409 as
                         * "Add to run".
                         */
                        disabled={!planning || !acceptsStops(other)}
                        onSelect={() => {
                          void guard(
                            () =>
                              removeJob
                                .mutateAsync({ runId: run.id, jobId: stop.id })
                                .then(() => {
                                  toast.success(`Moved off ${run.name}`, `Add it to ${other.name}`);
                                }),
                            'Could not move that job',
                          );
                        }}
                      >
                        {other.name}
                      </MenuItem>
                    ))}
                  <MenuSeparator />
                  <MenuItem
                    tone="destructive"
                    disabled={!planning}
                    onSelect={() => {
                      void guard(
                        () =>
                          removeJob.mutateAsync({ runId: run.id, jobId: stop.id }).then(() => {
                            toast.success(`Job #${String(stop.jobNumber)} taken off ${run.name}`);
                          }),
                        'Could not take that job off the run',
                      );
                    }}
                  >
                    Take off this run
                  </MenuItem>
                </Menu>
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Creating a run.
 *
 * The driver is optional here on purpose. Matt builds the shape of the day
 * before he knows who is driving it (44:50), and forcing a driver at creation
 * would make the allocator invent one and correct it later.
 */
function NewRunDialog({
  open,
  date,
  drivers,
  seedJob,
  pending,
  onClose,
  onCreate,
}: {
  open: boolean;
  date: string;
  drivers: AllocationBoard['drivers'];
  seedJob: UnallocatedJob | null;
  pending: boolean;
  onClose: () => void;
  onCreate: (name: string, driverId: string | null) => void;
}) {
  // Seeded from the job that opened the dialog: naming a run after the suburb
  // it serves is what Matt actually does ("Newcastle run 1").
  //
  // The suggestion is written into state *once*, when the dialog opens,
  // rather than applied as a fallback on every render. As a fallback
  // (`name || suggested`) an empty field is impossible: clearing the box
  // back to '' simply puts the suggestion straight back, so the allocator
  // can never backspace it away.
  const [name, setName] = useState('');
  const [driverId, setDriverId] = useState('');
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      setName(seedJob ? `${seedJob.suburb} run 1` : '');
      setDriverId('');
    }
    wasOpen.current = open;
  }, [open, seedJob]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New run"
      description={`${formatDate(date)}${seedJob ? ` · starting with job #${String(seedJob.jobNumber)}` : ''}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onCreate(name, driverId || null);
            }}
            disabled={pending || name.trim().length === 0}
          >
            {pending ? <Spinner label="Creating" /> : 'Create run'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          id="run-name"
          label="Run name"
          hint="Drivers and dispatch both call it by name — the area plus which trip of the day."
        >
          {(control) => (
            <Input
              {...control}
              value={name}
              placeholder="Newcastle run 1"
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Field>

        <Field id="run-driver" label="Driver" hint="Optional — a run can be built before it is staffed.">
          {(control) => (
            <Select
              {...control}
              value={driverId}
              onChange={(event) => {
                setDriverId(event.target.value);
              }}
            >
              <option value="">Leave unassigned</option>
              {drivers.map((driver) => (
                <option key={driver.driverId} value={driver.driverId}>
                  {driver.driverName} ({driver.assignedCount}/{driver.capacity})
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
    </Dialog>
  );
}

/* ── B. Run sheet ───────────────────────────────────────────────────────── */

/**
 * The sheet for ONE run.
 *
 * The selector lists runs rather than drivers, because a driver working a
 * morning South Coast trip and an afternoon Sydney one has two sheets and two
 * tip-offs — picking "Dave" would have to guess which.
 */
function RunSheetView({ date }: { date: string }) {
  const board = useAllocationBoard(date);
  const runs = board.data?.runs ?? [];

  const [runId, setRunId] = useState<string | null>(null);
  const selected = runId ?? runs[0]?.id ?? null;

  const { data, error, isPending, refetch } = useRunSheet(selected);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Run</span>
          <Select
            value={selected ?? ''}
            onChange={(event) => {
              setRunId(event.target.value);
            }}
            className="w-auto"
            disabled={runs.length === 0}
          >
            {runs.length === 0 && <option value="">No runs for this day</option>}
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                {run.name} — {run.driverName ?? 'unassigned'}
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

      {runs.length === 0 ? (
        <Card>
          <EmptyState
            icon={RouteIcon}
            title="No runs for this day"
            description="Build one on the Runs tab and it appears here."
          />
        </Card>
      ) : error ? (
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
          title={`Nothing on ${runSheet.runName} yet`}
          description="Add jobs to this run on the Runs tab and they appear here in order."
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex flex-col gap-1">
            <span>
              {runSheet.runName} · {formatDate(runSheet.date)}
            </span>
            <span className="text-sm font-normal text-muted-foreground">
              {runSheet.driverName ?? 'No driver assigned'}
              {runSheet.sequenceForDay !== null &&
                ` · run ${String(runSheet.sequenceForDay)} of the day`}
            </span>
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
                    <span>{formatArea(stop.expectedAreaM2, 'Area not on the PO')} expected</span>
                    {stop.bagCount > 0 && <span>{stop.bagCount} bags</span>}
                    {stop.poNumber && <span>Ref {stop.poNumber}</span>}
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
    /*
         * Grouped by the zone NAME, which the pin now carries.
         *
         * It grouped by id-and-then-looked-the-name-up, which needed a cast
         * because the map was keyed on a string the label table did not
         * promise to have. One field, no cast, no lookup.
         */
        byZone.set(pin.zoneLabel, [...(byZone.get(pin.zoneLabel) ?? []), pin]);
  }

  return (
    <div className="space-y-4">
      <Alert variant="info" title="Geographic view">
        Plotted from each site’s confirmed pin. This is for <strong>visual clustering</strong> — six
        jobs in Oran Park and one in Newcastle tells the allocator what to do. It is not a computed
        route; route optimisation is out of scope.
      </Alert>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
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
                  {/* The key IS the zone's name now — see where byZone is built. */}
                  {zone}
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
                      {/* The run, not the driver — that is the unit the board deals in. */}
                      <span className="shrink-0 text-muted-foreground">
                        {pin.runName ?? 'Not on a run'}
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
                title={`#${String(pin.jobNumber)} · ${pin.accountName} · ${pin.suburb} · ${pin.runName ?? 'Not on a run'}${pin.driverName ? ` · ${pin.driverName}` : ''}`}
                className={cn(
                  'focus-ring grid size-6 place-items-center rounded-full border-2 border-card text-[9px] font-semibold shadow-sm transition-transform hover:scale-125',
                  pin.atRisk
                    ? 'bg-destructive text-destructive-foreground'
                    : pin.runId === null
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
          On a run
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-full bg-warning" />
          Not on a run
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-full bg-destructive" />
          At risk
        </li>
      </ul>
    </div>
  );
}
