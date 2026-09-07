import type {
  AllocationBoard,
  AssignedRunSummary,
  Driver,
  DriverDay,
  Job,
  MapPin,
  Run,
  RunSheet,
  RunSheetStop,
  RunStopSummary,
  UnallocatedJob,
} from '@plastago/shared';
import { ServiceError } from '../service-error';
import type { DispatchService } from '../types';
import { ACTIVE_DRIVERS, DRIVERS } from './fixtures/reference';
import { latency } from './mock-transport';
import { addRun, findJob, isAtRisk, runForJob, store, type RunRecord } from './store';

/**
 * Allocation and dispatch (M3).
 *
 * ── Runs, not jobs ────────────────────────────────────────────────────────
 * Matt, 39:41: *"I create a run and we are able to add jobs to that run… assign
 * that whole run to a driver rather than assigning jobs to the driver."* So the
 * board deals in runs, `assign` staffs a run rather than a job, and the run
 * sheet is keyed by run — a driver doing a morning and an afternoon trip has two
 * of them, and the weighbridge docket at the end of each belongs to that trip.
 *
 * ── Everything is derived ─────────────────────────────────────────────────
 * A `RunRecord` holds only an ordered list of job ids. Suburbs, totals and
 * at-risk counts are computed here on every read, so a job edited on the jobs
 * grid cannot leave a run quoting a number that is no longer true.
 */

const ALLOCATABLE = ['booked', 'assigned', 'in-transit', 'arrived'] as const;

function isAllocatable(job: Job): boolean {
  return (ALLOCATABLE as readonly string[]).includes(job.status);
}

/** The jobs on a run, in stop order — `jobIds` order IS the sequence. */
function stopsOf(run: RunRecord): Job[] {
  return run.jobIds
    .map((id) => store.jobs.find((job) => job.id === id))
    .filter((job): job is Job => job !== undefined);
}

/**
 * Area totals skip jobs that have no area.
 *
 * A fixed-price builder's PO carries no square metres at all (Matt, 31:22), and
 * `null` there means *unknown*, not *zero*. Summing it as zero would make a run
 * of four Wisdom jobs read as "0 m²", which looks like an empty run rather than
 * an unpriced one.
 */
function totalArea(jobs: readonly Job[]): number {
  return jobs.reduce((sum, job) => sum + (job.expectedAreaM2 ?? 0), 0);
}

/** Distinct suburbs in stop order — what the board groups and labels on. */
function suburbsOf(jobs: readonly Job[]): string[] {
  return [...new Set(jobs.map((job) => job.suburb))];
}

/** Which of the driver's runs for the day this is: 1 is the morning trip. */
function sequenceForDay(run: RunRecord): number | null {
  if (run.driverId === null) return null;
  const siblings = store.runs
    .filter((candidate) => candidate.driverId === run.driverId && candidate.date === run.date)
    .sort((a, b) => a.runNumber - b.runNumber);
  return siblings.findIndex((candidate) => candidate.id === run.id) + 1;
}

function toRunStop(job: Job, index: number): RunStopSummary {
  return {
    id: job.id,
    jobNumber: job.jobNumber,
    sequence: index + 1,
    status: job.status,
    accountName: job.accountName,
    builderName: job.builderName,
    siteName: job.siteName,
    suburb: job.suburb,
    zone: job.zone,
    serviceLevel: job.serviceLevel,
    readyDate: job.readyDate,
    targetDate: job.targetDate,
    expectedAreaM2: job.expectedAreaM2,
    atRisk: isAtRisk(job),
  };
}

function toRun(run: RunRecord): Run {
  const jobs = stopsOf(run);
  const driver = DRIVERS.find((candidate) => candidate.id === run.driverId);

  return {
    id: run.id,
    runNumber: run.runNumber,
    name: run.name,
    date: run.date,
    status: run.status,
    driverId: run.driverId,
    driverName: driver?.name ?? null,
    vehicleLabel: driver?.vehicleLabel ?? null,
    sequenceForDay: sequenceForDay(run),
    suburbs: suburbsOf(jobs),
    stops: jobs.map(toRunStop),
    totalExpectedAreaM2: totalArea(jobs),
    totalBags: jobs.reduce((sum, job) => sum + job.bagCount, 0),
    optimisedAt: run.optimisedAt,
    tipOff: run.tipOff,
  };
}

