import type {
  AllocationBoard,
  CreateRunInput,
  Driver,
  DriverDay,
  MapPin,
  Run,
  RunSheet,
  UnallocatedJob,
} from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { jobRepository } from '../jobs/job.repository.js';
import { settingsRepository } from '../settings/settings.repository.js';
import { driverRepository } from './driver.repository.js';
import { runRepository } from './run.repository.js';

const log = logger.child({ module: 'dispatch' });

/**
 * Dispatch (M3) — building the day and staffing it.
 *
 * ── The order of operations is the design ─────────────────────────────────
 * Matt, 44:50: *"rather than an allocation board per se, it'd be a run sheet
 * creator."* The allocator shapes the day BEFORE staffing it, so creating a
 * run, filling it and assigning it are three separate operations rather than
 * one `allocate` that does all three. A run with no driver on it is a valid,
 * saveable thing — it is most of what the board holds at 7am.
 *
 * ── No automatic assignment ───────────────────────────────────────────────
 * Composition stays a human decision. The allocator knows which jobs are ready
 * and which builder will complain, and with two drivers that judgement is
 * faster and more transparent than anything that could be computed. Only the
 * ORDER within a run is optimised (I11), and only when asked.
 */

/**
 * ⚠️ Stops may only be added or removed while a run is `planning`.
 *
 * Once a driver has the run on his phone, changing its contents underneath him
 * is how a stop gets missed. The allocator unassigns first — a deliberate speed
 * bump, not an oversight.
 */
const MUTABLE_STATUS = 'planning';

