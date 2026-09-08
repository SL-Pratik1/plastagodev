import type {
  CredentialType,
  DriverCredential,
  DriverListItem,
  DriverPerformance,
  DriverProfile,
  ExpiryState,
  PageMeta,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { todayInSydney } from '../../lib/business-day.js';
import { UserModel } from '../auth/auth.model.js';
import { VehicleModel } from '../fleet/vehicle.model.js';
import { JobChargeModel, JobModel, JobPhotoModel } from '../jobs/job.model.js';
import { UserDeviceModel } from '../users/user.model.js';
import {
  DriverCredentialModel,
  DriverRosterModel,
  DriverTrainingModel,
} from './roster.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 *
 * ── The joins this file exists to do ──────────────────────────────────────
 * A driver's roster row is assembled from five places: `users` (who they are),
 * `driverrosters` (employment, capacity), `vehicles` (their truck),
 * `userdevices` (§6A.8 sync health) and the credential/training collections.
 * Doing that per driver would be five queries times two drivers today and times
 * twenty later; every list below is written as a fixed number of queries for the
 * whole page instead.
 */

export interface ListDriversQuery {
  page: number;
  pageSize: number;
  sort?: string | undefined;
  q?: string | undefined;
  active?: boolean | undefined;
  /** The reminder filter — "who has something expiring". */
  expiry?: ExpiryState | undefined;
}

/** M9.8 — how far ahead a credential counts as expiring. */
const DUE_SOON_DAYS = 30;

interface RawUser {
  _id: mongoose.Types.ObjectId;
  name: string;
  phoneNumber: string | null;
  email: string | null;
  status: string;
}

const SORTABLE: Record<string, string> = { name: 'name', status: 'status' };

export const rosterRepository = {
  async list(query: ListDriversQuery): Promise<{ data: DriverListItem[]; meta: PageMeta }> {
    const filter: Record<string, unknown> = { roles: 'driver' };

    if (query.active !== undefined) {
      filter.status = query.active ? 'active' : { $ne: 'active' };
    }

    if (query.q) {
      const term = escapeRegex(query.q);
      filter.$or = [
        { name: { $regex: term, $options: 'i' } },
        { email: { $regex: term, $options: 'i' } },
        { phoneNumber: { $regex: term } },
      ];
    }

    const sortField = SORTABLE[query.sort?.replace(/^-/, '') ?? ''] ?? 'name';
    const direction: 1 | -1 = query.sort?.startsWith('-') ? -1 : 1;

    const [rows, total] = await Promise.all([
      UserModel.find(filter)
        .sort({ [sortField]: direction })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean<RawUser[]>(),
      UserModel.countDocuments(filter),
    ]);

    const items = await decorate(rows);

    /*
     * ⚠️ The expiry filter is applied AFTER the page, deliberately.
     *
     * The state is derived from dates in another collection, so it cannot be a
     * Mongo predicate on `users` without a lookup that would make the common
     * unfiltered listing pay for it. With two drivers that is free; the note is
     * here so that whoever adds the twentieth knows the trade was made
     * knowingly, and that the fix is an aggregation, not a bigger page size.
     */
    const filtered = query.expiry
      ? items.filter((item) => item.nextExpiryState === query.expiry)
      : items;

    return {
      data: filtered,
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  },

  async findById(id: string): Promise<DriverProfile | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    // The role is in the FILTER: an office user's id must not resolve to a
    // driver profile just because somebody pasted it into the URL.
    const user = await UserModel.findOne({ _id: id, roles: 'driver' }).lean<RawUser>();
    if (!user) return null;

    const [listItem] = await decorate([user]);
    if (!listItem) return null;

    const [roster, credentials, training, performance] = await Promise.all([
      DriverRosterModel.findOne({ userId: user._id }).lean(),
      credentialsFor(user._id),
      trainingFor(user._id),
      performanceFor(user._id),
    ]);

    return {
      ...listItem,
      startedOn: (roster?.startedOn as string | undefined) ?? todayInSydney(),
      notes: (roster?.notes) ?? '',
      credentials,
      training,
      performance,
    };
  },

  /** M9.8 — everything expiring, for the notification sweep. */
  async expiringCredentials(withinDays: number): Promise<
    Array<{ userId: string; driverName: string; type: CredentialType; expiresOn: string }>
  > {
    const cutoff = addDays(todayInSydney(), withinDays);

    const rows = await DriverCredentialModel.find({
      expiresOn: { $ne: null, $lte: cutoff },
    }).lean<Array<{ userId: mongoose.Types.ObjectId; type: CredentialType; expiresOn: string }>>();

    if (rows.length === 0) return [];

    const names = await namesFor(rows.map((row) => row.userId));

    return rows.map((row) => ({
      userId: row.userId.toHexString(),
      driverName: names.get(row.userId.toHexString()) ?? 'A driver',
      type: row.type,
      expiresOn: row.expiresOn,
    }));
  },
};

/* ── Assembling a list row ───────────────────────────────────────────────── */

/**
 * Turns user rows into roster rows, in a fixed number of queries.
 *
 * Four lookups for the whole page rather than four per driver — see the note at
 * the top of the file.
 */
async function decorate(users: RawUser[]): Promise<DriverListItem[]> {
  if (users.length === 0) return [];

  const ids = users.map((user) => user._id);
  const names = users.map((user) => user.name);
  const today = todayInSydney();

  const [rosters, vehicles, devices, jobCounts, credentials] = await Promise.all([
    DriverRosterModel.find({ userId: { $in: ids } }).lean(),
    /*
     * The truck is paired by NAME (see `vehicle.model.ts`) — a deliberate choice
     * there so the pairing survives a driver leaving. Matched here rather than
     * left null, which is what this field returned before fleet existed.
     */
    VehicleModel.find({ assignedDriverName: { $in: names } }, { rego: 1, label: 1, assignedDriverName: 1 }).lean(),
    UserDeviceModel.find({ userId: { $in: ids }, revokedAt: null })
      .sort({ lastSeenAt: -1 })
      .lean(),
    JobModel.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
      { $match: { driverId: { $in: ids }, readyDate: today } },
      { $group: { _id: '$driverId', count: { $sum: 1 } } },
    ]),
    DriverCredentialModel.find({ userId: { $in: ids } }, { userId: 1, expiresOn: 1 }).lean(),
  ]);

  const rosterByUser = new Map(rosters.map((row) => [String(row.userId), row]));
  const vehicleByName = new Map(
    vehicles.map((row) => [row.assignedDriverName ?? '', row]),
  );
  const jobsByDriver = new Map(jobCounts.map((row) => [row._id.toHexString(), row.count]));

  /* The MOST RECENTLY SEEN device per driver: an old handset still on file would
   * otherwise show its stale sync state and make a working driver look broken. */
  const deviceByUser = new Map<string, (typeof devices)[number]>();
  for (const device of devices) {
    const key = String(device.userId);
    if (!deviceByUser.has(key)) deviceByUser.set(key, device);
  }

  /** The SOONEST expiry per driver — the one the reminder is about. */
  const soonestByUser = new Map<string, string>();
  for (const credential of credentials) {
    const expiresOn = credential.expiresOn as string | null;
    if (!expiresOn) continue;

    const key = String(credential.userId);
    const current = soonestByUser.get(key);
    if (!current || expiresOn < current) soonestByUser.set(key, expiresOn);
  }

  return users.map((user) => {
    const key = user._id.toHexString();
    const roster = rosterByUser.get(key);
    const vehicle = vehicleByName.get(user.name);
    const device = deviceByUser.get(key);
    const nextExpiryOn = soonestByUser.get(key) ?? null;

    return {
      id: key,
      name: user.name,
      // The contract says `mobile`; Better Auth's plugin owns `phoneNumber`.
      mobile: user.phoneNumber ?? '',
      email: user.email,
      active: user.status === 'active',
      employment: (roster?.employment) ?? 'subcontractor',
      vehicleRego: vehicle?.rego ?? null,
      vehicleLabel: vehicle?.label ?? null,
      dailyJobCapacity: (roster?.dailyJobCapacity) ?? 8,
      jobsToday: jobsByDriver.get(key) ?? 0,
      nextExpiryOn,
      nextExpiryState: expiryState(nextExpiryOn),
      lastSyncAt: device?.lastSyncAt ? new Date(device.lastSyncAt).toISOString() : null,
      pendingSyncActions: (device?.pendingSyncActions) ?? 0,
    };
  });
}