function toAssignedSummary(run: RunRecord): AssignedRunSummary {
  const jobs = stopsOf(run);
  return {
    id: run.id,
    runNumber: run.runNumber,
    name: run.name,
    status: run.status,
    sequenceForDay: sequenceForDay(run) ?? 1,
    suburbs: suburbsOf(jobs),
    stopCount: jobs.length,
    totalExpectedAreaM2: totalArea(jobs),
    atRiskCount: jobs.filter((job) => isAtRisk(job)).length,
  };
}

function toUnallocated(job: Job): UnallocatedJob {
  return {
    id: job.id,
    jobNumber: job.jobNumber,
    accountName: job.accountName,
    builderName: job.builderName,
    siteName: job.siteName,
    suburb: job.suburb,
    zone: job.zone,
    serviceLevel: job.serviceLevel,
    readyDate: job.readyDate,
    targetDate: job.targetDate,
    expectedAreaM2: job.expectedAreaM2,
    atRisk: isAtRisk(job),
  };
}

function findRun(runId: string): RunRecord {
  const run = store.runs.find((candidate) => candidate.id === runId);
  if (!run) throw new ServiceError('NOT_FOUND', `No run ${runId}`);
  return run;
}

function writeRun(next: RunRecord): void {
  store.runs = store.runs.map((run) => (run.id === next.id ? next : run));
}

/**
 * Mirror the run's driver onto its jobs.
 *
 * The job still carries `driverId` because the jobs grid, the driver app and the
 * map all read it. The run is the source of truth; this keeps the copy honest
 * rather than letting two records drift.
 */
function syncJobsToRun(run: RunRecord): void {
  const driver = DRIVERS.find((candidate) => candidate.id === run.driverId);

  store.jobs = store.jobs.map((job) => {
    if (!run.jobIds.includes(job.id)) return job;
    return {
      ...job,
      driverId: driver?.id ?? null,
      driverName: driver?.name ?? null,
      status:
        driver && job.status === 'booked'
          ? 'assigned'
          : !driver && job.status === 'assigned'
            ? 'booked'
            : job.status,
    };
  });
}

