import type { Role, VehicleDraft, VehicleExpenseDraft } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The fleet (M9.7 · F43).
 *
 * ── What is actually under test ───────────────────────────────────────────
 * The one number this domain exists to produce: cost per kilometre. Matt's
 * framing is odometer and expenses IN, cost per kilometre OUT — so the tests
 * are about the things that would quietly make that figure wrong. A backwards
 * odometer reading, a renewal measured from the wrong date, a truck crewed
 * while it sits in a workshop.
 */

let created: Array<Record<string, unknown>> = [];
let updated: Array<Record<string, unknown>> = [];
let expenses: Array<Record<string, unknown>> = [];
let assignments: Array<{ id: string; driverName: string | null }> = [];
let activeChanges: Array<{ id: string; active: boolean }> = [];
let renewals: Array<{
  id: string;
  newExpiry: string;
  fromExpiry: string;
  periodMonths: number;
  renewedById: string;
}> = [];
/** False when the expiry moved since it was read — a second click. */
let renewMatches = true;
let defectStates: Array<{ defectId: string; vehicleId: string; state: string }> = [];
let nextServices: Array<{ id: string; dueOn: string | null }> = [];

/** What the repository reports back. Set per test. */
let stored: Record<string, unknown> | null = null;
let regoTaken = false;
let registration: { rego: string; expiresOn: string; periodMonths: number } | null = null;
let defectMatches = true;

/** What the pre-start list was asked for (23 Oct). */
const preStartQueries: Array<{ id: string; page: number; pageSize: number; date?: string }> = [];

vi.mock('../src/domains/fleet/vehicle.repository.js', () => ({
  vehicleRepository: {
    list: () =>
      Promise.resolve({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } }),
    findById: () => Promise.resolve(stored),
    preStarts: (id: string, query: { page: number; pageSize: number; date?: string }) => {
      preStartQueries.push({ id, ...query });
      return Promise.resolve(
        id === 'missing'
          ? null
          : { data: [], meta: { page: query.page, pageSize: query.pageSize, total: 0, totalPages: 1 } },
      );
    },
    regoTaken: () => Promise.resolve(regoTaken),
    create: (input: Record<string, unknown>) => {
      created.push(input);
      return Promise.resolve('veh1');
    },
    update: (id: string, input: Record<string, unknown>) => {
      updated.push({ id, ...input });
      return Promise.resolve(true);
    },
    setActive: (id: string, active: boolean) => {
      activeChanges.push({ id, active });
      return Promise.resolve(true);
    },
    assignDriver: (id: string, driverName: string | null) => {
      assignments.push({ id, driverName });
      return Promise.resolve(true);
    },
    addExpense: (input: Record<string, unknown>) => {
      expenses.push(input);
      return Promise.resolve();
    },
    setNextService: (id: string, dueOn: string | null) => {
      nextServices.push({ id, dueOn });
      return Promise.resolve(true);
    },
    findRegistration: () => Promise.resolve(registration),
    renewRegistration: (
      id: string,
      renewal: { toExpiry: string; fromExpiry: string; periodMonths: number; renewedById: string },
    ) => {
      if (!renewMatches) return Promise.resolve(false);
      renewals.push({
        id,
        newExpiry: renewal.toExpiry,
        fromExpiry: renewal.fromExpiry,
        periodMonths: renewal.periodMonths,
        renewedById: renewal.renewedById,
      });
      return Promise.resolve(true);
    },
    setDefectState: (defectId: string, vehicleId: string, state: string) => {
      if (!defectMatches) return Promise.resolve(false);
      defectStates.push({ defectId, vehicleId, state });
      return Promise.resolve(true);
    },
    expiringSoon: () => Promise.resolve([]),
  },
}));

const { vehicleService } = await import('../src/domains/fleet/vehicle.service.js');

const OPERATIONS = {
  userId: 'usr0000000000000000000o1',
  name: 'Renee Alvarez',
  roles: ['operations'] as Role[],
};

const ALLOCATOR = {
  userId: 'usr0000000000000000000a1',
  name: 'Dean Kelly',
  roles: ['allocator', 'driver'] as Role[],
};

const DRIVER = {
  userId: 'usr0000000000000000000d1',
  name: 'Troy Holm',
  roles: ['driver'] as Role[],
};

const ID = 'a'.repeat(24);

