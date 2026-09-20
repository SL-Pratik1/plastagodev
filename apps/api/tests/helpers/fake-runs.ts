import type { Driver, Run, RunStatus, UnallocatedJob } from '@plastago/shared';
import { ZONE } from './fake-settings.js';
import type { CreateRunInput } from '../../src/domains/dispatch/run.repository.js';

/**
 * In-memory stand-ins for the run and driver repositories.
 *
 * ── Why fakes and not a mocked Mongo ──────────────────────────────────────
 * The service's job is the run LIFECYCLE — which transitions are allowed, what
 * happens to a stop when its run is deleted, whether a reorder is really a
 * reorder. None of that needs a database, and a test that spins one up measures
 * Mongo's availability rather than the rule under test.
 */

let counter = 0;

function nextId(): string {
  counter += 1;
  return counter.toString(16).padStart(24, '0');
}

interface StoredRun {
  id: string;
  runNumber: number;
  name: string;
  date: string;
  status: RunStatus;
  driverId: string | null;
  driverName: string | null;
  sequenceForDay: number | null;
  stops: string[];
  optimisedAt: string | null;
}

export const DRIVERS: Driver[] = [
  {
    id: 'drv0000000000000000000d1',
    name: 'Wayne Corrigan',
    mobile: '0455112233',
    vehicleRego: null,
    vehicleLabel: null,
    status: 'available',
    dailyJobCapacity: 8,
    nextComplianceExpiry: null,
    lastSyncAt: null,
    pendingSyncActions: 0,
  },
  {
    id: 'drv0000000000000000000d2',
    name: 'Tom Beattie',
    mobile: '0455445566',
    vehicleRego: null,
    vehicleLabel: null,
    status: 'available',
    dailyJobCapacity: 8,
    nextComplianceExpiry: null,
    lastSyncAt: null,
    pendingSyncActions: 0,
  },
];

