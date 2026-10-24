import type {
  ExpiryState,
  PageMeta,
  Vehicle,
  VehicleDefect,
  VehicleExpense,
  VehicleExpenseKind,
  VehicleListItem,
  VehiclePreStart,
  VehicleType,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { centsToMoney, fromDecimal128, moneyToCents, toDecimal128 } from '../../lib/money.js';
import { VehicleDefectModel } from '../driver/defect.model.js';
import { JobPreStartModel } from '../jobs/job.model.js';
import { VehicleChoiceModel, VehicleExpenseModel, VehicleModel } from './vehicle.model.js';

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
  registrationRenewals?: Array<{
    renewedAt: Date;
    renewedBy: string;
    periodMonths: number;
    fromExpiry: string;
    toExpiry: string;
  }>;
}

interface RawPreStart {
  _id: mongoose.Types.ObjectId;
  completedAt: Date;
  driverName: string;
  odometerKm: number;
  itemsChecked: number;
  failedItems: Array<{ key: string; label: string; note?: string }>;
  items?: Array<{ key: string; label: string; state: VehiclePreStart['items'][number]['state']; note?: string }>;
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
      const openIds = await openDefectVehicleIds();
      clauses.push({ _id: query.defects === 'open' ? { $in: openIds } : { $nin: openIds } });
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
    const [expenses, defectCounts, driversToday, checkedToday] = await Promise.all([
      VehicleExpenseModel.find({ vehicleId: { $in: ids } })
        .sort({ incurredOn: 1 })
        .lean<RawExpense[]>(),
      openDefectCounts(ids),
      driversTodayOf(ids),
      preStartedToday(ids),
    ]);

    const byVehicle = groupByVehicle(expenses);

