import type {
  PageMeta,
  Role,
  Vehicle,
  VehicleDefectState,
  VehicleDraft,
  VehicleExpenseDraft,
  VehicleListItem,
} from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { vehicleRepository, type ListVehiclesQuery } from './vehicle.repository.js';

const log = logger.child({ module: 'fleet' });

/**
 * The fleet (M9.7 · F43).
 *
 * ── What this domain is really for ────────────────────────────────────────
 * One number: cost per kilometre. Matt's framing is that the odometer and the
 * expenses go IN and that figure comes OUT — so nothing here accepts a cost
 * per kilometre, a total, or a "last serviced" date. Every one of them is
 * derived, because a typed figure is one somebody can quietly make wrong.
 *
 * The second thing it is for is not grounding a truck by accident: registration
 * and service expiries are the two dates that stop a vehicle legally, and both
 * are surfaced with a state rather than left to somebody remembering.
 */

export interface Caller {
  userId: string;
  name: string;
  roles: readonly Role[];
}

/** Who may see the fleet. Cost data is commercial. */
const FLEET_ROLES = new Set<Role>(['super-admin', 'operations', 'allocator', 'office-staff']);

/** Who may change it. An allocator books a service; they do not buy trucks. */
const FLEET_EDITOR_ROLES = new Set<Role>(['super-admin', 'operations']);

