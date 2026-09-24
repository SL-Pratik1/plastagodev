import type {
  ExpiryState,
  PageMeta,
  Vehicle,
  VehicleDefect,
  VehicleExpense,
  VehicleExpenseKind,
  VehicleListItem,
  VehicleType,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { centsToMoney, fromDecimal128, moneyToCents, toDecimal128 } from '../../lib/money.js';
import { VehicleDefectModel } from '../driver/defect.model.js';
import { VehicleExpenseModel, VehicleModel } from './vehicle.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 */

type ExpiryFilter = 'expired' | 'due-soon' | 'valid';

export interface ListVehiclesQuery {
  page: number;
  pageSize: number;
  sort?: string | undefined;
  q?: string | undefined;
  type?: VehicleType | undefined;
  status?: 'active' | 'inactive' | undefined;
  registration?: ExpiryFilter | undefined;
  service?: ExpiryFilter | undefined;
  defects?: 'open' | 'none' | undefined;
}

export interface UpsertVehicleInput {
  rego: string;
  label: string;
  type: VehicleType;
  make: string;
  model: string;
  year: number | null;
  odometerKm: number;
  registrationExpiresOn: string;
  registrationPeriodMonths: number;
  purchasedOn: string | null;
  notes: string;
}

export interface AddExpenseInput {
  vehicleId: string;
  incurredOn: string;
  odometerKm: number;
  kind: VehicleExpenseKind;
  description: string;
  amountExGst: string;
  supplier: string | null;
  recordedBy: string;
}

interface RawVehicle {
  _id: mongoose.Types.ObjectId;
  rego: string;
  label: string;
  type: VehicleType;
  make: string;
  model: string;
  year: number | null;
  odometerKm: number;
  active: boolean;
  assignedDriverName: string | null;
  registrationExpiresOn: string;
  registrationPeriodMonths: number;
  nextServiceDueOn: string | null;
  purchasedOn: string | null;
  notes: string;
}

interface RawExpense {
  _id: mongoose.Types.ObjectId;
  vehicleId: mongoose.Types.ObjectId;
  incurredOn: string;
  odometerKm: number;
  kind: VehicleExpenseKind;
  description: string;
  amountExGst: mongoose.Types.Decimal128;
  supplier: string | null;
}

/**
 * What every derived figure on a vehicle is computed from.
 *
 * Kept as one shape so the list and the detail screen cannot disagree: they run
 * the same function over the same rows.
 */
interface Derived {
  totalCents: number;
  costPerKm: string | null;
  lastServiceOn: string | null;
  distanceKm: number | null;
}

const SORTABLE: Record<string, string> = {
  rego: 'rego',
  label: 'label',
  type: 'type',
  odometerKm: 'odometerKm',
  registrationExpiresOn: 'registrationExpiresOn',
  nextServiceDueOn: 'nextServiceDueOn',
};

/**
 * M9.8 — how far ahead something counts as due.
 *
 * 30 days for both. Long enough that a workshop booking can be made without
 * hurry; short enough that a badge showing for three months stops being read.
 */
const DUE_SOON_DAYS = 30;

export const vehicleRepository = {
  async list(query: ListVehiclesQuery): Promise<{ data: VehicleListItem[]; meta: PageMeta }> {
    const filter: Record<string, unknown> = {};
    // Each of these can bring its own `$or`, so they collect here rather than
    // fight over a single `filter.$or` key — the text search below needs one
    // too, and the last write would otherwise silently drop the others.
    const clauses: Record<string, unknown>[] = [];

    if (query.type) filter.type = query.type;
    if (query.status !== undefined) filter.active = query.status === 'active';

    if (query.q) {
      const term = escapeRegex(query.q);
      clauses.push({
        $or: [
          { rego: { $regex: term, $options: 'i' } },
          { label: { $regex: term, $options: 'i' } },
          { assignedDriverName: { $regex: term, $options: 'i' } },
        ],
      });
    }

    if (query.registration) clauses.push(expiryClause('registrationExpiresOn', query.registration));
    if (query.service) clauses.push(expiryClause('nextServiceDueOn', query.service));

    if (query.defects) {
      const openRegos = await openDefectRegos();
      clauses.push({ rego: query.defects === 'open' ? { $in: [...openRegos] } : { $nin: [...openRegos] } });
    }

    if (clauses.length > 0) filter.$and = clauses;

    const sortKey = query.sort?.replace(/^-/, '') ?? '';
    const direction: 1 | -1 = query.sort?.startsWith('-') ? -1 : 1;
    const sortField = SORTABLE[sortKey];

    // In-service first by default: an off-road truck is not what anybody opens
    // this screen to look at.
    const sort: Record<string, 1 | -1> = sortField
      ? { [sortField]: direction }
      : { active: -1, rego: 1 };

    const [rows, total] = await Promise.all([
      VehicleModel.find(filter)
        .sort(sort)
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean<RawVehicle[]>(),
      VehicleModel.countDocuments(filter),
    ]);

    const ids = rows.map((row) => row._id);

    /*
     * Expenses and defect counts for the WHOLE page in two queries. The derived
     * figures need every expense a vehicle has, so doing this per row is the
     * N+1 that turns a 20-truck fleet list into 41 queries.
     */
    const [expenses, defectCounts] = await Promise.all([
      VehicleExpenseModel.find({ vehicleId: { $in: ids } })
        .sort({ incurredOn: 1 })
        .lean<RawExpense[]>(),
      openDefectCounts(rows.map((row) => row.rego)),
    ]);

    const byVehicle = groupByVehicle(expenses);

    return {
      data: rows.map((row) =>
        toListItem(
          row,
          derive(byVehicle.get(row._id.toHexString()) ?? []),
          defectCounts.get(row.rego) ?? 0,
        ),
      ),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  },

  /** One vehicle with its expense log and its defects. */
  async findById(id: string): Promise<Vehicle | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    const row = await VehicleModel.findById(id).lean<RawVehicle>();
    if (!row) return null;

    const [expenses, defects] = await Promise.all([
      VehicleExpenseModel.find({ vehicleId: row._id }).sort({ incurredOn: 1 }).lean<RawExpense[]>(),
      /*
       * Defects are matched by REGO, not by an id.
       *
       * A driver reports one from the phone against the plate they can see —
       * they may be in a hired truck, or one the office has not registered yet
       * (see `defect.model.ts`). Matching on rego is what makes those reports
       * findable rather than orphaned.
       */
      VehicleDefectModel.find({ vehicleRego: row.rego }).sort({ occurredAt: -1 }).lean(),
    ]);

    const derived = derive(expenses);

    return {
      ...toListItem(row, derived, defects.filter((defect) => defect.status !== 'resolved').length),
      make: row.make,
      model: row.model,
      year: row.year,
      registrationPeriodMonths: row.registrationPeriodMonths,
      purchasedOn: row.purchasedOn,
      notes: row.notes,
      expenses: expenses.map(
        (expense): VehicleExpense => ({
          id: expense._id.toHexString(),
          incurredOn: expense.incurredOn,
          odometerKm: expense.odometerKm,
          kind: expense.kind,
          description: expense.description,
          amountExGst: fromDecimal128(expense.amountExGst),
          supplier: expense.supplier,
        }),
      ),
      defects: defects.map(
        (defect): VehicleDefect => ({
          id: defect._id.toHexString(),
          reportedOn: defect.occurredAt.toISOString().slice(0, 10),
          reportedBy: defect.reportedByName,
          summary: defect.summary,
          /*
           * The driver app grades severity in ITS language — what a driver can
           * judge standing beside the truck. The fleet screen speaks the
           * workshop's. Mapped rather than shared, because "unroadworthy" is a
           * decision a driver makes and "high" is a priority a workshop sets.
           */
          severity: SEVERITY_TO_FLEET[defect.severity] ?? 'medium',
          state: defect.status,
          photoCount: defect.photoIds.length,
          resolvedOn: defect.resolvedAt ? defect.resolvedAt.toISOString().slice(0, 10) : null,
        }),
      ),
      totalExpensesExGst: centsToMoney(derived.totalCents),
      distanceSinceFirstExpenseKm: derived.distanceKm,
    };
  },

  async regoTaken(rego: string, excludeId?: string): Promise<boolean> {
    const filter: Record<string, unknown> = { rego: rego.trim().toUpperCase() };

    if (excludeId && mongoose.isValidObjectId(excludeId)) {
      filter._id = { $ne: new mongoose.Types.ObjectId(excludeId) };
    }

    return (await VehicleModel.countDocuments(filter)) > 0;
  },

  async create(input: UpsertVehicleInput): Promise<string> {
    const created = await VehicleModel.create({ ...input, active: true });
    return created._id.toHexString();
  },

  /**
   * Updates the editable fields.
   *
   * ⚠️ `active` and `assignedDriverName` are absent — they are decisions taken
   * on their own, off a menu, on a day when nobody is editing the make and
   * model. Folding them in would mean opening a nine-field dialog to take a
   * truck off the road.
   */
  async update(id: string, input: UpsertVehicleInput): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;

    const result = await VehicleModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: input },
    );

    return result.matchedCount === 1;
  },

  async setActive(id: string, active: boolean): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;

    const result = await VehicleModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { active } },
    );

    return result.matchedCount === 1;
  },

  /**
   * Pairs a driver with a truck.
   *
   * ⚠️ One-to-one. The driver is cleared off every OTHER vehicle first, because
   * a driver appearing on two trucks makes both screens lie about who is in
   * which — and the dispatch board reads this to label a run.
   */
  async assignDriver(id: string, driverName: string | null): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;

    if (driverName) {
      await VehicleModel.updateMany(
        { assignedDriverName: driverName, _id: { $ne: new mongoose.Types.ObjectId(id) } },
        { $set: { assignedDriverName: null } },
      );
    }

    const result = await VehicleModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { assignedDriverName: driverName } },
    );

    return result.matchedCount === 1;
  },

  /**
   * Records an expense.
   *
   * The odometer moves forward with it when the reading is higher — the newest
   * reading IS the current one, and letting the vehicle lag behind its own log
   * is how the two screens start disagreeing.
   */
  async addExpense(input: AddExpenseInput): Promise<void> {
    const vehicleId = new mongoose.Types.ObjectId(input.vehicleId);

    await VehicleExpenseModel.create({
      vehicleId,
      incurredOn: input.incurredOn,
      odometerKm: input.odometerKm,
      kind: input.kind,
      description: input.description,
      amountExGst: toDecimal128(input.amountExGst),
      supplier: input.supplier,
      recordedBy: input.recordedBy,
    });

    // Only ever upward: a service invoice entered late, with an older reading,
    // must not wind the truck back.
    await VehicleModel.updateOne(
      { _id: vehicleId, odometerKm: { $lt: input.odometerKm } },
      { $set: { odometerKm: input.odometerKm } },
    );
  },

  async setNextService(id: string, dueOn: string | null): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;

    const result = await VehicleModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { nextServiceDueOn: dueOn } },
    );

    return result.matchedCount === 1;
  },

  /** F43 — rolls the registration forward by its own period. */
  async renewRegistration(id: string, newExpiry: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;

    const result = await VehicleModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { registrationExpiresOn: newExpiry } },
    );

    return result.matchedCount === 1;
  },

  /** Moves a driver-reported defect along. Matched by rego, like the read. */
  async setDefectState(
    defectId: string,
    rego: string,
    state: 'open' | 'scheduled' | 'resolved',
  ): Promise<boolean> {
    if (!mongoose.isValidObjectId(defectId)) return false;

    const result = await VehicleDefectModel.updateOne(
      { _id: new mongoose.Types.ObjectId(defectId), vehicleRego: rego },
      {
        $set: {
          status: state,
          resolvedAt: state === 'resolved' ? new Date() : null,
        },
      },
    );

    return result.matchedCount === 1;
  },

  /** The current registration details, for the renewal arithmetic. */
  async findRegistration(
    id: string,
  ): Promise<{ rego: string; expiresOn: string; periodMonths: number } | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    const row = await VehicleModel.findById(id, {
      rego: 1,
      registrationExpiresOn: 1,
      registrationPeriodMonths: 1,
    }).lean<Pick<RawVehicle, 'rego' | 'registrationExpiresOn' | 'registrationPeriodMonths'>>();

    if (!row) return null;

    return {
      rego: row.rego,
      expiresOn: row.registrationExpiresOn,
      periodMonths: row.registrationPeriodMonths,
    };
  },

  /** M9.8 — everything expiring inside the window, for the reminder sweep. */
  async expiringSoon(days: number): Promise<
    Array<{ id: string; rego: string; label: string; kind: 'registration' | 'service'; dueOn: string }>
  > {
    const cutoff = shiftDays(days);

    const rows = await VehicleModel.find({
      active: true,
      $or: [
        { registrationExpiresOn: { $lte: cutoff } },
        { nextServiceDueOn: { $ne: null, $lte: cutoff } },
      ],
    }).lean<RawVehicle[]>();

    const due: Array<{
      id: string;
      rego: string;
      label: string;
      kind: 'registration' | 'service';
      dueOn: string;
    }> = [];

    for (const row of rows) {
      if (row.registrationExpiresOn <= cutoff) {
        due.push({
          id: row._id.toHexString(),
          rego: row.rego,
          label: row.label,
          kind: 'registration',
          dueOn: row.registrationExpiresOn,
        });
      }
      // Both can be due at once, and they are two different phone calls.
      if (row.nextServiceDueOn && row.nextServiceDueOn <= cutoff) {
        due.push({
          id: row._id.toHexString(),
          rego: row.rego,
          label: row.label,
          kind: 'service',
          dueOn: row.nextServiceDueOn,
        });
      }
    }

    return due.sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  },
};

