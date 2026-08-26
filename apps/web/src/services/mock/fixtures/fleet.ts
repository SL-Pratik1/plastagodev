import type {
  DriverCredential,
  DriverTraining,
  ExpiryState,
  Vehicle,
  VehicleDefect,
  VehicleExpense,
} from '@plastago/shared';
import { centsToMoney, createRng, intBetween, objectId, pick } from './reference';

/**
 * Fleet fixtures — five vehicles, and the credential/training records behind the
 * driver profiles.
 *
 * ── Shaped to make the reminders real ─────────────────────────────────────
 * Four of their five vehicles currently show service dates **in the past**, and
 * they have this module in TransVirtual and do not maintain it. So the fixtures
 * reproduce that: some things are overdue, some are due soon, some are fine. A
 * dataset where everything is valid would make the whole reminder feature look
 * like decoration.
 */

/** Days from today until `iso`, negative if past. */
function daysUntil(iso: string): number {
  const target = new Date(`${iso}T00:00:00Z`).getTime();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target - today.getTime()) / 86400_000);
}

/**
 * Expiry state for a date, given the lead time that kind of record uses.
 *
 * The lead time is a parameter because the documented thresholds differ:
 * licences and tickets warn a **month** out (F53), registration **two weeks**
 * out (F43). Hard-coding one would make the other wrong.
 */
export function expiryState(iso: string | null, leadDays: number): ExpiryState {
  if (!iso) return 'valid';
  const days = daysUntil(iso);
  if (days < 0) return 'expired';
  if (days <= leadDays) return 'due-soon';
  return 'valid';
}