export const vehicleService = {
  async list(
    query: ListVehiclesQuery,
    caller: Caller,
  ): Promise<{ data: VehicleListItem[]; meta: PageMeta }> {
    assertFleet(caller);
    return vehicleRepository.list(query);
  },

  async get(id: string, caller: Caller): Promise<Vehicle> {
    assertFleet(caller);

    const vehicle = await vehicleRepository.findById(id);
    if (!vehicle) throw AppError.notFound('No such vehicle');

    return vehicle;
  },

  async create(draft: VehicleDraft, caller: Caller): Promise<VehicleListItem> {
    assertEditor(caller);

    if (await vehicleRepository.regoTaken(draft.rego)) {
      throw AppError.conflict(
        `${draft.rego} is already on the fleet. Reactivate it rather than adding it twice.`,
      );
    }

    const id = await vehicleRepository.create(toUpsert(draft));

    const created = await vehicleRepository.findById(id);
    if (!created) throw new Error('Vehicle vanished immediately after being created');

    log.info({ vehicleId: id, rego: draft.rego, by: caller.name }, 'vehicle added to the fleet');
    return created;
  },

  async update(id: string, draft: VehicleDraft, caller: Caller): Promise<Vehicle> {
    assertEditor(caller);

    if (await vehicleRepository.regoTaken(draft.rego, id)) {
      throw AppError.conflict(`${draft.rego} belongs to another vehicle`);
    }

    const changed = await vehicleRepository.update(id, toUpsert(draft));
    if (!changed) throw AppError.notFound('No such vehicle');

    log.info({ vehicleId: id, by: caller.name }, 'vehicle updated');
    return this.get(id, caller);
  },

  /**
   * In service, or off the road.
   *
   * ⚠️ Never a delete. A truck that did 400 jobs last year has to stay
   * attributable — the same rule as a suspended user.
   */
  async setActive(id: string, active: boolean, caller: Caller): Promise<Vehicle> {
    assertEditor(caller);

    const existing = await vehicleRepository.findById(id);
    if (!existing) throw AppError.notFound('No such vehicle');

    if (existing.active === active) {
      throw AppError.conflict(
        `${existing.rego} is already ${active ? 'in service' : 'out of service'}`,
      );
    }

    /*
     * Taking a truck off the road clears its driver. Leaving somebody paired
     * with a vehicle that cannot be used would show them as crewed on the
     * dispatch board while the truck sits in a workshop.
     */
    if (!active && existing.assignedDriverName) {
      await vehicleRepository.assignDriver(id, null);
    }

    await vehicleRepository.setActive(id, active);

    log.info({ vehicleId: id, rego: existing.rego, active, by: caller.name }, 'vehicle availability changed');
    return this.get(id, caller);
  },

  /** Pairs a driver with a truck. One-to-one — see the repository. */
  async assignDriver(id: string, driverName: string | null, caller: Caller): Promise<Vehicle> {
    assertFleet(caller);

    const existing = await vehicleRepository.findById(id);
    if (!existing) throw AppError.notFound('No such vehicle');

    if (driverName && !existing.active) {
      // Crewing a truck that is off the road puts a driver on the board for a
      // vehicle sitting in a workshop.
      throw AppError.conflict(
        `${existing.rego} is out of service — put it back in service before assigning a driver`,
      );
    }

    await vehicleRepository.assignDriver(id, driverName?.trim() || null);

    log.info({ vehicleId: id, driverName, by: caller.name }, 'vehicle driver assignment changed');
    return this.get(id, caller);
  },

  /**
   * F43 — the input side of cost per kilometre.
   *
   * Returns the WHOLE vehicle because one expense moves the odometer, the
   * totals, the cost per kilometre and — when it is a service — the maintenance
   * history with it. Returning just the expense would leave four figures on
   * screen stale.
   */
  async addExpense(
    id: string,
    draft: VehicleExpenseDraft,
    caller: Caller,
  ): Promise<Vehicle> {
    assertFleet(caller);

    const existing = await vehicleRepository.findById(id);
    if (!existing) throw AppError.notFound('No such vehicle');

    /*
     * ⚠️ A reading that goes BACKWARDS is refused rather than accepted quietly.
     *
     * An odometer cannot decrease, so a lower number is a typo — and a typo
     * here does not look wrong, it just makes the distance denominator smaller
     * and the cost per kilometre larger. That is the one figure this screen
     * exists to produce.
     *
     * A reading EQUAL to the current one is fine: two invoices from the same
     * visit share it.
     */
    if (draft.odometerKm < existing.odometerKm) {
      throw AppError.validation('That odometer reading is lower than the last one', [
        {
          path: 'odometerKm',
          message: `${existing.rego} is already on ${String(existing.odometerKm)} km — check the reading`,
        },
      ]);
    }

    await vehicleRepository.addExpense({
      vehicleId: id,
      incurredOn: draft.incurredOn,
      odometerKm: draft.odometerKm,
      kind: draft.kind,
      description: draft.description,
      amountExGst: draft.amountExGst,
      supplier: draft.supplier?.trim() || null,
      recordedBy: caller.name,
    });

    log.info(
      { vehicleId: id, kind: draft.kind, amount: draft.amountExGst, by: caller.name },
      'vehicle expense recorded',
    );

    return this.get(id, caller);
  },

  /** W113 — booking the next service. The allocator's job. */
  async setNextService(id: string, dueOn: string | null, caller: Caller): Promise<Vehicle> {
    assertFleet(caller);

    const changed = await vehicleRepository.setNextService(id, dueOn);
    if (!changed) throw AppError.notFound('No such vehicle');

    log.info({ vehicleId: id, dueOn, by: caller.name }, 'next service booked');
    return this.get(id, caller);
  },

  /**
   * F43 — logging a renewal rolls the expiry forward by the vehicle's period.
   *
   * ── Why the expense is optional but belongs here ──────────────────────────
   * `registration` is already an expense kind, and the moment somebody renews
   * is the only moment they have the amount in front of them. Making them come
   * back later is asking for a cost per kilometre that quietly understates.
   */
  async renewRegistration(
    id: string,
    expense: VehicleExpenseDraft | null,
    caller: Caller,
  ): Promise<Vehicle> {
    assertEditor(caller);

    const registration = await vehicleRepository.findRegistration(id);
    if (!registration) throw AppError.notFound('No such vehicle');

    /*
     * Rolled forward from the EXPIRY, not from today.
     *
     * A rego renewed a fortnight early still runs to twelve months from when it
     * would have lapsed — measuring from today would silently give away those
     * two weeks every single year.
     */
    const newExpiry = addMonths(registration.expiresOn, registration.periodMonths);

    await vehicleRepository.renewRegistration(id, newExpiry);

    if (expense) {
      await vehicleRepository.addExpense({
        vehicleId: id,
        incurredOn: expense.incurredOn,
        odometerKm: expense.odometerKm,
        // Forced, whatever the caller sent: this is a registration renewal, and
        // filing it as anything else breaks the one report it belongs in.
        kind: 'registration',
        description: expense.description,
        amountExGst: expense.amountExGst,
        supplier: expense.supplier?.trim() || null,
        recordedBy: caller.name,
      });
    }

    log.info(
      {
        vehicleId: id,
        rego: registration.rego,
        from: registration.expiresOn,
        to: newExpiry,
        withExpense: expense !== null,
        by: caller.name,
      },
      'registration renewed',
    );

    return this.get(id, caller);
  },

  /**
   * M4.9 · W33 — moves a driver-reported defect along.
   *
   * `scheduled` is the state that was missing: "booked in for Thursday" is
   * neither broken-and-ignored nor fixed, and it is what the workshop works
   * from.
   */
  async setDefectState(
    vehicleId: string,
    defectId: string,
    state: VehicleDefectState,
    caller: Caller,
  ): Promise<Vehicle> {
    assertFleet(caller);

    const vehicle = await vehicleRepository.findById(vehicleId);
    if (!vehicle) throw AppError.notFound('No such vehicle');

    // Matched by rego, the same way the defect was found — see the repository.
    const changed = await vehicleRepository.setDefectState(defectId, vehicle.rego, state);
    if (!changed) throw AppError.notFound('No such defect on this vehicle');

    log.info({ vehicleId, defectId, state, by: caller.name }, 'defect state changed');
    return this.get(vehicleId, caller);
  },

  /** M9.8 — what is expiring, for the reminder sweep. */
  async expiringSoon(days: number, caller: Caller) {
    assertFleet(caller);
    return vehicleRepository.expiringSoon(days);
  },
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function toUpsert(draft: VehicleDraft) {
  return {
    rego: draft.rego.trim().toUpperCase(),
    label: draft.label.trim(),
    type: draft.type,
    make: draft.make.trim(),
    model: draft.model.trim(),
    year: draft.year,
    odometerKm: draft.odometerKm,
    registrationExpiresOn: draft.registrationExpiresOn,
    registrationPeriodMonths: draft.registrationPeriodMonths,
    purchasedOn: draft.purchasedOn,
    notes: draft.notes.trim(),
  };
}

/**
 * Adds calendar months to a date-only string.
 *
 * ⚠️ Clamps to the end of the month. Adding six months to 31 August gives
 * 28 February, not 3 March — a registration that silently gained three days
 * every renewal would drift out of step with what the RMS actually says.
 */
function addMonths(isoDate: string, months: number): string {
  const [year = 0, month = 1, day = 1] = isoDate.split('-').map(Number);

  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDayOfTarget = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();

  target.setUTCDate(Math.min(day, lastDayOfTarget));
  return target.toISOString().slice(0, 10);
}

function assertFleet(caller: Caller): void {
  if (!caller.roles.some((role) => FLEET_ROLES.has(role))) {
    throw AppError.forbidden('The fleet is for office staff');
  }
}

function assertEditor(caller: Caller): void {
  if (!caller.roles.some((role) => FLEET_EDITOR_ROLES.has(role))) {
    // An allocator books a service and pairs a driver; buying and retiring
    // trucks is a different decision.
    throw AppError.forbidden('Only operations can add or change a vehicle');
  }
}
