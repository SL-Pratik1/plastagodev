import type {
  DriverListItem,
  DriverPerformance,
  DriverProfile,
  Vehicle,
  VehicleListItem,
} from '@plastago/shared';
import { ServiceError } from '../service-error';
import type { DriverService, VehicleService } from '../types';
import { applyListQuery, byDate, byNumber, byText } from './list-query';
import { DRIVERS } from './fixtures/reference';
import {
  buildVehicles,
  CREDENTIAL_LEAD_DAYS,
  credentialsFor,
  expiryState,
  isoInDays,
  trainingFor,
} from './fixtures/fleet';
import { latency } from './mock-transport';
import { store, todayIso } from './store';

/**
 * Drivers (M9.8 · F53, M9.9 · F22) and vehicles (M9.7 · F43).
 *
 * ── Performance is computed from the job store ─────────────────────────────
 * Not baked into a fixture. The futile rate on a driver's profile has to be the
 * same number the dashboard shows, or the first person to compare them stops
 * trusting both. Same store, one calculation.
 */

const vehicles: Vehicle[] = buildVehicles();

/* ── Drivers ──────────────────────────────────────────────────────────────── */

function performanceFor(driverName: string): DriverPerformance {
  const jobs = store.jobs.filter((job) => job.driverName === driverName);
  const completed = jobs.filter(
    (job) => job.status === 'completed' || job.status === 'admin-complete',
  );
  const futile = jobs.filter((job) => job.status === 'futile');
  const contaminated = jobs.filter((job) =>
    job.charges.some((charge) => charge.code === 'contamination'),
  );
  const attempted = Math.max(1, completed.length + futile.length);

  const onSite = completed
    .map((job) => job.onSiteMinutes)
    .filter((minutes): minutes is number => minutes !== null)
    .sort((a, b) => a - b);

  // Their photo protocol expects roughly 10 shots per job; adherence is the
  // share of completed jobs that got at least 8.
  const withEnoughPhotos = completed.filter((job) => job.photos.length >= 8).length;

  // M2.4a — collected on or before ready date + 5 business days.
  const onTime = completed.filter(
    (job) => (job.completedAt ?? '').slice(0, 10) <= job.targetDate,
  ).length;

  // Roughly 11 weeks of history in the fixtures, ~5 working days a week.
  const workingDays = 55;

  return {
    periodLabel: 'Last 11 weeks',
    jobsCompleted: completed.length,
    jobsPerWorkingDay: Number((completed.length / workingDays).toFixed(1)),
    medianOnSiteMinutes: onSite.length > 0 ? (onSite[Math.floor(onSite.length / 2)] ?? null) : null,
    futileCount: futile.length,
    futileRatePercent: Number(((futile.length / attempted) * 100).toFixed(1)),
    contaminationCount: contaminated.length,
    contaminationRatePercent: Number(((contaminated.length / attempted) * 100).toFixed(1)),
    photoCompliancePercent:
      completed.length === 0 ? 0 : Number(((withEnoughPhotos / completed.length) * 100).toFixed(1)),
    slaAdherencePercent:
      completed.length === 0 ? 0 : Number(((onTime / completed.length) * 100).toFixed(1)),
    // Only measurable because F11 is full (continuous background location).
    distanceKm: completed.length * 42,
  };
}

function driverListItem(index: number): DriverListItem {
  const driver = DRIVERS[index];
  if (!driver) throw new ServiceError('NOT_FOUND', 'No such driver');

  const credentials = credentialsFor(index, driver.active);
  // The soonest expiry drives the reminder — that is the feature (F53).
  const dated = credentials
    .filter((credential) => credential.expiresOn !== null)
    .sort((a, b) => (a.expiresOn ?? '').localeCompare(b.expiresOn ?? ''));
  const soonest = dated[0]?.expiresOn ?? null;

  const today = todayIso();
  const jobsToday = store.jobs.filter(
    (job) =>
      job.driverId === driver.id &&
      job.readyDate === today &&
      ['booked', 'assigned', 'acknowledged', 'in-transit', 'arrived'].includes(job.status),
  ).length;

  return {
    id: driver.id,
    name: driver.name,
    mobile: driver.mobile,
    email: null,
    active: driver.active,
    // Confirmed on Call 2: "basically all of our guys are subcontractors".
    employment: 'subcontractor',
    vehicleRego: driver.vehicleRego,
    vehicleLabel: driver.vehicleLabel,
    dailyJobCapacity: driver.dailyJobCapacity,
    jobsToday,
    nextExpiryOn: soonest,
    nextExpiryState: expiryState(soonest, CREDENTIAL_LEAD_DAYS),
    lastSyncAt: driver.active ? new Date(Date.now() - 7 * 60_000).toISOString() : null,
    pendingSyncActions: 0,
  };
}

