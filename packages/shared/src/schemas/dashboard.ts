import * as z from 'zod';
import { IsoDateSchema, IsoDateTimeSchema, MoneySchema, ObjectIdSchema } from './primitives.js';
import { JobStatusSchema } from './jobs.js';

/**
 * The operations dashboard (M9.4 / F15).
 *
 * Every field answers a question the owner currently cannot answer, and nothing
 * here is invented: the queue counts are the four queues the scope defines, the
 * rates are the two exception types that carry a charge, and the sync/worker
 * counters are the §6A.8 mitigation for having no error-tracking vendor —
 * "a sync-failure counter and last-successful-sync timestamp per driver device,
 * surfaced on the admin dashboard", so a stuck queue is visible in the product
 * rather than only in logs.
 */

/** One actionable queue. `oldestAt` is what makes ageing visible. */
export const QueueSummarySchema = z
  .object({
    key: z.enum(['futile-review', 'service-approvals', 'awaiting-po', 'po-review']),
    label: z.string(),
    count: z.number().int().nonnegative(),
    /**
     * The oldest unactioned item. This exists because one futile pickup has sat
     * in TransVirtual's queue since 28 August 2025 — a year, at $120. The system
     * must chase.
     */
    oldestAt: IsoDateTimeSchema.nullable(),
    /** Money sitting in the queue, where the queue holds charges. */
    valueExGst: MoneySchema.nullable(),
    href: z.string(),
  })
  .meta({ id: 'QueueSummary' });

export const StatusCountSchema = z
  .object({ status: JobStatusSchema, count: z.number().int().nonnegative() })
  .meta({ id: 'StatusCount' });

export const DailyVolumePointSchema = z
  .object({
    date: IsoDateSchema,
    jobs: z.number().int().nonnegative(),
    areaM2: z.number().nonnegative(),
  })
  .meta({ id: 'DailyVolumePoint' });

/** F15 — futile and contamination rates over time, as percentages of jobs. */
export const ExceptionRatePointSchema = z
  .object({
    weekStarting: IsoDateSchema,
    futilePercent: z.number().nonnegative(),
    contaminationPercent: z.number().nonnegative(),
  })
  .meta({ id: 'ExceptionRatePoint' });

export const DriverHealthSchema = z
  .object({
    driverId: ObjectIdSchema,
    driverName: z.string(),
    jobsToday: z.number().int().nonnegative(),
    capacity: z.number().int().positive(),
    lastSyncAt: IsoDateTimeSchema.nullable(),
    pendingSyncActions: z.number().int().nonnegative(),
  })
  .meta({ id: 'DriverHealth' });

export const RecentActivitySchema = z
  .object({
    id: ObjectIdSchema,
    at: IsoDateTimeSchema,
    actor: z.string(),
    summary: z.string(),
    jobId: ObjectIdSchema.nullable(),
    jobNumber: z.number().int().positive().nullable(),
    kind: z.enum(['status', 'charge', 'exception', 'invoice', 'account']),
  })
  .meta({ id: 'RecentActivity' });

export const DashboardSummarySchema = z
  .object({
    generatedAt: IsoDateTimeSchema,

    /** Headline counters. */
    openJobs: z.number().int().nonnegative(),
    unallocatedJobs: z.number().int().nonnegative(),
    /** M2.4a — past, or within a day of, ready date + 5 business days. */
    atRiskJobs: z.number().int().nonnegative(),
    completedToday: z.number().int().nonnegative(),

    /** Exception activity, as counts and as rates. */
    futileThisMonth: z.number().int().nonnegative(),
    contaminationThisMonth: z.number().int().nonnegative(),
    futileRatePercent: z.number().nonnegative(),
    contaminationRatePercent: z.number().nonnegative(),

    /** M7 — the cash cycle. 7-day terms, so ageing matters. */
    invoicedThisMonthExGst: MoneySchema,
    awaitingPoExGst: MoneySchema,
    overdueInvoiceCount: z.number().int().nonnegative(),

    /** Median Arrived → Complete, in minutes. Feeds the Extra Load Time rule. */
    medianOnSiteMinutes: z.number().int().nonnegative().nullable(),

    statusCounts: z.array(StatusCountSchema),
    dailyVolume: z.array(DailyVolumePointSchema),
    exceptionRates: z.array(ExceptionRatePointSchema),
    queues: z.array(QueueSummarySchema),
    driverHealth: z.array(DriverHealthSchema),
    recentActivity: z.array(RecentActivitySchema),

    /** §6A.8 — dead-lettered background jobs must be seen. */
    failedBackgroundJobs: z.number().int().nonnegative(),
  })
  .meta({ id: 'DashboardSummary' });

export type QueueSummary = z.infer<typeof QueueSummarySchema>;
export type StatusCount = z.infer<typeof StatusCountSchema>;
export type DailyVolumePoint = z.infer<typeof DailyVolumePointSchema>;
export type ExceptionRatePoint = z.infer<typeof ExceptionRatePointSchema>;
export type DriverHealth = z.infer<typeof DriverHealthSchema>;
export type RecentActivity = z.infer<typeof RecentActivitySchema>;
export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;