export const dispatchService = {
  /**
   * Everything the allocation board renders for one date.
   *
   * The unallocated jobs are returned twice — flat, and grouped by suburb —
   * because a run is built from an AREA: *"you might have Kellyville, Box Hill,
   * four or five suburbs close together, you'll put them on one run"* (41:17).
   * The suburb bucket is what the allocator actually reaches for, and computing
   * it in the browser would mean every consumer re-deriving the same grouping.
   */
  async board(date: string): Promise<AllocationBoard> {
    const [unallocated, runs, drivers] = await Promise.all([
      runRepository.unallocated(date),
      runRepository.findByDate(date),
      driverRepository.list(),
    ]);

    return {
      date,
      unallocated,
      unallocatedBySuburb: groupBySuburb(unallocated),
      runs,
      drivers: drivers.map((driver) => toDriverDay(driver, date, runs)),
    };
  },

  async createRun(input: CreateRunInput): Promise<Run> {
    const runNumber = await settingsRepository.takeNextNumber('nextRunNumber');

    let driverName: string | null = null;
    let sequenceForDay: number | null = null;

    if (input.driverId) {
      const driver = await requireDriver(input.driverId);
      driverName = driver.name;
      sequenceForDay = (await runRepository.countDriverRuns(input.driverId, input.date)) + 1;
    }

    const runId = await runRepository.create({
      runNumber,
      name: input.name.trim(),
      date: input.date,
      driverId: input.driverId,
      driverName,
      sequenceForDay,
      // A run created WITH a driver is already staffed. Created without one it
      // is still being shaped, which is the normal case at 7am.
      status: input.driverId ? 'assigned' : 'planning',
    });

    /*
     * Stops are added one at a time rather than in bulk, so a job that is
     * already on another run is refused individually instead of silently
     * dropping out of a batch the allocator thought had worked.
     */
    for (const [index, jobId] of input.jobIds.entries()) {
      const added = await runRepository.addStop(runId, jobId, index + 1);
      if (!added) {
        log.warn({ runId, jobId }, 'job could not be added to a new run — already allocated');
      }
    }

    log.info({ runId, runNumber, date: input.date, stops: input.jobIds.length }, 'run created');

    return requireRun(runId);
  },

  async renameRun(runId: string, name: string): Promise<void> {
    const renamed = await runRepository.rename(runId, name.trim());
    if (!renamed) throw AppError.notFound('No such run');
  },

  /**
   * Deletes a run. Its stops go back to the unallocated column.
   *
   * Refused once the run has started: a run in progress is a truck on the road,
   * and deleting the record does not recall it — it just removes the only thing
   * that says where the driver is meant to be.
   */
  async deleteRun(runId: string): Promise<void> {
    const run = await requireRunSummary(runId);

    if (run.status !== MUTABLE_STATUS && run.status !== 'assigned') {
      throw AppError.conflict(
        `Run ${String(run.runNumber)} has already started, so it cannot be deleted`,
      );
    }

    await runRepository.remove(runId);
    log.info({ runId, runNumber: run.runNumber, released: run.stopCount }, 'run deleted');
  },

  async addJobToRun(runId: string, jobId: string): Promise<void> {
    const run = await assertPlanning(runId);

    const added = await runRepository.addStop(runId, jobId, run.stopCount + 1);

    if (!added) {
      // Either the job does not exist or it is already on a run. Both are the
      // same answer to the allocator: it is not available to place here.
      throw AppError.conflict(
        'That job is already on a run. Take it off the other one first.',
      );
    }
  },

  async removeJobFromRun(runId: string, jobId: string): Promise<void> {
    await assertPlanning(runId);

    const removed = await runRepository.removeStop(runId, jobId);
    if (!removed) throw AppError.notFound('That job is not on this run');

    // The gap left behind is closed, so the sheet never reads 1, 2, 4.
    await runRepository.resequence(runId, await runRepository.stopIds(runId), false);
  },

  /**
   * Reorder by hand.
   *
   * `jobIds` must be a PERMUTATION of the run's current stops — same members,
   * different order. Accepting a partial list would silently drop the stops it
   * omitted, and a stop that vanishes off a run sheet is a collection that does
   * not happen.
   */
  async reorderRun(runId: string, jobIds: readonly string[]): Promise<void> {
    await assertPlanning(runId);

    const current = await runRepository.stopIds(runId);
    assertPermutation(current, jobIds);

    // `false` — this ordering is the allocator's own work, so `optimisedAt` is
    // cleared. That is what tells the UI there is something to lose next time
    // somebody asks to optimise.
    await runRepository.resequence(runId, jobIds, false);
  },

  /**
   * I11 — Google Route Optimization orders the stops (Matt, 42:06).
   *
   * ⚠️ Not wired to Google yet, and it does NOT pretend to be. Until the
   * integration lands this orders by suburb so stops in the same street are
   * together, stamps `optimisedAt`, and says as much — a plausible-looking
   * route that was never computed is worse than an honest grouping, because a
   * driver would follow it.
   */
  async optimiseRun(runId: string): Promise<Run> {
    await assertPlanning(runId);

    const run = await requireRun(runId);

    const ordered = [...run.stops]
      .sort((a, b) => a.suburb.localeCompare(b.suburb) || a.jobNumber - b.jobNumber)
      .map((stop) => stop.id);

    await runRepository.resequence(runId, ordered, true);
    log.info({ runId, stops: ordered.length }, 'run ordered by suburb (route optimisation pending)');

    return requireRun(runId);
  },

  /**
   * Staffs a run.
   *
   * `sequenceForDay` is computed, not supplied: it is which of this driver's
   * runs for the day this is — 1 for the morning South Coast trip, 2 for the
   * afternoon Sydney one (Matt, 40:03). Two runs in a day is a normal day.
   */
  async assignRun(runId: string, driverId: string): Promise<void> {
    const run = await requireRunSummary(runId);
    const driver = await requireDriver(driverId);

    if (run.status !== MUTABLE_STATUS) {
      throw AppError.conflict(
        run.driverId
          ? `Run ${String(run.runNumber)} is already assigned. Unassign it first.`
          : `Run ${String(run.runNumber)} has already started`,
      );
    }

    if (run.stopCount === 0) {
      // An empty run on a driver's phone is a wasted trip to the depot.
      throw AppError.conflict('Add at least one stop before assigning this run');
    }

    const sequenceForDay = (await runRepository.countDriverRuns(driverId, run.date)) + 1;

    const assigned = await runRepository.assign(runId, driverId, driver.name, sequenceForDay);
    if (!assigned) {
      throw AppError.conflict('That run changed while you were looking at it — reload and retry');
    }

    log.info(
      { runId, runNumber: run.runNumber, driverId, sequenceForDay, stops: run.stopCount },
      'run assigned',
    );
  },

  async unassignRun(runId: string): Promise<void> {
    const run = await requireRunSummary(runId);

    if (run.status !== 'assigned') {
      throw AppError.conflict(
        run.status === MUTABLE_STATUS
          ? `Run ${String(run.runNumber)} has nobody on it`
          : `Run ${String(run.runNumber)} has already started, so the driver cannot be taken off it`,
      );
    }

    const unassigned = await runRepository.unassign(runId);
    if (!unassigned) {
      throw AppError.conflict('That run changed while you were looking at it — reload and retry');
    }

    log.info({ runId, runNumber: run.runNumber }, 'run unassigned');
  },

  /**
   * One run's sheet — NOT one driver's day.
   *
   * A driver with a morning and an afternoon run needs two of these, and the
   * tip-off that closes each one belongs to that run. That is the whole reason
   * runs exist as a record rather than being a filter over a driver's jobs.
   */
  async runSheet(runId: string): Promise<RunSheet> {
    const run = await requireRun(runId);
    const stops = await jobRepository.runSheetStops(runId);

    const driver = run.driverId ? await driverRepository.findById(run.driverId) : null;

    return {
      runId: run.id,
      runNumber: run.runNumber,
      runName: run.name,
      status: run.status,
      sequenceForDay: run.sequenceForDay,
      driverId: run.driverId,
      driverName: run.driverName,
      driverMobile: driver?.mobile ?? null,
      vehicleLabel: run.vehicleLabel,
      date: run.date,
      suburbs: run.suburbs,
      stops,
      totalExpectedAreaM2: run.totalExpectedAreaM2,
      totalBags: run.totalBags,
      optimisedAt: run.optimisedAt,
      tipOff: run.tipOff,
    };
  },

  /**
   * M3.3 — pins for visual clustering. NOT a routing result.
   *
   * The run NAME is joined here rather than in the jobs repository: a job knows
   * its run's id, and resolving that id belongs to whichever domain owns runs.
   * Two queries, no join per pin.
   */
  async mapPins(date: string): Promise<MapPin[]> {
    const [pins, runs] = await Promise.all([
      jobRepository.mapPins(date),
      runRepository.findByDate(date),
    ]);

    const names = new Map(runs.map((run) => [run.id, run.name]));

    return pins.map((pin) => ({
      ...pin,
      runName: pin.runId ? (names.get(pin.runId) ?? null) : null,
    }));
  },

  async drivers(): Promise<Driver[]> {
    return driverRepository.list();
  },
};