    return {
      data: rows.map((row) =>
        toListItem(
          row,
          derive(byVehicle.get(row._id.toHexString()) ?? []),
          defectCounts.get(row._id.toHexString()) ?? 0,
          driversToday.get(row._id.toHexString()) ?? null,
          checkedToday.has(row._id.toHexString()),
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

  /**
   * One page of a vehicle's pre-start checks, newest first (23 Oct) — all of
   * them, or one Sydney day's. Null when there is no such vehicle.
   */
  async preStarts(
    id: string,
    query: { page: number; pageSize: number; date?: string | undefined },
  ): Promise<{ data: VehiclePreStart[]; meta: PageMeta } | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const vehicle = await VehicleModel.findById(id).select({ _id: 1 }).lean<{ _id: mongoose.Types.ObjectId }>();
    if (!vehicle) return null;

    const filter: Record<string, unknown> = { vehicleId: vehicle._id };
    if (query.date) filter.date = query.date;

    const [rows, total] = await Promise.all([
      JobPreStartModel.find(filter)
        .sort({ completedAt: -1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean<RawPreStart[]>(),
      JobPreStartModel.countDocuments(filter),
    ]);

    return {
      data: rows.map(toPreStart),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  },

  /** One vehicle with its expense log, defects and pre-start checks. */
  async findById(id: string): Promise<Vehicle | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    const row = await VehicleModel.findById(id).lean<RawVehicle>();
    if (!row) return null;

    const [expenses, defects, preStartCount, driversToday, checkedToday] = await Promise.all([
      VehicleExpenseModel.find({ vehicleId: row._id }).sort({ incurredOn: 1 }).lean<RawExpense[]>(),
      // By the vehicle's id, not its plate: new plates keep the history.
      VehicleDefectModel.find({ vehicleId: row._id }).sort({ occurredAt: -1 }).lean(),
      // Matt, 21 Oct: pre-starts logged against the vehicle — counted here,
      // listed a page at a time by `preStarts`.
      JobPreStartModel.countDocuments({ vehicleId: row._id }),
      driversTodayOf([row._id]),
      preStartedToday([row._id]),
    ]);

    const derived = derive(expenses);

    return {
      ...toListItem(
        row,
        derived,
        defects.filter((defect) => defect.status !== 'resolved').length,
        driversToday.get(row._id.toHexString()) ?? null,
        checkedToday.has(row._id.toHexString()),
      ),
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
      preStartCount,
      registrationRenewals: [...(row.registrationRenewals ?? [])]
        .reverse()
        .map((renewal) => ({
          renewedAt: renewal.renewedAt.toISOString(),
          renewedBy: renewal.renewedBy,
          periodMonths: renewal.periodMonths,
          fromExpiry: renewal.fromExpiry,
          toExpiry: renewal.toExpiry,
        })),
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

  /**
   * F43 — rolls the registration forward and keeps the renewal, with the length
   * chosen for it, on the vehicle.
   *
   * Conditional on the expiry it rolled from, so a double-click cannot roll it
   * forward twice.
   */
  async renewRegistration(
    id: string,
    renewal: {
      renewedAt: Date;
      renewedById: string;
      renewedBy: string;
      periodMonths: number;
      fromExpiry: string;
      toExpiry: string;
    },
  ): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;
    const { renewedById, ...rest } = renewal;
    const entry = {
      ...rest,
      renewedById: mongoose.isValidObjectId(renewedById) ? new mongoose.Types.ObjectId(renewedById) : null,
    };

    const result = await VehicleModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id), registrationExpiresOn: renewal.fromExpiry },
      {
        $set: {
          registrationExpiresOn: renewal.toExpiry,
          // The next renewal starts from the length chosen this time.
          registrationPeriodMonths: renewal.periodMonths,
        },
        $push: { registrationRenewals: entry },
      },
    );

    return result.matchedCount === 1;
  },

  /** Moves a driver-reported defect along — only one filed against this vehicle. */
  async setDefectState(
    defectId: string,
    vehicleId: string,
    state: 'open' | 'scheduled' | 'resolved',
  ): Promise<boolean> {
    if (!mongoose.isValidObjectId(defectId) || !mongoose.isValidObjectId(vehicleId)) return false;

    const result = await VehicleDefectModel.updateOne(
      {
        _id: new mongoose.Types.ObjectId(defectId),
        vehicleId: new mongoose.Types.ObjectId(vehicleId),
      },
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

function toPreStart(check: RawPreStart): VehiclePreStart {
  return {
    id: check._id.toHexString(),
    completedAt: check.completedAt.toISOString(),
    driverName: check.driverName,
    odometerKm: check.odometerKm,
    itemsChecked: check.itemsChecked,
    failedItems: check.failedItems.map((item) => ({
      key: item.key,
      label: item.label,
      note: item.note ?? '',
    })),
    items: (check.items ?? []).map((item) => ({
      key: item.key,
      label: item.label,
      state: item.state,
      note: item.note ?? '',
    })),
  };
}

function toListItem(
  row: RawVehicle,
  derived: Derived,
  openDefectCount: number,
  driverToday: string | null,
  preStartToday: boolean,
): VehicleListItem {
  return {
    id: row._id.toHexString(),
    rego: row.rego,
    label: row.label,
    type: row.type,
    active: row.active,
    odometerKm: row.odometerKm,
    assignedDriverName: row.assignedDriverName,
    driverToday,
    preStartToday,
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

/**
 * Who chose each vehicle for today in the driver app (Matt, 21 Oct), in one
 * query for the whole page.
 */
async function driversTodayOf(ids: mongoose.Types.ObjectId[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();

  const choices = await VehicleChoiceModel.find({ date: todayIso(), vehicleId: { $in: ids } })
    .select({ vehicleId: 1, driverName: 1 })
    .lean<Array<{ vehicleId: mongoose.Types.ObjectId; driverName: string }>>();

  return new Map(choices.map((choice) => [choice.vehicleId.toHexString(), choice.driverName]));
}

/** The vehicles (ids) with a pre-start check today (Sydney), in one query for the whole page. */
async function preStartedToday(ids: mongoose.Types.ObjectId[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const checked: unknown[] = await JobPreStartModel.distinct('vehicleId', {
    vehicleId: { $in: ids },
    date: todayIso(),
  });
  return new Set(
    checked.flatMap((id) => (id instanceof mongoose.Types.ObjectId ? [id.toHexString()] : [])),
  );
}

/** Open defect counts per vehicle id, in one query for the whole page. */
async function openDefectCounts(ids: mongoose.Types.ObjectId[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();

  const counts = await VehicleDefectModel.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
    { $match: { vehicleId: { $in: ids }, status: { $ne: 'resolved' } } },
    { $group: { _id: '$vehicleId', count: { $sum: 1 } } },
  ]);

  return new Map(counts.map((row) => [row._id.toHexString(), row.count]));
}

/**
 * Every vehicle with at least one unresolved defect — fleet-wide, not just this
 * page. The "has open defects" filter has to select before pagination, so it
 * cannot reuse `openDefectCounts`, which is scoped to the rows already fetched.
 */
async function openDefectVehicleIds(): Promise<mongoose.Types.ObjectId[]> {
  const rows = await VehicleDefectModel.aggregate<{ _id: mongoose.Types.ObjectId | null }>([
    { $match: { status: { $ne: 'resolved' }, vehicleId: { $ne: null } } },
    { $group: { _id: '$vehicleId' } },
  ]);

  return rows.flatMap((row) => (row._id ? [row._id] : []));
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