async function credentialsFor(userId: mongoose.Types.ObjectId): Promise<DriverCredential[]> {
  const rows = await DriverCredentialModel.find({ userId }).sort({ expiresOn: 1 }).lean();

  return rows.map((row) => ({
    id: String(row._id),
    type: row.type,
    reference: (row.reference as string | null) ?? null,
    issuedOn: (row.issuedOn as string | null) ?? null,
    expiresOn: (row.expiresOn as string | null) ?? null,
    state: expiryState((row.expiresOn as string | null) ?? null),
    hasDocument: Boolean(row.storageKey),
  }));
}

async function trainingFor(
  userId: mongoose.Types.ObjectId,
): Promise<DriverProfile['training']> {
  const rows = await DriverTrainingModel.find({ userId }).sort({ completedOn: -1 }).lean();

  return rows.map((row) => ({
    id: String(row._id),
    name: row.name,
    completedOn: row.completedOn,
    expiresOn: (row.expiresOn as string | null) ?? null,
    state: expiryState((row.expiresOn as string | null) ?? null),
    provider: (row.provider as string | null) ?? null,
  }));
}

/* ── F22 · Performance ───────────────────────────────────────────────────── */

/**
 * The last 90 days, as operational insight.
 *
 * ⚠️ Framed as costing input and not as performance management — there are two
 * drivers, and a "score" for one of two people is a conversation nobody asked
 * for. Every figure here feeds either the cost-per-km model or the job-duration
 * model, which is what the screen says it is for.
 */