/* ── Guards ──────────────────────────────────────────────────────────────── */

async function requireRun(runId: string): Promise<Run> {
  const run = await runRepository.findById(runId);
  if (!run) throw AppError.notFound('No such run');
  return run;
}

async function requireRunSummary(runId: string) {
  const run = await runRepository.findSummary(runId);
  if (!run) throw AppError.notFound('No such run');
  return run;
}

async function requireDriver(driverId: string): Promise<Driver> {
  const driver = await driverRepository.findById(driverId);
  if (!driver) {
    throw AppError.validation('That driver could not be found', [
      { path: 'driverId', message: 'Choose a driver from the list' },
    ]);
  }
  return driver;
}

/** See the note on `MUTABLE_STATUS`. */
async function assertPlanning(runId: string) {
  const run = await requireRunSummary(runId);

  if (run.status !== MUTABLE_STATUS) {
    throw AppError.conflict(
      run.status === 'assigned'
        ? `Run ${String(run.runNumber)} is with a driver. Unassign it before changing its stops.`
        : `Run ${String(run.runNumber)} has already started, so its stops are fixed`,
    );
  }

  return run;
}

/**
 * The reorder must contain exactly the run's current stops.
 *
 * Checked by MEMBERSHIP rather than by length alone: a list of the right size
 * that names a job twice and omits another would pass a length check and lose a
 * stop.
 */