function vehicle(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    rego: 'BQ12AB',
    label: 'Isuzu FVZ crane truck',
    type: 'crane-truck',
    active: true,
    odometerKm: 184_320,
    assignedDriverName: 'Troy Holm',
    costPerKm: '0.42',
    lastServiceOn: '2026-06-01',
    nextServiceDueOn: null,
    serviceState: 'valid',
    registrationExpiresOn: '2027-03-31',
    registrationState: 'valid',
    openDefectCount: 1,
    make: 'Isuzu',
    model: 'FVZ',
    year: 2019,
    registrationPeriodMonths: 12,
    purchasedOn: '2019-05-01',
    notes: '',
    expenses: [],
    defects: [],
    totalExpensesExGst: '4200.00',
    distanceSinceFirstExpenseKm: 10_000,
    ...overrides,
  };
}

function draft(overrides: Partial<VehicleDraft> = {}): VehicleDraft {
  return {
    rego: 'BQ12AB',
    label: 'Isuzu FVZ crane truck',
    type: 'crane-truck',
    make: 'Isuzu',
    model: 'FVZ',
    year: 2019,
    odometerKm: 184_320,
    registrationExpiresOn: '2027-03-31',
    registrationPeriodMonths: 12,
    purchasedOn: '2019-05-01',
    notes: '',
    ...overrides,
  };
}

function expense(overrides: Partial<VehicleExpenseDraft> = {}): VehicleExpenseDraft {
  return {
    incurredOn: '2026-09-08',
    odometerKm: 190_000,
    kind: 'service',
    description: 'A service',
    amountExGst: '1250.00',
    supplier: 'Isuzu Penrith',
    ...overrides,
  };
}

beforeEach(() => {
  created = [];
  updated = [];
  expenses = [];
  assignments = [];
  activeChanges = [];
  renewals = [];
  defectStates = [];
  nextServices = [];
  stored = vehicle();
  regoTaken = false;
  registration = { rego: 'BQ12AB', expiresOn: '2027-03-31', periodMonths: 12 };
  defectMatches = true;
  renewMatches = true;
});

describe('who may see and change the fleet', () => {
  it('lets an allocator read it', async () => {
    await expect(vehicleService.list({ page: 1, pageSize: 20 }, ALLOCATOR)).resolves.toBeDefined();
  });

  /* Cost per kilometre is commercial. */
  it('keeps drivers out', async () => {
    await expect(vehicleService.list({ page: 1, pageSize: 20 }, DRIVER)).rejects.toMatchObject({
      status: 403,
    });
  });

  /*
   * An allocator books a service and pairs a driver; buying and retiring trucks
   * is a different decision.
   */
  it('lets an allocator book a service but not add a vehicle', async () => {
    await expect(
      vehicleService.setNextService(ID, '2026-11-01', ALLOCATOR),
    ).resolves.toBeDefined();

    await expect(vehicleService.create(draft(), ALLOCATOR)).rejects.toMatchObject({ status: 403 });
    expect(created).toHaveLength(0);
  });

  it('lets operations add one', async () => {
    await expect(vehicleService.create(draft(), OPERATIONS)).resolves.toBeDefined();
  });
});

describe('⚠️ protecting the odometer', () => {
  /*
   * The heart of it. A lower reading is a typo, and a typo here does not look
   * wrong — it makes the distance denominator smaller and the cost per kilometre
   * larger, which is the one figure this screen exists to produce.
   */
  it('refuses an expense whose reading goes backwards', async () => {
    await expect(
      vehicleService.addExpense(ID, expense({ odometerKm: 180_000 }), OPERATIONS),
    ).rejects.toMatchObject({ status: 422 });

    expect(expenses).toHaveLength(0);
  });

  it('accepts a reading equal to the current one', async () => {
    // Two invoices from the same workshop visit share a reading.
    await expect(
      vehicleService.addExpense(ID, expense({ odometerKm: 184_320 }), OPERATIONS),
    ).resolves.toBeDefined();

    expect(expenses).toHaveLength(1);
  });

  it('accepts a reading that moves forward', async () => {
    await vehicleService.addExpense(ID, expense({ odometerKm: 190_000 }), OPERATIONS);

    expect(expenses[0]).toMatchObject({ odometerKm: 190_000, amountExGst: '1250.00' });
  });

  it('records who entered it', async () => {
    await vehicleService.addExpense(ID, expense(), OPERATIONS);

    expect(expenses[0]?.recordedBy).toBe('Renee Alvarez');
  });
});