async function performanceFor(userId: mongoose.Types.ObjectId): Promise<DriverPerformance> {
  const since = new Date(Date.now() - 90 * 86_400_000);

  /*
   * This driver's jobs, once. Three of the figures below are counted against
   * them, and a charge carries the RAISER'S NAME rather than their id — so
   * "contamination this driver reported" has to be reached through the job,
   * not through the charge.
   */
  const jobIds = await jobIdsFor(userId, since);

  const [completed, futile, contamination, onSite, photoStats, slaStats] = await Promise.all([
    JobModel.countDocuments({
      driverId: userId,
      status: { $in: ['completed', 'admin-complete'] },
      completedAt: { $gte: since },
    }),
    JobModel.countDocuments({ driverId: userId, status: 'futile', completedAt: { $gte: since } }),
    JobChargeModel.countDocuments({ code: 'contamination', jobId: { $in: jobIds } }),
    JobModel.find(
      {
        driverId: userId,
        onSiteMinutes: { $ne: null, $gt: 0 },
        completedAt: { $gte: since },
      },
      { onSiteMinutes: 1 },
    )
      .sort({ onSiteMinutes: 1 })
      .lean<Array<{ onSiteMinutes: number }>>(),
    photoCompliance(jobIds),
    slaAdherence(userId, since),
  ]);

  /*
   * The denominator for both rates is every job that REACHED a site — completed
   * plus futile. Excluding futile would compute a futile rate that cannot
   * include the futile jobs.
   */
  const attended = completed + futile;

  return {
    periodLabel: 'Last 90 days',
    jobsCompleted: completed,
    // Working days, not calendar days: dividing by 90 would report a number
    // that looks like underperformance and is really just weekends.
    jobsPerWorkingDay: round1(completed / (90 * (5 / 7))),
    medianOnSiteMinutes: median(onSite.map((row) => row.onSiteMinutes)),
    futileCount: futile,
    futileRatePercent: percent(futile, attended),
    contaminationCount: contamination,
    contaminationRatePercent: percent(contamination, attended),
    photoCompliancePercent: photoStats,
    slaAdherencePercent: slaStats,
    // Honest absence. Distance needs F11's continuous location, which is not
    // being recorded yet, and an invented kilometre figure would feed straight
    // into the cost-per-km model.
    distanceKm: null,
  };
}

async function jobIdsFor(
  userId: mongoose.Types.ObjectId,
  since: Date,
): Promise<mongoose.Types.ObjectId[]> {
  const rows = await JobModel.find(
    { driverId: userId, completedAt: { $gte: since } },
    { _id: 1 },
  ).lean<Array<{ _id: mongoose.Types.ObjectId }>>();

  return rows.map((row) => row._id);
}

/** Their protocol expects five named shots per job; this is adherence to it. */
async function photoCompliance(jobIds: mongoose.Types.ObjectId[]): Promise<number> {
  // No jobs is not non-compliance. A new driver reading 0% would be wrong.
  if (jobIds.length === 0) return 100;

  const withPhotos = await JobPhotoModel.aggregate<{ _id: mongoose.Types.ObjectId }>([
    { $match: { jobId: { $in: jobIds }, slot: { $ne: null } } },
    { $group: { _id: '$jobId', slots: { $addToSet: '$slot' } } },
    { $match: { $expr: { $gte: [{ $size: '$slots' }, 5] } } },
    { $project: { _id: 1 } },
  ]);

  return percent(withPhotos.length, jobIds.length);
}

/** M2.4a — collected on or before the target date. */
async function slaAdherence(userId: mongoose.Types.ObjectId, since: Date): Promise<number> {
  const rows = await JobModel.find(
    {
      driverId: userId,
      status: { $in: ['completed', 'admin-complete'] },
      completedAt: { $gte: since },
    },
    { targetDate: 1, completedAt: 1 },
  ).lean<Array<{ targetDate: string; completedAt: Date }>>();

  if (rows.length === 0) return 100;

  const onTime = rows.filter(
    (row) => row.completedAt.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }) <= row.targetDate,
  ).length;

  return percent(onTime, rows.length);
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

async function namesFor(
  ids: mongoose.Types.ObjectId[],
): Promise<Map<string, string>> {
  const rows = await UserModel.find({ _id: { $in: ids } }, { name: 1 }).lean<
    Array<{ _id: mongoose.Types.ObjectId; name: string }>
  >();

  return new Map(rows.map((row) => [row._id.toHexString(), row.name]));
}

/**
 * Derived, never stored.
 *
 * A stored state is a field that goes stale overnight — and it goes stale into
 * "valid" on the morning the licence actually expired, which is the one day it
 * had to be right.
 */
function expiryState(expiresOn: string | null): ExpiryState {
  if (!expiresOn) return 'valid';

  const today = todayInSydney();
  if (expiresOn < today) return 'expired';
  if (expiresOn <= addDays(today, DUE_SOON_DAYS)) return 'due-soon';

  return 'valid';
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;

  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 0) {
    return Math.round(((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2);
  }

  return values[middle] ?? null;
}

/** Guarded: a driver with no attended jobs divides by zero, and NaN% is not a reading. */
function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