export function createMockDispatchService(): DispatchService {
  return {
    async board(date) {
      await latency();

      const forDate = store.jobs.filter((job) => job.readyDate === date && isAllocatable(job));
      const runsForDate = store.runs.filter((run) => run.date === date);
      const onARun = new Set(runsForDate.flatMap((run) => run.jobIds));

      const unallocated = forDate
        .filter((job) => !onARun.has(job.id))
        .map(toUnallocated)
        // Urgent first, then whatever is closest to breaching (M3.5).
        .sort((a, b) => {
          if (a.serviceLevel !== b.serviceLevel) return a.serviceLevel === 'urgent' ? -1 : 1;
          if (a.atRisk !== b.atRisk) return a.atRisk ? -1 : 1;
          return a.targetDate.localeCompare(b.targetDate);
        });

      /*
       * The same jobs again, bucketed by suburb.
       *
       * This is the view the allocator actually builds from — *"you might have
       * Kellyville, Box Hill, four or five suburbs close together, you'll put
       * them on one run"* (41:17). Buckets are ordered by their most urgent job
       * so the area that needs attention is at the top, not the one whose name
       * sorts first.
       */
      const bucketMap = new Map<string, UnallocatedJob[]>();
      for (const job of unallocated) {
        bucketMap.set(job.suburb, [...(bucketMap.get(job.suburb) ?? []), job]);
      }

      const unallocatedBySuburb = [...bucketMap.entries()]
        .map(([suburb, jobs]) => ({
          suburb,
          zone: jobs[0]?.zone ?? 'sydney',
          jobs,
          totalExpectedAreaM2: jobs.reduce((sum, job) => sum + (job.expectedAreaM2 ?? 0), 0),
          atRiskCount: jobs.filter((job) => job.atRisk).length,
        }))
        .sort((a, b) => {
          if (a.atRiskCount !== b.atRiskCount) return b.atRiskCount - a.atRiskCount;
          return b.jobs.length - a.jobs.length || a.suburb.localeCompare(b.suburb);
        });

      const drivers: DriverDay[] = ACTIVE_DRIVERS.map((driver) => {
        const driverRuns = runsForDate
          .filter((run) => run.driverId === driver.id)
          .sort((a, b) => a.runNumber - b.runNumber);

        const jobs = driverRuns.flatMap((run) =>
          stopsOf(run).map((job, index) => ({
            id: job.id,
            jobNumber: job.jobNumber,
            sequence: index + 1,
            runId: run.id,
            status: job.status,
            accountName: job.accountName,
            siteName: job.siteName,
            suburb: job.suburb,
            zone: job.zone,
            serviceLevel: job.serviceLevel,
            expectedAreaM2: job.expectedAreaM2,
            atRisk: isAtRisk(job),
          })),
        );

        return {
          driverId: driver.id,
          driverName: driver.name,
          date,
          status: jobs.length > 0 ? 'on-run' : 'available',
          capacity: driver.dailyJobCapacity,
          assignedCount: jobs.length,
          runs: driverRuns.map(toAssignedSummary),
          jobs,
        };
      });

      const board: AllocationBoard = {
        date,
        unallocated,
        unallocatedBySuburb,
        runs: runsForDate.sort((a, b) => a.runNumber - b.runNumber).map(toRun),
        drivers,
      };
      return board;
    },

    /* ── Building a run ─────────────────────────────────────────────────── */

    async createRun(input) {
      await latency(320, 150);

      const clash = store.runs.find(
        (run) => run.date === input.date && run.name.toLowerCase() === input.name.trim().toLowerCase(),
      );
      if (clash) {
        throw new ServiceError('CONFLICT', `There is already a run called "${input.name}" on ${input.date}`);
      }

      const run = addRun({
        name: input.name,
        date: input.date,
        driverId: input.driverId,
        jobIds: [...input.jobIds],
      });

      if (run.driverId !== null) syncJobsToRun(run);
      return toRun(run);
    },

    async renameRun(runId, name) {
      await latency(240, 120);
      const run = findRun(runId);
      writeRun({ ...run, name: name.trim() });
    },

    async deleteRun(runId) {
      await latency(280, 140);
      const run = findRun(runId);

      // Deleting a run that is already out on the road would strand its stops
      // with no driver and no record of who had them.
      if (run.status !== 'planning' && run.status !== 'assigned') {
        throw new ServiceError('CONFLICT', `${run.name} has already started — it cannot be deleted`);
      }

      // Jobs go back to unallocated rather than disappearing with the run.
      syncJobsToRun({ ...run, driverId: null });
      store.runs = store.runs.filter((candidate) => candidate.id !== runId);
    },

    async addJobToRun(runId, jobId) {
      await latency(300, 150);

      const run = findRun(runId);
      const job = findJob(jobId);
      if (!job) throw new ServiceError('NOT_FOUND', `No job ${jobId}`);

      const existing = runForJob(jobId);
      if (existing && existing.id !== runId) {
        throw new ServiceError('CONFLICT', `Job #${String(job.jobNumber)} is already on ${existing.name}`);
      }
      if (run.jobIds.includes(jobId)) return;

      /*
       * Capacity is a real constraint, not decoration: over-filling a run is how
       * a day quietly becomes undeliverable. Checked across the driver's whole
       * day rather than per run, because two runs of five is still ten stops.
       */
      if (run.driverId !== null) {
        const driver = DRIVERS.find((candidate) => candidate.id === run.driverId);
        const load = store.runs
          .filter((candidate) => candidate.driverId === run.driverId && candidate.date === run.date)
          .reduce((sum, candidate) => sum + candidate.jobIds.length, 0);

        if (driver && load >= driver.dailyJobCapacity) {
          throw new ServiceError(
            'CONFLICT',
            `${driver.name} already has ${String(load)} stops on ${run.date} — at capacity`,
          );
        }
      }

      const next = { ...run, jobIds: [...run.jobIds, jobId], optimisedAt: null };
      writeRun(next);
      syncJobsToRun(next);
    },

    async removeJobFromRun(runId, jobId) {
      await latency(280, 140);

      const run = findRun(runId);
      const job = findJob(jobId);
      if (!job) throw new ServiceError('NOT_FOUND', `No job ${jobId}`);

      // Once a driver has set off, pulling a stop out from under them is not an
      // allocation change — it is a conversation.
      if (job.status !== 'assigned' && job.status !== 'booked') {
        throw new ServiceError(
          'CONFLICT',
          'The driver has already started this job — moving it needs a call first',
        );
      }

      const next = { ...run, jobIds: run.jobIds.filter((id) => id !== jobId) };
      writeRun(next);

      store.jobs = store.jobs.map((candidate) =>
        candidate.id === jobId
          ? { ...candidate, driverId: null, driverName: null, status: 'booked' as const }
          : candidate,
      );
    },

    async reorderRun(runId, jobIds) {
      await latency(220, 110);

      const run = findRun(runId);
      const same =
        jobIds.length === run.jobIds.length && jobIds.every((id) => run.jobIds.includes(id));
      if (!same) {
        throw new ServiceError('CONFLICT', 'That ordering does not match the stops on this run');
      }

      // Hand-ordering supersedes the optimiser, so the badge stops claiming the
      // sequence came from Google when it no longer did.
      writeRun({ ...run, jobIds: [...jobIds], optimisedAt: null });
    },

    /**
     * I11 — Google Route Optimization (Matt, 42:06: *"that'd be awesome"*).
     *
     * Stubbed here as a nearest-neighbour walk from the depot over the sites'
     * real coordinates. That is NOT what ships — the real call goes to Google
     * and accounts for roads, traffic and time windows — but it produces a
     * plausibly reordered run, which is what the screen needs to be judged on.
     */
    async optimiseRun(runId) {
      await latency(900, 400);

      const run = findRun(runId);
      const jobs = stopsOf(run);
      if (jobs.length < 2) return toRun(run);

      // No lookup, and no `?? 0` fallback that used to drop a stop into the
      // Gulf of Guinea when its site was missing — the pin is on the job.
      const at = (job: Job) => ({ lat: job.latitude, lon: job.longitude });

      // The yard at Kembla Grange — every run starts and ends there.
      let cursor = { lat: -34.4869, lon: 150.8069 };
      const remaining = [...jobs];
      const ordered: Job[] = [];

      while (remaining.length > 0) {
        let bestIndex = 0;
        let bestDistance = Number.POSITIVE_INFINITY;

        remaining.forEach((job, index) => {
          const { lat, lon } = at(job);
          const distance = (lat - cursor.lat) ** 2 + (lon - cursor.lon) ** 2;
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
          }
        });

        const [next] = remaining.splice(bestIndex, 1);
        if (!next) break;
        ordered.push(next);
        cursor = at(next);
      }

      const optimised = {
        ...run,
        jobIds: ordered.map((job) => job.id),
        optimisedAt: new Date().toISOString(),
      };
      writeRun(optimised);
      return toRun(optimised);
    },

    /* ── Staffing it ────────────────────────────────────────────────────── */

    async assignRun(runId, driverId) {
      await latency(380, 180);

      const run = findRun(runId);
      const driver = DRIVERS.find((candidate) => candidate.id === driverId);
      if (!driver) throw new ServiceError('NOT_FOUND', `No driver ${driverId}`);
      if (!driver.active) {
        throw new ServiceError('CONFLICT', `${driver.name} is not an active driver`);
      }

      const load = store.runs
        .filter(
          (candidate) =>
            candidate.driverId === driverId &&
            candidate.date === run.date &&
            candidate.id !== runId,
        )
        .reduce((sum, candidate) => sum + candidate.jobIds.length, 0);

      if (load + run.jobIds.length > driver.dailyJobCapacity) {
        throw new ServiceError(
          'CONFLICT',
          `${driver.name} would be on ${String(load + run.jobIds.length)} stops on ${run.date} — over capacity`,
        );
      }

      const next: RunRecord = { ...run, driverId, status: 'assigned' };
      writeRun(next);
      syncJobsToRun(next);
    },

    async unassignRun(runId) {
      await latency(340, 160);

      const run = findRun(runId);
      if (run.status !== 'planning' && run.status !== 'assigned') {
        throw new ServiceError(
          'CONFLICT',
          `${run.name} has already started — taking it off the driver needs a call first`,
        );
      }

      const next: RunRecord = { ...run, driverId: null, status: 'planning' };
      writeRun(next);
      syncJobsToRun(next);
    },

    /* ── Reading it ─────────────────────────────────────────────────────── */

    async runSheet(runId) {
      await latency();

      const run = findRun(runId);
      const driver = DRIVERS.find((candidate) => candidate.id === run.driverId);
      const jobs = stopsOf(run);

      const stops: RunSheetStop[] = jobs.map((job, index) => {
        return {
          id: job.id,
          sequence: index + 1,
          jobNumber: job.jobNumber,
          status: job.status,
          accountName: job.accountName,
          builderName: job.builderName,
          siteName: job.siteName,
          lotNumber: job.lotNumber,
          // Previously `site?.addressLine ?? job.siteName` — a silent fallback
          // that printed a site's NAME where a driver expected a street address.
          addressLine: job.addressLine,
          suburb: job.suburb,
          zone: job.zone,
          poNumber: job.poNumber,
          contactName: job.siteContactName,
          contactMobile: job.siteContactMobile,
          expectedAreaM2: job.expectedAreaM2,
          bagCount: job.bagCount,
          accessNotes: job.accessNotes,
          craneAvailable: job.craneAvailable,
          inductionRequired: job.inductionRequired,
          serviceLevel: job.serviceLevel,
          latitude: job.latitude,
          longitude: job.longitude,
        };
      });

      const runSheet: RunSheet = {
        runId: run.id,
        runNumber: run.runNumber,
        runName: run.name,
        status: run.status,
        sequenceForDay: sequenceForDay(run),
        driverId: run.driverId,
        driverName: driver?.name ?? null,
        driverMobile: driver?.mobile ?? null,
        vehicleLabel: driver?.vehicleLabel ?? null,
        date: run.date,
        suburbs: suburbsOf(jobs),
        stops,
        totalExpectedAreaM2: totalArea(jobs),
        totalBags: stops.reduce((sum, stop) => sum + stop.bagCount, 0),
        optimisedAt: run.optimisedAt,
        tipOff: run.tipOff,
      };

      return runSheet;
    },

    async mapPins(date) {
      await latency();

      return store.jobs
        .filter((job) => job.readyDate === date && isAllocatable(job))
        .map<MapPin>((job) => {
          const run = runForJob(job.id);

          return {
            id: job.id,
            jobNumber: job.jobNumber,
            latitude: job.latitude,
            longitude: job.longitude,
            status: job.status,
            accountName: job.accountName,
            siteName: job.siteName,
            suburb: job.suburb,
            zone: job.zone,
            driverName: job.driverName,
            runId: run?.id ?? null,
            runName: run?.name ?? null,
            serviceLevel: job.serviceLevel,
            atRisk: isAtRisk(job),
          };
        });
    },

    async drivers() {
      await latency(160, 90);

      return DRIVERS.map<Driver>((driver) => {
        const today = new Date().toISOString().slice(0, 10);
        const load = store.runs
          .filter((run) => run.driverId === driver.id && run.date === today)
          .reduce((sum, run) => sum + run.jobIds.length, 0);

        return {
          id: driver.id,
          name: driver.name,
          mobile: driver.mobile,
          vehicleRego: driver.vehicleRego,
          vehicleLabel: driver.vehicleLabel,
          status: !driver.active ? 'off' : load > 0 ? 'on-run' : 'available',
          dailyJobCapacity: driver.dailyJobCapacity,
          nextComplianceExpiry: driver.nextComplianceExpiry,
          lastSyncAt: driver.active ? new Date(Date.now() - 6 * 60_000).toISOString() : null,
          pendingSyncActions: 0,
        };
      });
    },
  };
}