/* ── Derivation ──────────────────────────────────────────────────────────── */

/**
 * Every computed figure on a vehicle, from its expense log alone.
 *
 * ── Why cost per kilometre uses the distance BETWEEN expenses ─────────────
 * Because the alternative — total cost ÷ current odometer — divides money
 * PlastaGo has spent by kilometres driven before they owned the truck, or
 * before anybody started logging. That produces a figure that looks precise and
 * is meaningless.
 *
 * So the denominator is first-logged reading → last-logged reading: the
 * distance the expense log actually covers. With fewer than two readings there
 * is no distance, and the honest answer is null rather than a number.
 */
function derive(expenses: RawExpense[]): Derived {
  const totalCents = expenses.reduce(
    (sum, expense) => sum + moneyToCents(fromDecimal128(expense.amountExGst)),
    0,
  );

  const services = expenses.filter((expense) => expense.kind === 'service');
  const lastServiceOn = services.length > 0 ? (services.at(-1)?.incurredOn ?? null) : null;

  if (expenses.length < 2) {
    return { totalCents, costPerKm: null, lastServiceOn, distanceKm: null };
  }

  const readings = expenses.map((expense) => expense.odometerKm);
  const distanceKm = Math.max(...readings) - Math.min(...readings);

  return {
    totalCents,
    // Zero distance means every expense was logged at the same reading — real
    // when a truck has been off the road, and still not a divisor.
    costPerKm: distanceKm > 0 ? centsToMoney(Math.round(totalCents / distanceKm)) : null,
    lastServiceOn,
    distanceKm,
  };
}

