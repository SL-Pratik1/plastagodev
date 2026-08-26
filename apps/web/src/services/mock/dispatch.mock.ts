import type {
  AllocationBoard,
  Driver,
  DriverDay,
  Job,
  MapPin,
  RunSheet,
  RunSheetStop,
} from '@plastago/shared';
import { ServiceError } from '../service-error';
import type { DispatchService } from '../types';
import { ACTIVE_DRIVERS, DRIVERS } from './fixtures/reference';
import { latency } from './mock-transport';
import { findJob, isAtRisk, store } from './store';

/**
 * Allocation and dispatch (M3).
 *
 * Manual by design. There is no auto-assign and no routing here because both are
 * out of scope — with two drivers and ~7 jobs a day, a human clustering by
 * geography on a map is faster and more transparent than a rules engine, and
 * that is what M3.1 and M3.3 actually ask for.
 */

const ALLOCATABLE = ['booked', 'assigned', 'acknowledged', 'in-transit', 'arrived'] as const;

function isAllocatable(job: Job): boolean {
  return (ALLOCATABLE as readonly string[]).includes(job.status);
}

/** Stop order is by suburb then job number — a stable stand-in for a sequence. */
function sequenceFor(jobs: Job[]): Job[] {
  return [...jobs].sort((a, b) => a.suburb.localeCompare(b.suburb) || a.jobNumber - b.jobNumber);
}

