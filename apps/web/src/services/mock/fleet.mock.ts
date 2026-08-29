import type {
  DriverListItem,
  DriverPerformance,
  DriverProfile,
  Vehicle,
  VehicleDefectState,
  VehicleDraft,
  VehicleExpense,
  VehicleExpenseDraft,
  VehicleListItem,
} from '@plastago/shared';
import { ServiceError } from '../service-error';
import type { DriverService, VehicleService } from '../types';
import { applyListQuery, byDate, byNumber, byText } from './list-query';
import { centsToMoney, DRIVERS, objectId } from './fixtures/reference';
import {
  buildVehicles,
  CREDENTIAL_LEAD_DAYS,
  credentialsFor,
  expiryState,
  REGO_LEAD_DAYS,
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

let vehicles: Vehicle[] = buildVehicles();

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

/**
 * Every derived field, recalculated from the expense log.
 *
 * ── Why one function and not a change per mutation ─────────────────────────
 * Cost per kilometre, total spend, distance covered, the last service date, the
 * odometer and both expiry badges are all *outputs*. Logging one service moves
 * five of them at once and a renewal moves a sixth. Updating them at each call
 * site is how a list and a detail page start disagreeing — so nothing writes a
 * derived field directly; callers change the inputs and call this.
 *
 * The odometer takes the HIGHEST reading seen rather than the newest, because a
 * back-dated expense is a correction to history, not news that the truck drove
 * backwards.
 */
function recompute(vehicle: Vehicle): Vehicle {
  const expenses = [...vehicle.expenses].sort((a, b) => b.incurredOn.localeCompare(a.incurredOn));

  const totalCents = expenses.reduce(
    (sum, expense) => sum + Math.round(Number(expense.amountExGst) * 100),
    0,
  );
  const readings = expenses.map((expense) => expense.odometerKm);
  const odometerKm = Math.max(vehicle.odometerKm, ...readings, 0);
  const oldest = readings.length > 0 ? Math.min(...readings) : null;
  const distance = oldest === null ? null : odometerKm - oldest;
  const lastService = expenses.find((expense) => expense.kind === 'service');

  return {
    ...vehicle,
    expenses,
    odometerKm,
    totalExpensesExGst: centsToMoney(totalCents),
    distanceSinceFirstExpenseKm: distance !== null && distance > 0 ? distance : null,
    costPerKm:
      distance !== null && distance > 0 ? centsToMoney(Math.round(totalCents / distance)) : null,
    lastServiceOn: lastService?.incurredOn ?? null,
    serviceState:
      vehicle.nextServiceDueOn === null
        ? 'valid'
        : expiryState(vehicle.nextServiceDueOn, REGO_LEAD_DAYS),
    registrationState: expiryState(vehicle.registrationExpiresOn, REGO_LEAD_DAYS),
    openDefectCount: vehicle.defects.filter((defect) => defect.state !== 'resolved').length,
  };
}

/** Save one vehicle back to the store, recomputed. Returns a copy. */
function commit(id: string, change: (vehicle: Vehicle) => Vehicle): Vehicle {
  const index = vehicles.findIndex((candidate) => candidate.id === id);
  const existing = vehicles[index];
  if (index === -1 || !existing) throw new ServiceError('NOT_FOUND', `No vehicle ${id}`);

  const updated = recompute(change(existing));
  vehicles[index] = updated;
  return { ...updated };
}

let nextVehicleSeq = 500;

function toExpense(draft: VehicleExpenseDraft): VehicleExpense {
  nextVehicleSeq += 1;
  return { id: objectId('ex', nextVehicleSeq), ...draft };
}

/**
 * Server-side validation, mirrored from the form.
 *
 * Same reasoning as the user service: a mock that accepts anything teaches the
 * UI to skip the error path it will meet in production. The rego clash check in
 * particular can ONLY live here — the form cannot know the rest of the fleet.
 */
function validateVehicle(draft: VehicleDraft, id: string | null): void {
  const fieldErrors: Record<string, string> = {};

  const clash = vehicles.find(
    (vehicle) => vehicle.rego.toUpperCase() === draft.rego.toUpperCase() && vehicle.id !== id,
  );
  if (clash) fieldErrors.rego = `${draft.rego} is already in the fleet`;

  // An expiry in the distant past is a mistyped year, not a very overdue truck.
  if (draft.registrationExpiresOn < '2000-01-01') {
    fieldErrors.registrationExpiresOn = 'Check the year on this date';
  }
  if (draft.purchasedOn && draft.purchasedOn > todayIso()) {
    fieldErrors.purchasedOn = 'A purchase date cannot be in the future';
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new ServiceError('VALIDATION_FAILED', 'Vehicle is not valid', { fieldErrors });
  }
}

function validateExpense(draft: VehicleExpenseDraft, vehicle: Vehicle): void {
  const fieldErrors: Record<string, string> = {};

  if (draft.incurredOn > todayIso()) {
    fieldErrors.incurredOn = 'An expense cannot be dated in the future';
  }
  if (Number(draft.amountExGst) <= 0) {
    fieldErrors.amountExGst = 'Enter the amount paid, excluding GST';
  }

  /*
   * ⚠️ A warning would be the wrong call here. A reading below one already
   * logged makes `distanceSinceFirstExpenseKm` — and therefore cost per
   * kilometre — silently wrong, and a quietly wrong cost per kilometre is worse
   * than a blocked form, because nobody ever goes looking for it.
   */
  const highest = vehicle.expenses.reduce((max, expense) => Math.max(max, expense.odometerKm), 0);
  if (draft.odometerKm < highest) {
    fieldErrors.odometerKm = `Below the highest reading logged (${highest.toLocaleString('en-AU')} km)`;
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new ServiceError('VALIDATION_FAILED', 'Expense is not valid', { fieldErrors });
  }
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

    async create(draft: VehicleDraft) {
      await latency(460, 220);
      validateVehicle(draft, null);

      nextVehicleSeq += 1;
      const created = recompute({
        id: objectId('vh', nextVehicleSeq),
        rego: draft.rego,
        label: draft.label,
        type: draft.type,
        active: true,
        odometerKm: draft.odometerKm,
        assignedDriverName: null,
        costPerKm: null,
        lastServiceOn: null,
        /*
         * Nothing is known about servicing yet, and inventing a date would put
         * a brand-new truck on the overdue list on the day it was added — which
         * is exactly the noise that made them stop trusting the old module.
         */
        nextServiceDueOn: null,
        serviceState: 'valid',
        registrationExpiresOn: draft.registrationExpiresOn,
        registrationState: 'valid',
        openDefectCount: 0,
        make: draft.make,
        model: draft.model,
        year: draft.year,
        registrationPeriodMonths: draft.registrationPeriodMonths,
        purchasedOn: draft.purchasedOn,
        notes: draft.notes,
        expenses: [],
        defects: [],
        totalExpensesExGst: '0.00',
        distanceSinceFirstExpenseKm: null,
      });

      vehicles = [created, ...vehicles];
      return vehicleListItem(created);
    },

    async update(id, draft: VehicleDraft) {
      await latency(460, 220);
      validateVehicle(draft, id);

      return commit(id, (vehicle) => ({
        ...vehicle,
        rego: draft.rego,
        label: draft.label,
        type: draft.type,
        make: draft.make,
        model: draft.model,
        year: draft.year,
        // Only ever raised. The expense log owns the reading, and accepting a
        // lower number here would rewrite the distance every cost divides by.
        odometerKm: Math.max(vehicle.odometerKm, draft.odometerKm),
        registrationExpiresOn: draft.registrationExpiresOn,
        registrationPeriodMonths: draft.registrationPeriodMonths,
        purchasedOn: draft.purchasedOn,
        notes: draft.notes,
      }));
    },

    async setActive(id, active) {
      await latency(340, 160);
      return commit(id, (vehicle) => ({ ...vehicle, active }));
    },

    async assignDriver(id, driverName) {
      await latency(340, 160);
      return commit(id, (vehicle) => ({ ...vehicle, assignedDriverName: driverName }));
    },

    async addExpense(id, draft: VehicleExpenseDraft) {
      await latency(480, 220);
      const existing = vehicles.find((candidate) => candidate.id === id);
      if (!existing) throw new ServiceError('NOT_FOUND', `No vehicle ${id}`);
      validateExpense(draft, existing);

      return commit(id, (vehicle) => ({
        ...vehicle,
        expenses: [toExpense(draft), ...vehicle.expenses],
      }));
    },

    async setDefectState(vehicleId, defectId, state: VehicleDefectState) {
      await latency(420, 200);
      return commit(vehicleId, (vehicle) => ({
        ...vehicle,
        defects: vehicle.defects.map((defect) =>
          defect.id === defectId
            ? { ...defect, state, resolvedOn: state === 'resolved' ? todayIso() : null }
            : defect,
        ),
      }));
    },

    async setNextService(id, dueOn) {
      await latency(360, 180);
      return commit(id, (vehicle) => ({ ...vehicle, nextServiceDueOn: dueOn }));
    },

    async renewRegistration(id, expense) {
      await latency(520, 240);
      const existing = vehicles.find((candidate) => candidate.id === id);
      if (!existing) throw new ServiceError('NOT_FOUND', `No vehicle ${id}`);
      if (expense) validateExpense(expense, existing);

      return commit(id, (vehicle) => {
        // F43 — "on renewal, log it and the date rolls forward by the registered
        // period". Rolling from the CURRENT expiry, not from today, so a late
        // renewal does not quietly shorten the next period.
        const next = new Date(`${vehicle.registrationExpiresOn}T00:00:00Z`);
        next.setUTCMonth(next.getUTCMonth() + vehicle.registrationPeriodMonths);

        return {
          ...vehicle,
          registrationExpiresOn: next.toISOString().slice(0, 10),
          expenses: expense ? [toExpense(expense), ...vehicle.expenses] : vehicle.expenses,
        };
      });
    },
  };
}

/** Shared with the reports mock so vehicle reporting reads the same fleet. */
export function allVehicles(): readonly Vehicle[] {
  return vehicles;
}