/**
 * M9.8 — valid, due soon, or expired.
 *
 * A null date is `valid`, not `due-soon`: an unbooked service is a different
 * problem from an overdue one, and colouring it red would train people to
 * ignore the colour.
 */
function expiryState(dueOn: string | null): ExpiryState {
  if (!dueOn) return 'valid';

  const today = todayIso();
  if (dueOn < today) return 'expired';
  return dueOn <= shiftDays(DUE_SOON_DAYS) ? 'due-soon' : 'valid';
}

/**
 * The list filter's version of `expiryState` — same thresholds, run in Mongo
 * instead of in JS, so a vehicle badged "due soon" on the page can never be
 * the one the "due soon" filter leaves out.
 */
function expiryClause(field: 'registrationExpiresOn' | 'nextServiceDueOn', state: ExpiryFilter): Record<string, unknown> {
  const today = todayIso();
  const soonCutoff = shiftDays(DUE_SOON_DAYS);

  if (state === 'expired') return { [field]: { $ne: null, $lt: today } };
  if (state === 'due-soon') return { [field]: { $ne: null, $gte: today, $lte: soonCutoff } };
  return { $or: [{ [field]: null }, { [field]: { $gt: soonCutoff } }] };
}

/** The driver app's language → the workshop's. See the note at the call site. */
const SEVERITY_TO_FLEET: Record<string, VehicleDefect['severity']> = {
  monitor: 'low',
  'needs-attention': 'medium',
  unroadworthy: 'high',
};