export function createMockDispatchService(): DispatchService {
  return {
    async board(date) {
      await latency();

      const forDate = store.jobs.filter((job) => job.readyDate === date && isAllocatable(job));

      const unallocated = forDate
        .filter((job) => job.driverId === null)
        .map((job) => ({
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
        }))
        // Urgent first, then whatever is closest to breaching (M3.5).
        .sort((a, b) => {
          if (a.serviceLevel !== b.serviceLevel) return a.serviceLevel === 'urgent' ? -1 : 1;
          if (a.atRisk !== b.atRisk) return a.atRisk ? -1 : 1;
          return a.targetDate.localeCompare(b.targetDate);
        });

      const drivers: DriverDay[] = ACTIVE_DRIVERS.map((driver) => {
        const assigned = sequenceFor(forDate.filter((job) => job.driverId === driver.id));

        return {
          driverId: driver.id,
          driverName: driver.name,
          date,
          status: assigned.length > 0 ? 'on-run' : 'available',
          capacity: driver.dailyJobCapacity,
          assignedCount: assigned.length,
          jobs: assigned.map((job, index) => ({
            id: job.id,
            jobNumber: job.jobNumber,
            sequence: index + 1,
            status: job.status,
            accountName: job.accountName,
            siteName: job.siteName,
            suburb: job.suburb,
            zone: job.zone,
            serviceLevel: job.serviceLevel,
            expectedAreaM2: job.expectedAreaM2,
            atRisk: isAtRisk(job),
          })),
        };
      });

      const board: AllocationBoard = { date, unallocated, drivers };
      return board;
    },

    async assign(jobId, driverId, date) {
      await latency(380, 180);

      const job = findJob(jobId);
      if (!job) throw new ServiceError('NOT_FOUND', `No job ${jobId}`);

      const driver = DRIVERS.find((candidate) => candidate.id === driverId);
      if (!driver) throw new ServiceError('NOT_FOUND', `No driver ${driverId}`);
      if (!driver.active) {
        throw new ServiceError('CONFLICT', `${driver.name} is not an active driver`);
      }

      // Capacity is a real constraint, not decoration: over-filling a run is how
      // a day quietly becomes undeliverable.
      const load = store.jobs.filter(
        (candidate) =>
          candidate.driverId === driverId &&
          candidate.readyDate === date &&
          isAllocatable(candidate),
      ).length;

      if (load >= driver.dailyJobCapacity) {
        throw new ServiceError(
          'CONFLICT',
          `${driver.name} already has ${String(load)} jobs on ${date} — at capacity`,
        );
      }

      const updated: Job = {
        ...job,
        driverId: driver.id,
        driverName: driver.name,
        status: job.status === 'booked' ? 'assigned' : job.status,
        events: [
          ...job.events,
          {
            id: `${job.id.slice(0, 6)}${String(job.events.length).padStart(18, '0')}`,
            at: new Date().toISOString(),
            label: 'Allocated to driver',
            actor: 'Matthew Browne',
            status: 'assigned',
            detail: driver.name,
            latitude: null,
            longitude: null,
          },
        ],
      };

      store.jobs = store.jobs.map((candidate) => (candidate.id === jobId ? updated : candidate));
    },

    async unassign(jobId) {
      await latency(340, 160);

      const job = findJob(jobId);
      if (!job) throw new ServiceError('NOT_FOUND', `No job ${jobId}`);
      // Once a driver has acknowledged and set off, pulling the job out from
      // under them is not an allocation change — it is a conversation.
      if (job.status !== 'assigned' && job.status !== 'booked') {
        throw new ServiceError(
          'CONFLICT',
          'The driver has already started this job — reassigning needs a call first',
        );
      }

      const updated: Job = { ...job, driverId: null, driverName: null, status: 'booked' };
      store.jobs = store.jobs.map((candidate) => (candidate.id === jobId ? updated : candidate));
    },

    async runSheet(driverId, date) {
      await latency();

      const driver = DRIVERS.find((candidate) => candidate.id === driverId);
      if (!driver) throw new ServiceError('NOT_FOUND', `No driver ${driverId}`);

      const jobs = sequenceFor(
        store.jobs.filter(
          (job) => job.driverId === driverId && job.readyDate === date && isAllocatable(job),
        ),
      );

      const stops: RunSheetStop[] = jobs.map((job, index) => {
        const site = store.sites.find((candidate) => candidate.id === job.siteId);

        return {
          id: job.id,
          sequence: index + 1,
          jobNumber: job.jobNumber,
          status: job.status,
          accountName: job.accountName,
          builderName: job.builderName,
          siteName: job.siteName,
          lotNumber: site?.lotNumber ?? null,
          addressLine: site?.addressLine ?? job.siteName,
          suburb: job.suburb,
          zone: job.zone,
          customerReference: job.customerReference,
          contactName: site?.siteContactName ?? null,
          contactMobile: site?.siteContactMobile ?? null,
          expectedAreaM2: job.expectedAreaM2,
          bagCount: job.bagCount,
          accessNotes: site?.accessNotes ?? '',
          craneAvailable: site?.craneAvailable ?? false,
          inductionRequired: site?.inductionRequired ?? false,
          serviceLevel: job.serviceLevel,
          latitude: site?.latitude ?? 0,
          longitude: site?.longitude ?? 0,
        };
      });

      const runSheet: RunSheet = {
        driverId: driver.id,
        driverName: driver.name,
        driverMobile: driver.mobile,
        vehicleLabel: driver.vehicleLabel,
        date,
        stops,
        totalExpectedAreaM2: stops.reduce((sum, stop) => sum + stop.expectedAreaM2, 0),
        totalBags: stops.reduce((sum, stop) => sum + stop.bagCount, 0),
      };

      return runSheet;
    },

    async mapPins(date) {
      await latency();

      return store.jobs
        .filter((job) => job.readyDate === date && isAllocatable(job))
        .map<MapPin>((job) => {
          const site = store.sites.find((candidate) => candidate.id === job.siteId);
          return {
            id: job.id,
            jobNumber: job.jobNumber,
            latitude: site?.latitude ?? 0,
            longitude: site?.longitude ?? 0,
            status: job.status,
            accountName: job.accountName,
            siteName: job.siteName,
            suburb: job.suburb,
            zone: job.zone,
            driverName: job.driverName,
            serviceLevel: job.serviceLevel,
            atRisk: isAtRisk(job),
          };
        });
    },

    async drivers() {
      await latency(160, 90);

      return DRIVERS.map<Driver>((driver) => {
        const today = new Date().toISOString().slice(0, 10);
        const load = store.jobs.filter(
          (job) => job.driverId === driver.id && job.readyDate === today && isAllocatable(job),
        ).length;

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