describe('registration renewal (F43)', () => {
  /*
   * ⚠️ Rolled forward from the EXPIRY, not from today.
   *
   * A rego renewed a fortnight early still runs to twelve months from when it
   * would have lapsed — measuring from today silently gives away those two
   * weeks every single year.
   */
  it('rolls forward from the expiry date, not today', async () => {
    registration = { rego: 'BQ12AB', expiresOn: '2027-03-31', periodMonths: 12 };

    await vehicleService.renewRegistration(ID, null, OPERATIONS);

    expect(renewals[0]?.newExpiry).toBe('2028-03-31');
  });

  it('honours a six-month period', async () => {
    registration = { rego: 'BQ12AB', expiresOn: '2026-09-30', periodMonths: 6 };

    await vehicleService.renewRegistration(ID, null, OPERATIONS);

    // The same DAY of the month, six months on — 30 September to 30 March.
    // Not the end of March: that would hand over an extra day each renewal.
    expect(renewals[0]?.newExpiry).toBe('2027-03-30');
  });

  /*
   * ⚠️ Month-end clamping. Six months from 31 August is 28 February, not
   * 3 March — a registration gaining three days every renewal would drift out
   * of step with what the RMS actually says.
   */
  it('clamps to the end of a shorter month', async () => {
    registration = { rego: 'BQ12AB', expiresOn: '2026-08-31', periodMonths: 6 };

    await vehicleService.renewRegistration(ID, null, OPERATIONS);

    expect(renewals[0]?.newExpiry).toBe('2027-02-28');
  });

  it('records the invoice alongside the renewal when there is one', async () => {
    await vehicleService.renewRegistration(
      ID,
      expense({ kind: 'registration', description: 'Rego renewal', amountExGst: '890.00' }),
      OPERATIONS,
    );

    expect(renewals).toHaveLength(1);
    expect(expenses[0]).toMatchObject({ kind: 'registration', amountExGst: '890.00' });
  });

  /* Filing it as anything else breaks the one report it belongs in. */
  it('forces the expense kind to registration', async () => {
    await vehicleService.renewRegistration(ID, expense({ kind: 'tyres' }), OPERATIONS);

    expect(expenses[0]?.kind).toBe('registration');
  });

  it('renews without an expense', async () => {
    await vehicleService.renewRegistration(ID, null, OPERATIONS);

    expect(renewals).toHaveLength(1);
    expect(expenses).toHaveLength(0);
  });

  it('404s a vehicle that does not exist', async () => {
    registration = null;

    await expect(vehicleService.renewRegistration(ID, null, OPERATIONS)).rejects.toMatchObject({
      status: 404,
    });
  });

  /*
   * Matt, 21 Oct: "You can have 12 months or change to three months." The
   * length is chosen on each renewal and kept with it.
   */
  it('uses the length chosen on this renewal and keeps it with the renewal', async () => {
    registration = { rego: 'BQ12AB', expiresOn: '2027-03-31', periodMonths: 12 };

    await vehicleService.renewRegistration(ID, null, OPERATIONS, 3);

    expect(renewals[0]).toMatchObject({
      newExpiry: '2027-06-30',
      fromExpiry: '2027-03-31',
      periodMonths: 3,
    });
  });

  it('records who logged it by their user id', async () => {
    await vehicleService.renewRegistration(ID, null, OPERATIONS);

    expect(renewals[0]?.renewedById).toBe(OPERATIONS.userId);
  });

  it("falls back to the vehicle's current length when none is chosen", async () => {
    registration = { rego: 'BQ12AB', expiresOn: '2027-03-31', periodMonths: 6 };

    await vehicleService.renewRegistration(ID, null, OPERATIONS);

    expect(renewals[0]?.periodMonths).toBe(6);
  });

  it('refuses to roll forward twice when the expiry already moved', async () => {
    renewMatches = false;

    await expect(
      vehicleService.renewRegistration(ID, null, OPERATIONS, 12),
    ).rejects.toMatchObject({ status: 409 });
    expect(expenses).toHaveLength(0);
  });
});

describe('taking a truck off the road', () => {
  /*
   * Leaving somebody paired with an unusable vehicle shows them as crewed on
   * the dispatch board while the truck sits in a workshop.
   */
  it('clears the driver when a vehicle goes out of service', async () => {
    stored = vehicle({ active: true, assignedDriverName: 'Troy Holm' });

    await vehicleService.setActive(ID, false, OPERATIONS);

    expect(assignments[0]).toEqual({ id: ID, driverName: null });
    expect(activeChanges[0]).toEqual({ id: ID, active: false });
  });

  it('does not try to clear a driver that is not there', async () => {
    stored = vehicle({ active: true, assignedDriverName: null });

    await vehicleService.setActive(ID, false, OPERATIONS);

    expect(assignments).toHaveLength(0);
  });

  it('says so when it is already in that state', async () => {
    stored = vehicle({ active: true });

    await expect(vehicleService.setActive(ID, true, OPERATIONS)).rejects.toMatchObject({
      status: 409,
    });
  });

  /* Crewing a truck that is off the road puts a driver on the board for a
   * vehicle in a workshop. */
  it('refuses to assign a driver to an out-of-service vehicle', async () => {
    stored = vehicle({ active: false });

    await expect(vehicleService.assignDriver(ID, 'Troy Holm', OPERATIONS)).rejects.toMatchObject({
      status: 409,
    });
    expect(assignments).toHaveLength(0);
  });

  it('allows unassigning one even when it is out of service', async () => {
    stored = vehicle({ active: false });

    await expect(vehicleService.assignDriver(ID, null, OPERATIONS)).resolves.toBeDefined();
    expect(assignments[0]?.driverName).toBeNull();
  });
});