export function createMockDriverService(): DriverService {
  return {
    async list(query) {
      await latency();
      const rows = DRIVERS.map((_, index) => driverListItem(index));

      return applyListQuery(rows, query, {
        search: (driver) => [driver.name, driver.mobile, driver.vehicleRego, driver.vehicleLabel],
        filters: {
          status: (driver, value) => (value === 'active' ? driver.active : !driver.active),
          expiry: (driver, value) => driver.nextExpiryState === value,
          vehicle: (driver, value) =>
            value === 'assigned' ? driver.vehicleRego !== null : driver.vehicleRego === null,
        },
        sorters: {
          name: byText((driver) => driver.name),
          jobsToday: byNumber((driver) => driver.jobsToday),
          nextExpiryOn: byDate((driver) => driver.nextExpiryOn),
        },
        // Anything expiring floats to the top: this list exists to be chased.
        defaultSort: (a, b) => {
          const rank = { expired: 0, 'due-soon': 1, valid: 2 } as const;
          const byState = rank[a.nextExpiryState] - rank[b.nextExpiryState];
          return byState !== 0 ? byState : a.name.localeCompare(b.name);
        },
      });
    },

    async get(id) {
      await latency();
      const index = DRIVERS.findIndex((driver) => driver.id === id);
      if (index === -1) throw new ServiceError('NOT_FOUND', `No driver ${id}`);
      const base = driverListItem(index);

      const profile: DriverProfile = {
        ...base,
        startedOn: isoInDays(-(600 + index * 220)),
        notes: '',
        credentials: credentialsFor(index, base.active),
        training: trainingFor(index),
        performance: performanceFor(base.name),
      };

      return profile;
    },
  };
}

/* ── Vehicles ─────────────────────────────────────────────────────────────── */

function vehicleListItem(vehicle: Vehicle): VehicleListItem {
  const {
    make: _make,
    model: _model,
    year: _year,
    registrationPeriodMonths: _period,
    purchasedOn: _purchased,
    notes: _notes,
    expenses: _expenses,
    defects: _defects,
    totalExpensesExGst: _total,
    distanceSinceFirstExpenseKm: _distance,
    ...listItem
  } = vehicle;
  return listItem;
}

export function createMockVehicleService(): VehicleService {
  return {
    async list(query) {
      await latency();

      return applyListQuery(vehicles.map(vehicleListItem), query, {
        search: (vehicle) => [vehicle.rego, vehicle.label, vehicle.assignedDriverName],
        filters: {
          status: (vehicle, value) => (value === 'active' ? vehicle.active : !vehicle.active),
          type: (vehicle, value) => vehicle.type === value,
          registration: (vehicle, value) => vehicle.registrationState === value,
          service: (vehicle, value) => vehicle.serviceState === value,
          defects: (vehicle, value) =>
            value === 'open' ? vehicle.openDefectCount > 0 : vehicle.openDefectCount === 0,
        },
        sorters: {
          rego: byText((vehicle) => vehicle.rego),
          label: byText((vehicle) => vehicle.label),
          odometerKm: byNumber((vehicle) => vehicle.odometerKm),
          costPerKm: byNumber((vehicle) =>
            vehicle.costPerKm === null ? null : Number(vehicle.costPerKm),
          ),
          registrationExpiresOn: byDate((vehicle) => vehicle.registrationExpiresOn),
          nextServiceDueOn: byDate((vehicle) => vehicle.nextServiceDueOn),
        },
        // Same reasoning as drivers: overdue first.
        defaultSort: (a, b) => {
          const rank = { expired: 0, 'due-soon': 1, valid: 2 } as const;
          const worst = (item: VehicleListItem) =>
            Math.min(rank[item.registrationState], rank[item.serviceState]);
          const byState = worst(a) - worst(b);
          return byState !== 0 ? byState : a.rego.localeCompare(b.rego);
        },
      });
    },

    async get(id) {
      await latency();
      const vehicle = vehicles.find((candidate) => candidate.id === id);
      if (!vehicle) throw new ServiceError('NOT_FOUND', `No vehicle ${id}`);
      return { ...vehicle };
    },

    async renewRegistration(id) {
      await latency(520, 240);
      const index = vehicles.findIndex((candidate) => candidate.id === id);
      const vehicle = vehicles[index];
      if (index === -1 || !vehicle) throw new ServiceError('NOT_FOUND', `No vehicle ${id}`);

      // F43 — "on renewal, log it and the date rolls forward by the registered
      // period". Rolling from the CURRENT expiry, not from today, so a late
      // renewal does not quietly shorten the next period.
      const next = new Date(`${vehicle.registrationExpiresOn}T00:00:00Z`);
      next.setUTCMonth(next.getUTCMonth() + vehicle.registrationPeriodMonths);
      const registrationExpiresOn = next.toISOString().slice(0, 10);

      const updated: Vehicle = {
        ...vehicle,
        registrationExpiresOn,
        registrationState: expiryState(registrationExpiresOn, 14),
      };
      vehicles[index] = updated;
      return { ...updated };
    },

    async resolveDefect(vehicleId, defectId) {
      await latency(460, 220);
      const index = vehicles.findIndex((candidate) => candidate.id === vehicleId);
      const vehicle = vehicles[index];
      if (index === -1 || !vehicle) throw new ServiceError('NOT_FOUND', `No vehicle ${vehicleId}`);

      const defects = vehicle.defects.map((defect) =>
        defect.id === defectId
          ? { ...defect, state: 'resolved' as const, resolvedOn: todayIso() }
          : defect,
      );

      const updated: Vehicle = {
        ...vehicle,
        defects,
        openDefectCount: defects.filter((defect) => defect.state !== 'resolved').length,
      };
      vehicles[index] = updated;
      return { ...updated };
    },
  };
}

/** Shared with the reports mock so vehicle reporting reads the same fleet. */
export function allVehicles(): readonly Vehicle[] {
  return vehicles;
}