function toListItem(row: RawVehicle, derived: Derived, openDefectCount: number): VehicleListItem {
  return {
    id: row._id.toHexString(),
    rego: row.rego,
    label: row.label,
    type: row.type,
    active: row.active,
    odometerKm: row.odometerKm,
    assignedDriverName: row.assignedDriverName,
    costPerKm: derived.costPerKm,
    lastServiceOn: derived.lastServiceOn,
    nextServiceDueOn: row.nextServiceDueOn,
    serviceState: expiryState(row.nextServiceDueOn),
    registrationExpiresOn: row.registrationExpiresOn,
    registrationState: expiryState(row.registrationExpiresOn),
    openDefectCount,
  };
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function groupByVehicle(expenses: RawExpense[]): Map<string, RawExpense[]> {
  const grouped = new Map<string, RawExpense[]>();

  for (const expense of expenses) {
    const key = expense.vehicleId.toHexString();
    grouped.set(key, [...(grouped.get(key) ?? []), expense]);
  }

  return grouped;
}

/** Open defect counts per rego, in one query for the whole page. */
async function openDefectCounts(regos: string[]): Promise<Map<string, number>> {
  if (regos.length === 0) return new Map();

  const counts = await VehicleDefectModel.aggregate<{ _id: string; count: number }>([
    { $match: { vehicleRego: { $in: regos }, status: { $ne: 'resolved' } } },
    { $group: { _id: '$vehicleRego', count: { $sum: 1 } } },
  ]);

  return new Map(counts.map((row) => [row._id, row.count]));
}

/**
 * Every rego with at least one unresolved defect — fleet-wide, not just this
 * page. The "has open defects" filter has to select before pagination, so it
 * cannot reuse `openDefectCounts`, which is scoped to the rows already fetched.
 */
async function openDefectRegos(): Promise<Set<string>> {
  const rows = await VehicleDefectModel.aggregate<{ _id: string }>([
    { $match: { status: { $ne: 'resolved' } } },
    { $group: { _id: '$vehicleRego' } },
  ]);

  return new Set(rows.map((row) => row._id));
}

function todayIso(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}

function shiftDays(days: number): string {
  const now = new Date();
  now.setDate(now.getDate() + days);
  return now.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