describe('vehicles and their plates', () => {
  it('refuses a plate already on the fleet', async () => {
    regoTaken = true;

    await expect(vehicleService.create(draft(), OPERATIONS)).rejects.toMatchObject({
      status: 409,
    });
    expect(created).toHaveLength(0);
  });

  it('uppercases the plate so one truck cannot become two', async () => {
    await vehicleService.create(draft({ rego: 'bq12ab' }), OPERATIONS);

    expect(created[0]?.rego).toBe('BQ12AB');
  });

  /*
   * ⚠️ `active` and `assignedDriverName` are not on the edit path. They are
   * decisions taken off a menu; folding them in would mean opening a nine-field
   * dialog to take a truck off the road.
   */
  it('cannot change availability or crew through an edit', async () => {
    await vehicleService.update(ID, draft({ label: 'New label' }), OPERATIONS);

    expect(updated[0]).not.toHaveProperty('active');
    expect(updated[0]).not.toHaveProperty('assignedDriverName');
    expect(activeChanges).toHaveLength(0);
    expect(assignments).toHaveLength(0);
  });
});

describe('driver-reported defects (M4.9 · W33)', () => {
  it('books one in for the workshop', async () => {
    await vehicleService.setDefectState(ID, 'def1', 'scheduled', ALLOCATOR);

    // `scheduled` is the state that was missing: "booked in for Thursday" is
    // neither broken-and-ignored nor fixed.
    // Matched on the vehicle's id, not its plate: new plates keep the defects.
    expect(defectStates[0]).toEqual({ defectId: 'def1', vehicleId: ID, state: 'scheduled' });
  });

  it('resolves one', async () => {
    await vehicleService.setDefectState(ID, 'def1', 'resolved', OPERATIONS);

    expect(defectStates[0]?.state).toBe('resolved');
  });

  /* Matched by the vehicle, so a defect id from another truck matches nothing. */
  it('404s a defect that is not on this vehicle', async () => {
    defectMatches = false;

    await expect(
      vehicleService.setDefectState(ID, 'def-other', 'resolved', OPERATIONS),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('404s a vehicle that does not exist', async () => {
    stored = null;

    await expect(
      vehicleService.setDefectState(ID, 'def1', 'resolved', OPERATIONS),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('booking a service (W113)', () => {
  it('books a date', async () => {
    await vehicleService.setNextService(ID, '2026-11-01', ALLOCATOR);

    expect(nextServices[0]).toEqual({ id: ID, dueOn: '2026-11-01' });
  });

  it('clears the booking', async () => {
    await vehicleService.setNextService(ID, null, ALLOCATOR);

    expect(nextServices[0]?.dueOn).toBeNull();
  });
});

/**
 * A vehicle's pre-start checks, a page at a time (23 Oct) — one a day per
 * truck grows without end, so the vehicle page no longer carries them all.
 */
describe("a vehicle's pre-start checks, paged (23 Oct)", () => {
  it('passes the page, the size and the day through', async () => {
    preStartQueries.length = 0;

    const page = await vehicleService.preStarts('veh1', { page: 2, pageSize: 10, date: '2026-10-23' }, OPERATIONS);

    expect(preStartQueries).toEqual([{ id: 'veh1', page: 2, pageSize: 10, date: '2026-10-23' }]);
    expect(page.meta).toMatchObject({ page: 2, pageSize: 10 });
  });

  it('answers 404 for a vehicle that does not exist', async () => {
    await expect(vehicleService.preStarts('missing', { page: 1, pageSize: 10 }, OPERATIONS)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses a driver — the fleet screens are for the office', async () => {
    await expect(vehicleService.preStarts('veh1', { page: 1, pageSize: 10 }, DRIVER)).rejects.toMatchObject({
      status: 403,
    });
  });
});