export function isoInDays(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

const CREDENTIAL_LEAD_DAYS = 30;
const REGO_LEAD_DAYS = 14;

/** Per-driver credential sets, deliberately including two problems. */
export function credentialsFor(driverIndex: number, driverActive: boolean): DriverCredential[] {
  const rng = createRng(7000 + driverIndex);

  // Driver 1 has a ticket expiring inside the reminder window; driver 2 has a
  // medical that has already lapsed. Both are the states the screen exists for.
  const offsets: Record<number, number[]> = {
    0: [420, 900, 21, 610],
    1: [500, 700, 260, -9],
    2: [120, 400, 300, 200],
    3: [90, 350, 280, 150],
  };
  const set = offsets[driverIndex] ?? [365, 365, 365, 365];

  const specs: Array<{ type: DriverCredential['type']; offset: number; doc: boolean }> = [
    { type: 'drivers-licence', offset: set[0] ?? 365, doc: true },
    { type: 'white-card', offset: set[1] ?? 365, doc: true },
    { type: 'crane-ticket-class-3', offset: set[2] ?? 365, doc: driverActive },
    { type: 'hvnl-medical', offset: set[3] ?? 365, doc: false },
  ];

  if (driverIndex === 0) {
    specs.push({ type: 'crane-ticket-class-4', offset: 540, doc: true });
  }

  return specs.map((spec, index) => {
    const expiresOn = isoInDays(spec.offset);
    return {
      id: objectId('cr', driverIndex * 10 + index),
      type: spec.type,
      reference: `${spec.type.slice(0, 3).toUpperCase()}-${String(intBetween(rng, 100000, 999999))}`,
      issuedOn: isoInDays(spec.offset - intBetween(rng, 700, 1400)),
      expiresOn,
      state: expiryState(expiresOn, CREDENTIAL_LEAD_DAYS),
      hasDocument: spec.doc,
    };
  });
}

/** F53 — training records. Short list, because that is what they keep. */
export function trainingFor(driverIndex: number): DriverTraining[] {
  const rng = createRng(8000 + driverIndex);
  const courses = [
    { name: 'Load restraint', months: 24 },
    { name: 'Crane operation refresher', months: 12 },
    { name: 'Site safety induction', months: 12 },
    { name: 'Chain of Responsibility awareness', months: 36 },
  ];

  return courses.slice(0, driverIndex === 0 ? 4 : 3).map((course, index) => {
    const completedOffset = -intBetween(rng, 60, 700);
    const expiresOn = isoInDays(completedOffset + course.months * 30);
    return {
      id: objectId('tr', driverIndex * 10 + index),
      name: course.name,
      completedOn: isoInDays(completedOffset),
      expiresOn,
      state: expiryState(expiresOn, CREDENTIAL_LEAD_DAYS),
      provider: pick(rng, ['TAFE NSW', 'SafeWork training', 'In-house', null]),
    };
  });
}

interface VehicleSeed {
  rego: string;
  label: string;
  type: Vehicle['type'];
  make: string;
  model: string;
  year: number;
  odometerKm: number;
  driver: string | null;
  regoOffset: number;
  serviceOffset: number;
  active: boolean;
}

/**
 * Five vehicles, matching the fleet size in their tenant.
 *
 * Registration and service offsets are chosen so the list shows one expired
 * rego, one due inside the two-week window, and service dates mostly in the
 * past — which is the real situation the reminder is meant to fix.
 */
const VEHICLE_SEEDS: readonly VehicleSeed[] = [
  {
    rego: 'BQ44JT',
    label: 'Isuzu FVZ crane truck',
    type: 'crane-truck',
    make: 'Isuzu',
    model: 'FVZ 260-300',
    year: 2021,
    odometerKm: 184320,
    driver: 'Troy Holm',
    regoOffset: 9,
    serviceOffset: -34,
    active: true,
  },
  {
    rego: 'CX18PL',
    label: 'Hino 500 crane truck',
    type: 'crane-truck',
    make: 'Hino',
    model: '500 FG 1628',
    year: 2020,
    odometerKm: 226880,
    driver: 'James Whiteley',
    regoOffset: 128,
    serviceOffset: -12,
    active: true,
  },
  {
    rego: 'DL92RS',
    label: '34T hooklift',
    type: 'hooklift',
    make: 'Volvo',
    model: 'FM 340',
    year: 2018,
    odometerKm: 402100,
    driver: null,
    regoOffset: -6,
    serviceOffset: -96,
    active: true,
  },
  {
    rego: 'EM55KD',
    label: 'Isuzu NPR tipper',
    type: 'crane-truck',
    make: 'Isuzu',
    model: 'NPR 45-155',
    year: 2019,
    odometerKm: 158740,
    driver: null,
    regoOffset: 240,
    serviceOffset: -61,
    active: true,
  },
  {
    rego: 'FT07WQ',
    label: 'Yard ute',
    type: 'ute',
    make: 'Toyota',
    model: 'Hilux SR',
    year: 2022,
    odometerKm: 76540,
    driver: null,
    regoOffset: 55,
    serviceOffset: 42,
    active: false,
  },
];

const EXPENSE_DESCRIPTIONS: Record<string, string[]> = {
  service: ['A service', 'B service', 'C service', 'Oil and filter change'],
  repair: ['Crane hydraulic hose', 'Tailgate latch', 'Air-con recharge', 'Brake actuator'],
  tyres: ['Two steer tyres', 'Full drive set', 'Puncture repair'],
  registration: ['Annual registration', 'Registration renewal'],
  other: ['Wash and detail', 'Safety decals', 'Fire extinguisher replacement'],
};

export function buildVehicles(): Vehicle[] {
  return VEHICLE_SEEDS.map((seed, index) => {
    const rng = createRng(9000 + index);
    const expenses: VehicleExpense[] = [];

    // Roughly two years of history, walking the odometer backwards so each
    // expense has a plausible reading — which is what makes cost/km computable.
    let odometer = seed.odometerKm;
    const count = seed.active ? intBetween(rng, 6, 11) : 3;

    for (let n = 0; n < count; n += 1) {
      const kind = pick(rng, [
        'service',
        'service',
        'repair',
        'tyres',
        'registration',
        'other',
      ] as const);
      const spend =
        kind === 'service'
          ? intBetween(rng, 68000, 210000)
          : kind === 'tyres'
            ? intBetween(rng, 90000, 340000)
            : kind === 'registration'
              ? intBetween(rng, 89000, 132000)
              : intBetween(rng, 12000, 145000);

      odometer -= intBetween(rng, 4200, 16000);

      expenses.push({
        id: objectId('ex', index * 20 + n),
        incurredOn: isoInDays(-intBetween(rng, 20 + n * 60, 90 + n * 70)),
        odometerKm: Math.max(0, odometer),
        kind,
        description: pick(rng, EXPENSE_DESCRIPTIONS[kind] ?? ['Maintenance']),
        amountExGst: centsToMoney(spend),
        supplier: pick(rng, ['Camden Truck Centre', 'Southwest Diesel', 'Bob Jane', null]),
      });
    }

    expenses.sort((a, b) => b.incurredOn.localeCompare(a.incurredOn));

    // M4.9 — driver-reported defects land against the vehicle.
    const defects: VehicleDefect[] = seed.active
      ? Array.from({ length: intBetween(rng, 0, 3) }, (_, n) => {
          const state = pick(rng, ['open', 'open', 'scheduled', 'resolved'] as const);
          const reportedOn = isoInDays(-intBetween(rng, 2, 70));
          return {
            id: objectId('df', index * 10 + n),
            reportedOn,
            reportedBy: seed.driver ?? 'Troy Holm',
            summary: pick(rng, [
              'Crane remote intermittent',
              'Nearside indicator not working',
              'Air leak from tank',
              'Windscreen chip spreading',
              'Tailgate slow to lift',
            ]),
            severity: pick(rng, ['low', 'medium', 'medium', 'high'] as const),
            state,
            photoCount: intBetween(rng, 0, 3),
            resolvedOn: state === 'resolved' ? isoInDays(-intBetween(rng, 1, 20)) : null,
          };
        })
      : [];

    const totalCents = expenses.reduce(
      (sum, expense) => sum + Math.round(Number(expense.amountExGst) * 100),
      0,
    );
    const oldest = expenses.at(-1);
    const distance = oldest ? seed.odometerKm - oldest.odometerKm : null;
    const registrationExpiresOn = isoInDays(seed.regoOffset);
    const lastServiceExpense = expenses.find((expense) => expense.kind === 'service');
    const nextServiceDueOn = isoInDays(seed.serviceOffset);

    return {
      id: objectId('vh', index + 1),
      rego: seed.rego,
      label: seed.label,
      type: seed.type,
      active: seed.active,
      odometerKm: seed.odometerKm,
      assignedDriverName: seed.driver,
      // Auto-calculated, which is the whole point of the expense log (F43).
      costPerKm: distance && distance > 0 ? centsToMoney(Math.round(totalCents / distance)) : null,
      lastServiceOn: lastServiceExpense?.incurredOn ?? null,
      nextServiceDueOn,
      serviceState: expiryState(nextServiceDueOn, REGO_LEAD_DAYS),
      registrationExpiresOn,
      registrationState: expiryState(registrationExpiresOn, REGO_LEAD_DAYS),
      openDefectCount: defects.filter((defect) => defect.state !== 'resolved').length,
      make: seed.make,
      model: seed.model,
      year: seed.year,
      registrationPeriodMonths: 12,
      purchasedOn: isoInDays(-intBetween(rng, 700, 2400)),
      notes: '',
      expenses,
      defects,
      totalExpensesExGst: centsToMoney(totalCents),
      distanceSinceFirstExpenseKm: distance && distance > 0 ? distance : null,
    };
  });
}

export { CREDENTIAL_LEAD_DAYS, REGO_LEAD_DAYS };
