import type { DriverListItem, DriverPerformance, DriverProfile, PageMeta } from '@plastago/shared';
import mongoose from 'mongoose';
import { todayInSydney } from '../../lib/business-day.js';
import { UserModel } from '../auth/auth.model.js';
import { VehicleModel } from '../fleet/vehicle.model.js';
import { JobChargeModel, JobModel, JobPhotoModel } from '../jobs/job.model.js';
import { DriverRosterModel } from './roster.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 *
 * ── The joins this file exists to do ──────────────────────────────────────
 * A driver's roster row is assembled from four places: `users` (who they are),
 * `driverrosters` (capacity), `vehicles` (their truck) and `jobs` (their day).
 * Doing that per driver would be four queries times two drivers today and times
 * twenty later; every list below is written as a fixed number of queries for the
 * whole page instead.
 *
 * ── What used to be here ──────────────────────────────────────────────────
 * Credentials, training, expiry state and device sync health. Every one of them
 * was read-only in the product — no endpoint and no form ever wrote a
 * credential, and device registration is never recorded — so they cost queries
 * on every page load to render defaults. The collections and their models are
 * untouched; only the reads are gone. See `fleet.ts` for the full reasoning.
 */

export interface ListDriversQuery {
  page: number;
  pageSize: number;
  sort?: string | undefined;
  q?: string | undefined;
  status?: 'active' | 'inactive' | undefined;
}

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

    if (query.status !== undefined) {
      filter.status = query.status === 'active' ? 'active' : { $ne: 'active' };
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

    return {
      data: await decorate(rows),
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

    return { ...listItem, performance: await performanceFor(user._id) };
  },
};

/* ── Assembling a list row ───────────────────────────────────────────────── */

/**
 * Turns user rows into roster rows, in a fixed number of queries.
 *
 * Three lookups for the whole page rather than three per driver — see the note
 * at the top of the file.
 */
async function decorate(users: RawUser[]): Promise<DriverListItem[]> {
  if (users.length === 0) return [];

  const ids = users.map((user) => user._id);
  const names = users.map((user) => user.name);
  const today = todayInSydney();

  const [rosters, vehicles, jobCounts] = await Promise.all([
    DriverRosterModel.find({ userId: { $in: ids } }).lean(),
    /*
     * The truck is paired by NAME (see `vehicle.model.ts`) — a deliberate choice
     * there so the pairing survives a driver leaving.
     */
    VehicleModel.find(
      { assignedDriverName: { $in: names } },
      { rego: 1, label: 1, assignedDriverName: 1 },
    ).lean(),
    JobModel.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
      { $match: { driverId: { $in: ids }, readyDate: today } },
      { $group: { _id: '$driverId', count: { $sum: 1 } } },
    ]),
  ]);

  const rosterByUser = new Map(rosters.map((row) => [String(row.userId), row]));
  const vehicleByName = new Map(vehicles.map((row) => [row.assignedDriverName ?? '', row]));
  const jobsByDriver = new Map(jobCounts.map((row) => [row._id.toHexString(), row.count]));

  return users.map((user) => {
    const key = user._id.toHexString();
    const roster = rosterByUser.get(key);
    const vehicle = vehicleByName.get(user.name);

    return {
      id: key,
      name: user.name,
      // The contract says `mobile`; Better Auth's plugin owns `phoneNumber`.
      mobile: user.phoneNumber ?? '',
      email: user.email,
      active: user.status === 'active',
      vehicleRego: vehicle?.rego ?? null,
      vehicleLabel: vehicle?.label ?? null,
      dailyJobCapacity: roster?.dailyJobCapacity ?? 8,
      jobsToday: jobsByDriver.get(key) ?? 0,
    };
  });
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

/**
 * Their protocol names five shots, of which FOUR are required — "cars on site"
 * applies only where the driver could not close the site.
 *
 * ⚠️ The threshold is `REQUIRED_PHOTO_SLOTS`, not the size of the protocol. It
 * used to be five, which meant a driver who closed every site correctly could
 * never reach it and scored 0% for doing the job right.
 */
const REQUIRED_PHOTO_SLOTS = 4;

async function photoCompliance(jobIds: mongoose.Types.ObjectId[]): Promise<number> {
  // No jobs is not non-compliance. A new driver reading 0% would be wrong.
  if (jobIds.length === 0) return 100;

  const withPhotos = await JobPhotoModel.aggregate<{ _id: mongoose.Types.ObjectId }>([
    { $match: { jobId: { $in: jobIds }, slot: { $ne: null } } },
    { $group: { _id: '$jobId', slots: { $addToSet: '$slot' } } },
    { $match: { $expr: { $gte: [{ $size: '$slots' }, REQUIRED_PHOTO_SLOTS] } } },
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
    (row) =>
      row.completedAt.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }) <=
      row.targetDate,
  ).length;

  return percent(onTime, rows.length);
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

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