function assertPermutation(current: string[], proposed: readonly string[]): void {
  const currentSet = new Set(current);
  const proposedSet = new Set(proposed);

  const sameSize =
    proposed.length === current.length && proposedSet.size === proposed.length;
  const sameMembers = sameSize && [...currentSet].every((id) => proposedSet.has(id));

  if (!sameMembers) {
    throw AppError.validation('That ordering does not match the run', [
      {
        path: 'jobIds',
        message: 'Send every stop on the run exactly once, in the new order',
      },
    ]);
  }
}

/* ── Board shaping ───────────────────────────────────────────────────────── */

/**
 * The unallocated column, bucketed by suburb.
 *
 * Sorted by how much work is waiting in each suburb, because that is what makes
 * a run worth doing — a single stop in Medowie is a trip the allocator will
 * probably defer.
 */
function groupBySuburb(jobs: UnallocatedJob[]): AllocationBoard['unallocatedBySuburb'] {
  const buckets = new Map<string, AllocationBoard['unallocatedBySuburb'][number]>();

  for (const job of jobs) {
    const bucket = buckets.get(job.suburb) ?? {
      suburb: job.suburb,
      zone: job.zone,
      jobs: [],
      totalExpectedAreaM2: 0,
      atRiskCount: 0,
    };

    bucket.jobs.push(job);
    // Null contributes nothing rather than being read as zero (Matt, 31:22).
    bucket.totalExpectedAreaM2 += job.expectedAreaM2 ?? 0;
    if (job.atRisk) bucket.atRiskCount += 1;

    buckets.set(job.suburb, bucket);
  }

  return [...buckets.values()].sort(
    (a, b) => b.atRiskCount - a.atRiskCount || b.jobs.length - a.jobs.length,
  );
}

/** One driver's load for the date, assembled from the runs already fetched. */
function toDriverDay(driver: Driver, date: string, runs: Run[]): DriverDay {
  const mine = runs
    .filter((run) => run.driverId === driver.id)
    .sort((a, b) => (a.sequenceForDay ?? 0) - (b.sequenceForDay ?? 0));

  const jobs = mine.flatMap((run) =>
    run.stops.map((stop) => ({
      id: stop.id,
      jobNumber: stop.jobNumber,
      sequence: stop.sequence,
      runId: run.id,
      status: stop.status,
      accountName: stop.accountName,
      siteName: stop.siteName,
      suburb: stop.suburb,
      zone: stop.zone,
      serviceLevel: stop.serviceLevel,
      expectedAreaM2: stop.expectedAreaM2,
      atRisk: stop.atRisk,
    })),
  );

  return {
    driverId: driver.id,
    driverName: driver.name,
    date,
    // A driver carrying runs today is on a run, whatever their base status says.
    status: mine.length > 0 ? 'on-run' : driver.status,
    capacity: driver.dailyJobCapacity,
    assignedCount: jobs.length,
    runs: mine.map((run) => ({
      id: run.id,
      runNumber: run.runNumber,
      name: run.name,
      status: run.status,
      // Only assigned runs reach this list, so the sequence is always set.
      sequenceForDay: run.sequenceForDay ?? 1,
      suburbs: run.suburbs,
      stopCount: run.stops.length,
      totalExpectedAreaM2: run.totalExpectedAreaM2,
      atRiskCount: run.stops.filter((stop) => stop.atRisk).length,
    })),
    jobs,
  };
}
