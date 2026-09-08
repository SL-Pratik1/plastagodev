import type {
  DailyVolumePoint,
  DriverHealth,
  ExceptionRatePoint,
  JobStatus,
  RecentActivity,
  StatusCount,
} from '@plastago/shared';
import type mongoose from 'mongoose';
import {
  currentMonthInSydney,
  startOfThisMonth,
  startOfToday,
  todayInSydney,
} from '../../lib/business-day.js';
import { UserModel } from '../auth/auth.model.js';
import { InvoiceModel } from '../invoices/invoice.model.js';
import { JobChargeModel, JobEventModel, JobModel } from '../jobs/job.model.js';
import { UserDeviceModel } from '../users/user.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 *
 * ── Everything here is a live aggregate ───────────────────────────────────
 * There is no dashboard rollup table, deliberately. A rollup written by one
 * path and read by another is two places that can disagree, and a dashboard
 * disagreeing with the grid it links to is a dashboard nobody trusts twice.
 *
 * The cost of that is a handful of counts per page load. On a few thousand jobs
 * every one of them is answered by an index.
 */

const OPEN_STATUSES: JobStatus[] = ['booked', 'assigned', 'in-transit', 'arrived'];
const COMPLETED_STATUSES: JobStatus[] = ['completed', 'admin-complete'];