export function createFakeRunRepository() {
  const runs = new Map<string, StoredRun>();
  /** Jobs that exist and are not yet on any run. */
  const freeJobs = new Set<string>();

  const calls = {
    resequences: [] as Array<{ runId: string; jobIds: readonly string[]; optimised: boolean }>,
    assigns: [] as Array<{ runId: string; driverId: string; sequenceForDay: number }>,
    removed: [] as string[],
  };

  /**
   * Facts that belong to a JOB, not to its position on a run.
   *
   * Derived from the job's own id and remembered, so a stop keeps its suburb
   * when the run is reordered. Deriving these from the array index instead
   * would make every reorder look like it changed nothing.
   */
  const jobFacts = new Map<string, { jobNumber: number; suburb: string }>();
  let nextJobNumber = 61_300;

  /**
   * Which stops carry a real address rather than their suburb's centre (I3).
   *
   * Empty by default, because that is what every job booked before the geocoder
   * existed carries and the state a run is most likely to be in.
   */
  const geocoded = new Set<string>();

  function factsFor(jobId: string) {
    let facts = jobFacts.get(jobId);
    if (!facts) {
      // Two suburbs, alternating, so an optimise that sorts by suburb has
      // something visible to do.
      facts = {
        jobNumber: nextJobNumber,
        suburb: nextJobNumber % 2 === 0 ? 'Kellyville' : 'Box Hill',
      };
      nextJobNumber += 1;
      jobFacts.set(jobId, facts);
    }
    return facts;
  }

  function stopSummaries(run: StoredRun): Run['stops'] {
    return run.stops.map((jobId, index) => {
      const facts = factsFor(jobId);

      return {
        id: jobId,
        jobNumber: facts.jobNumber,
        sequence: index + 1,
        status: 'booked' as const,
        accountName: 'Clarendon Homes',
        builderName: 'GJ Gardner',
        siteName: `Lot ${String(facts.jobNumber)}`,
        suburb: facts.suburb,
        zoneId: ZONE.sydney,
        zoneLabel: 'Sydney',
        serviceLevel: 'standard' as const,
        readyDate: '2026-03-02',
        targetDate: '2026-03-09',
        expectedAreaM2: 500,
        // Geocoded, so the fake board is a run that CAN be routed — the tests
        // that care about the suburb-pinned case set it themselves.
        locationSource: 'geocoded' as const,
        atRisk: false,
      };
    });
  }

  function toRun(run: StoredRun): Run {
    const stops = stopSummaries(run);
    const suburbs: string[] = [];
    for (const stop of stops) if (!suburbs.includes(stop.suburb)) suburbs.push(stop.suburb);

    return {
      id: run.id,
      runNumber: run.runNumber,
      name: run.name,
      date: run.date,
      status: run.status,
      driverId: run.driverId,
      driverName: run.driverName,
      vehicleLabel: null,
      sequenceForDay: run.sequenceForDay,
      suburbs,
      stops,
      totalExpectedAreaM2: stops.reduce((sum, stop) => sum + (stop.expectedAreaM2 ?? 0), 0),
      totalBags: 0,
      optimisedAt: run.optimisedAt,
      tipOff: null,
    };
  }

  const repository = {
    async findById(runId: string): Promise<Run | null> {
      const run = runs.get(runId);
      return Promise.resolve(run ? toRun(run) : null);
    },

    async findByDate(date: string): Promise<Run[]> {
      return Promise.resolve(
        [...runs.values()].filter((run) => run.date === date).map((run) => toRun(run)),
      );
    },

    async findSummary(runId: string) {
      const run = runs.get(runId);
      return Promise.resolve(
        run
          ? {
              id: run.id,
              runNumber: run.runNumber,
              name: run.name,
              date: run.date,
              status: run.status,
              driverId: run.driverId,
              stopCount: run.stops.length,
            }
          : null,
      );
    },

    async create(input: CreateRunInput): Promise<string> {
      const id = nextId();
      runs.set(id, {
        id,
        runNumber: input.runNumber,
        name: input.name,
        date: input.date,
        status: input.status,
        driverId: input.driverId,
        driverName: input.driverName,
        sequenceForDay: input.sequenceForDay,
        stops: [],
        optimisedAt: null,
      });
      return Promise.resolve(id);
    },

    async rename(runId: string, name: string): Promise<boolean> {
      const run = runs.get(runId);
      if (!run) return Promise.resolve(false);
      run.name = name;
      return Promise.resolve(true);
    },

    async remove(runId: string): Promise<void> {
      const run = runs.get(runId);
      // Stops go back to the unallocated pool — the work still has to happen.
      if (run) for (const jobId of run.stops) freeJobs.add(jobId);
      runs.delete(runId);
      calls.removed.push(runId);
      return Promise.resolve();
    },

    async addStop(runId: string, jobId: string, _sequence: number): Promise<boolean> {
      const run = runs.get(runId);
      // Mirrors the real `runId: null` filter: a job already placed is refused.
      if (!run || !freeJobs.has(jobId)) return Promise.resolve(false);
      freeJobs.delete(jobId);
      run.stops.push(jobId);
      return Promise.resolve(true);
    },

    async removeStop(runId: string, jobId: string): Promise<boolean> {
      const run = runs.get(runId);
      if (!run || !run.stops.includes(jobId)) return Promise.resolve(false);
      run.stops = run.stops.filter((id) => id !== jobId);
      freeJobs.add(jobId);
      return Promise.resolve(true);
    },

    async stopIds(runId: string): Promise<string[]> {
      return Promise.resolve([...(runs.get(runId)?.stops ?? [])]);
    },

    /**
     * I3 — the stops as points, in sequence.
     *
     * Coordinates are derived from the job's own facts so they are stable
     * across a reorder, and spread far enough apart that a route between them
     * is a meaningful thing to ask for. `locationSource` defaults to `suburb`,
     * which is what an ungeocoded job carries and what makes `routeStops`
     * refuse — a test that wants a route calls `geocodeStops` first.
     */
    async stopPoints(runId: string) {
      return Promise.resolve(
        (runs.get(runId)?.stops ?? []).map((jobId) => {
          const facts = factsFor(jobId);
          return {
            id: jobId,
            latitude: -33.7 - (facts.jobNumber % 20) / 100,
            longitude: 150.9 + (facts.jobNumber % 20) / 100,
            locationSource: geocoded.has(jobId) ? ('geocoded' as const) : ('suburb' as const),
          };
        }),
      );
    },

    async resequence(
      runId: string,
      jobIds: readonly string[],
      optimised: boolean,
    ): Promise<void> {
      calls.resequences.push({ runId, jobIds, optimised });
      const run = runs.get(runId);
      if (run) {
        run.stops = [...jobIds];
        run.optimisedAt = optimised ? new Date().toISOString() : null;
      }
      return Promise.resolve();
    },

    async assign(
      runId: string,
      driverId: string,
      driverName: string,
      sequenceForDay: number,
    ): Promise<boolean> {
      const run = runs.get(runId);
      if (!run || run.status !== 'planning') return Promise.resolve(false);
      Object.assign(run, { driverId, driverName, sequenceForDay, status: 'assigned' as const });
      calls.assigns.push({ runId, driverId, sequenceForDay });
      return Promise.resolve(true);
    },

    async unassign(runId: string): Promise<boolean> {
      const run = runs.get(runId);
      if (!run) return Promise.resolve(false);
      Object.assign(run, {
        driverId: null,
        driverName: null,
        sequenceForDay: null,
        status: 'planning' as const,
      });
      return Promise.resolve(true);
    },

    async countDriverRuns(driverId: string, date: string): Promise<number> {
      return Promise.resolve(
        [...runs.values()].filter((run) => run.driverId === driverId && run.date === date).length,
      );
    },

    async unallocated(_date: string): Promise<UnallocatedJob[]> {
      return Promise.resolve([]);
    },

    async recordTipOff(): Promise<void> {
      return Promise.resolve();
    },
  };

  return {
    repository,
    calls,

    /** Register jobs as existing and unallocated, so they can be placed. */
    seedJobs(...ids: string[]): string[] {
      const made = ids.length > 0 ? ids : [nextId(), nextId(), nextId()];
      for (const id of made) freeJobs.add(id);
      return made;
    },

    run(runId: string): StoredRun | undefined {
      return runs.get(runId);
    },

    isFree(jobId: string): boolean {
      return freeJobs.has(jobId);
    },

    /** Force a status the lifecycle would not normally reach yet. */
    setStatus(runId: string, status: RunStatus): void {
      const run = runs.get(runId);
      if (run) run.status = status;
    },

    /**
     * I3 — mark a run's stops as carrying real addresses.
     *
     * Explicit rather than a default, because `routeStops` refusing a
     * suburb-pinned run is itself one of the behaviours under test.
     */
    geocodeStops(runId: string): void {
      for (const jobId of runs.get(runId)?.stops ?? []) geocoded.add(jobId);
    },

    /** The inverse — one stop left on its suburb's centre. */
    pinToSuburb(jobId: string): void {
      geocoded.delete(jobId);
    },
  };
}

export function createFakeDriverRepository() {
  return {
    repository: {
      async list(): Promise<Driver[]> {
        return Promise.resolve(DRIVERS);
      },
      async findById(driverId: string): Promise<Driver | null> {
        return Promise.resolve(DRIVERS.find((driver) => driver.id === driverId) ?? null);
      },
    },
  };
}