export const dashboardRepository = {
  /** The headline counters, in one round trip. */
  async counters(): Promise<{
    openJobs: number;
    unallocatedJobs: number;
    atRiskJobs: number;
    completedToday: number;
  }> {
    const today = todayInSydney();

    const [openJobs, unallocatedJobs, atRiskJobs, completedToday] = await Promise.all([
      JobModel.countDocuments({ status: { $in: OPEN_STATUSES } }),
      // The first column of the dispatch board, and the morning question.
      JobModel.countDocuments({ status: { $in: OPEN_STATUSES }, driverId: null }),
      /*
       * M2.4a — still open and the target date has passed. Computed against the
       * stored `targetDate` rather than recomputed from the ready date, so this
       * agrees with the jobs grid's own at-risk filter.
       */
      JobModel.countDocuments({ status: { $in: OPEN_STATUSES }, targetDate: { $lt: today } }),
      /*
       * ⚠️ The Sydney day, not UTC midnight. `today` is a Sydney DATE, and
       * turning it straight into a UTC instant would start the window at 10am
       * local — so a morning's completed work would be missing from the counter
       * for exactly the hours somebody is watching it.
       */
      JobModel.countDocuments({
        status: { $in: COMPLETED_STATUSES },
        completedAt: { $gte: startOfToday() },
      }),
    ]);

    return { openJobs, unallocatedJobs, atRiskJobs, completedToday };
  },

  async statusCounts(): Promise<StatusCount[]> {
    const rows = await JobModel.aggregate<{ _id: JobStatus; count: number }>([
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    return rows.map((row) => ({ status: row._id, count: row.count }));
  },

  /**
   * F15 — the exception counts this month, and the jobs to rate them against.
   *
   * Both numbers come back together because a rate needs a denominator, and
   * fetching them separately invites the two to be taken from different windows.
   */
  async exceptionsThisMonth(): Promise<{
    futile: number;
    contamination: number;
    completedOrFutile: number;
  }> {
    // The Sydney month, for the same reason as `completedToday` above: the 1st
    // starts at 2pm UTC on the last day of the previous month, not at midnight.
    const monthStart = startOfThisMonth();

    const [futile, contamination, completedOrFutile] = await Promise.all([
      JobModel.countDocuments({ status: 'futile', completedAt: { $gte: monthStart } }),
      /*
       * Counted from the CHARGE, not from a flag on the job. A contamination
       * report is a charge the driver raised — including rejected ones, because
       * the rate is about how often it is REPORTED, which is what drives the
       * conversation with the builder.
       */
      JobChargeModel.countDocuments({
        code: 'contamination',
        raisedAt: { $gte: monthStart },
      }),
      /*
       * The denominator is every job that REACHED a site — completed plus
       * futile. Excluding futile would compute a futile rate that cannot
       * include the futile jobs, and cancelled jobs never had a truck sent.
       */
      JobModel.countDocuments({
        status: { $in: [...COMPLETED_STATUSES, 'futile'] },
        completedAt: { $gte: monthStart },
      }),
    ]);

    return { futile, contamination, completedOrFutile };
  },

  /** M7 — the cash cycle. 7-day terms, so ageing matters. */
  async invoiceTotals(): Promise<{
    invoicedThisMonthCents: number;
    awaitingPoCents: number;
    overdueCount: number;
  }> {
    const monthStart = `${currentMonthInSydney()}-01`;
    const today = todayInSydney();

    const [invoiced, awaiting, overdueCount] = await Promise.all([
      InvoiceModel.aggregate<{ total: mongoose.Types.Decimal128 }>([
        {
          $match: {
            issuedOn: { $gte: monthStart },
            // Drafts are not invoiced yet — counting them would overstate the
            // month before anybody has sent anything.
            status: { $in: ['sent', 'paid', 'overdue'] },
          },
        },
        { $group: { _id: null, total: { $sum: '$subtotalExGst' } } },
      ]),
      InvoiceModel.aggregate<{ total: mongoose.Types.Decimal128 }>([
        { $match: { status: 'awaiting-po' } },
        { $group: { _id: null, total: { $sum: '$subtotalExGst' } } },
      ]),
      /*
       * Overdue is computed from the DUE DATE, not read off the status. Nothing
       * flips a row to `overdue` at midnight, so a status-based count would
       * report zero until somebody ran a sweep.
       */
      InvoiceModel.countDocuments({ status: 'sent', dueOn: { $lt: today } }),
    ]);

    return {
      invoicedThisMonthCents: decimalToCents(invoiced[0]?.total),
      awaitingPoCents: decimalToCents(awaiting[0]?.total),
      overdueCount,
    };
  },

  /**
   * The median Arrived → Complete duration, in minutes.
   *
   * ⚠️ Median, not mean. One job where a driver forgot to press Complete until
   * the next morning would drag an average into uselessness; the median ignores
   * it. This figure feeds the Extra Load Time rule, so it has to be robust.
   */
  async medianOnSiteMinutes(): Promise<number | null> {
    const rows = await JobModel.find(
      {
        onSiteMinutes: { $ne: null, $gt: 0 },
        completedAt: { $gte: new Date(Date.now() - 90 * 86_400_000) },
      },
      { onSiteMinutes: 1 },
    )
      .sort({ onSiteMinutes: 1 })
      .lean<Array<{ onSiteMinutes: number }>>();

    if (rows.length === 0) return null;

    const middle = Math.floor(rows.length / 2);

    // Even count: the mean of the two middle values, which is the median.
    if (rows.length % 2 === 0) {
      const lower = rows[middle - 1]?.onSiteMinutes ?? 0;
      const upper = rows[middle]?.onSiteMinutes ?? 0;
      return Math.round((lower + upper) / 2);
    }

    return rows[middle]?.onSiteMinutes ?? null;
  },

  /** Jobs completed per day, for the trend line. */
  async dailyVolume(days: number): Promise<DailyVolumePoint[]> {
    const rows = await JobModel.aggregate<{ _id: string; jobs: number; areaM2: number }>([
      {
        $match: {
          status: { $in: COMPLETED_STATUSES },
          completedAt: { $gte: new Date(Date.now() - days * 86_400_000) },
        },
      },
      {
        $group: {
          // Bucketed in the business's own timezone: a job completed at 9am
          // Sydney belongs to that Sydney day, whatever UTC says.
          _id: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: '$completedAt',
              timezone: 'Australia/Sydney',
            },
          },
          jobs: { $sum: 1 },
          areaM2: { $sum: { $ifNull: ['$expectedAreaM2', 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    return rows.map((row) => ({
      date: row._id,
      jobs: row.jobs,
      areaM2: Math.round(row.areaM2 * 10) / 10,
    }));
  },

  /**
   * F15 — futile and contamination as weekly percentages.
   *
   * Weekly rather than daily: on 240 jobs a month, a daily rate swings between
   * 0% and 100% on one exception and shows nothing but noise.
   */
  async exceptionRates(weeks: number): Promise<ExceptionRatePoint[]> {
    const since = new Date(Date.now() - weeks * 7 * 86_400_000);

    const [jobRows, chargeRows] = await Promise.all([
      JobModel.aggregate<{ _id: string; total: number; futile: number }>([
        {
          $match: {
            status: { $in: [...COMPLETED_STATUSES, 'futile'] },
            completedAt: { $gte: since },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: '%G-W%V',
                date: '$completedAt',
                timezone: 'Australia/Sydney',
              },
            },
            total: { $sum: 1 },
            futile: { $sum: { $cond: [{ $eq: ['$status', 'futile'] }, 1, 0] } },
            weekStart: {
              $min: {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: '$completedAt',
                  timezone: 'Australia/Sydney',
                },
              },
            },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      JobChargeModel.aggregate<{ _id: string; contaminated: number }>([
        { $match: { code: 'contamination', raisedAt: { $gte: since } } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: '%G-W%V',
                date: '$raisedAt',
                timezone: 'Australia/Sydney',
              },
            },
            contaminated: { $sum: 1 },
          },
        },
      ]),
    ]);

    const contaminationByWeek = new Map(
      chargeRows.map((row) => [row._id, row.contaminated]),
    );

    return jobRows.map((row) => {
      const contaminated = contaminationByWeek.get(row._id) ?? 0;

      return {
        // The ISO week's own label is not a date the UI can render, so the
        // earliest completion in the bucket stands in for the week's start.
        weekStarting: (row as unknown as { weekStart: string }).weekStart,
        futilePercent: row.total > 0 ? Math.round((row.futile / row.total) * 1000) / 10 : 0,
        contaminationPercent:
          row.total > 0 ? Math.round((contaminated / row.total) * 1000) / 10 : 0,
      };
    });
  },

  /**
   * §6A.8 — driver load and sync health.
   *
   * The sync half is the point: there is no error-tracking vendor, so a stuck
   * offline queue has to be visible in the product itself.
   */
  async driverHealth(): Promise<DriverHealth[]> {
    const today = todayInSydney();

    const drivers = await UserModel.find(
      { roles: 'driver', status: 'active' },
      { name: 1 },
    ).lean<Array<{ _id: mongoose.Types.ObjectId; name: string }>>();

    if (drivers.length === 0) return [];

    const ids = drivers.map((driver) => driver._id);

    // Two queries for the whole fleet, not two per driver.
    const [jobCounts, devices] = await Promise.all([
      JobModel.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
        { $match: { driverId: { $in: ids }, readyDate: today } },
        { $group: { _id: '$driverId', count: { $sum: 1 } } },
      ]),
      UserDeviceModel.find({ userId: { $in: ids }, revokedAt: null })
        .sort({ lastSeenAt: -1 })
        .lean(),
    ]);

    const jobsByDriver = new Map(jobCounts.map((row) => [row._id.toHexString(), row.count]));

    /*
     * The MOST RECENTLY SEEN device per driver. A driver with an old handset
     * still on file would otherwise show that one's stale sync state and look
     * broken when they are not.
     */
    const deviceByDriver = new Map<string, (typeof devices)[number]>();
    for (const device of devices) {
      const key = device.userId.toHexString();
      if (!deviceByDriver.has(key)) deviceByDriver.set(key, device);
    }

    return drivers.map((driver) => {
      const key = driver._id.toHexString();
      const device = deviceByDriver.get(key);

      return {
        driverId: key,
        driverName: driver.name,
        jobsToday: jobsByDriver.get(key) ?? 0,
        // M3.4 — a simple capacity column, not an availability dashboard.
        capacity: 8,
        lastSyncAt: device?.lastSyncAt ? device.lastSyncAt.toISOString() : null,
        pendingSyncActions: device?.pendingSyncActions ?? 0,
      };
    });
  },

  /** What just happened, across the whole system. */
  async recentActivity(limit: number): Promise<RecentActivity[]> {
    const rows = await JobEventModel.aggregate<{
      _id: mongoose.Types.ObjectId;
      at: Date;
      actor: string;
      label: string;
      detail: string | null;
      status: JobStatus | null;
      job: { _id: mongoose.Types.ObjectId; jobNumber: number; accountName: string };
    }>([
      { $sort: { at: -1 } },
      { $limit: limit },
      { $lookup: { from: 'jobs', localField: 'jobId', foreignField: '_id', as: 'job' } },
      { $unwind: '$job' },
    ]);

    return rows.map((row) => ({
      id: row._id.toHexString(),
      at: row.at.toISOString(),
      actor: row.actor,
      summary: `${row.label} — #${String(row.job.jobNumber)} ${row.job.accountName}`,
      jobId: row.job._id.toHexString(),
      jobNumber: row.job.jobNumber,
      kind: kindOf(row.label, row.status),
    }));
  },
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * Buckets an event for the activity feed's icon.
 *
 * Derived from the label rather than stored, because the label is what a human
 * reads and a second field would be one more thing to keep in step with it.
 */
function kindOf(label: string, status: JobStatus | null): RecentActivity['kind'] {
  const text = label.toLowerCase();

  if (text.includes('futile') || text.includes('contamination') || text.includes('unsafe')) {
    return 'exception';
  }
  if (text.includes('charge')) return 'charge';
  if (text.includes('invoice')) return 'invoice';
  if (status !== null) return 'status';
  return 'account';
}


/** `Decimal128` to integer cents, exactly (§6A.10 #1). */
function decimalToCents(value: mongoose.Types.Decimal128 | undefined): number {
  if (!value) return 0;

  const text = value.toString();
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));

  return negative ? -cents : cents;
}
