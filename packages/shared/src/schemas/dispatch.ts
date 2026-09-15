import * as z from 'zod';
import {
  IsoDateSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  ObjectIdSchema,
} from './primitives.js';
import { ZoneSchema } from './party.js';
import { JobStatusSchema, ServiceLevelSchema } from './jobs.js';

/**
 * Allocation and dispatch (M3).
 *
 * ── The unit of allocation is a RUN, not a job ────────────────────────────
 * Matt, 39:41: *"What I would do is I create run sheets. So I create a run and
 * we are able to add jobs to that run… add these jobs onto that run and then
 * **assign that whole run to a driver rather than assigning jobs to the
 * driver**."*
 *
 * That is not a presentation preference, it is the shape of their day. A driver
 * does *two* runs (40:03) — South Coast in the morning, tip off, Sydney in the
 * afternoon — and the weighbridge docket belongs to the trip, not to the day:
 * *"we add the weighbridge ticket **against that run**. So we know that run
 * tipped off at 2.7 ton"* (43:50). A day-level total cannot be split back out
 * afterwards, so recording weight per driver-day silently destroys the only
 * figure the diversion certificates are computed from.
 *
 * Runs are grouped by suburb because that is how they get built: *"you might
 * have Kellyville, Box Hill — four or five suburbs close together, you'll put
 * them on one run"* (41:17).
 *
 * Ordering *within* a run comes from Google Route Optimization (41:34 — Matt:
 * *"that'd be awesome"*). Its *composition* stays a human decision: the
 * allocator knows which jobs are ready and which builder will complain.
 */

export const DriverStatusSchema = z.enum(['available', 'on-run', 'off']).meta({
  id: 'DriverStatus',
});
export type DriverStatus = z.infer<typeof DriverStatusSchema>;

export const DRIVER_STATUS_LABELS: Record<DriverStatus, string> = {
  available: 'Available',
  'on-run': 'On a run',
  off: 'Not working',
};

export const DriverSchema = z
  .object({
    id: ObjectIdSchema,
    name: NonEmptyStringSchema,
    mobile: z.string(),
    /** Their own fleet — 5 vehicles across 2 active drivers. */
    vehicleRego: z.string().nullable(),
    vehicleLabel: z.string().nullable(),
    status: DriverStatusSchema,
    /** M3.4 — a simple capacity column, not a full availability dashboard. */
    dailyJobCapacity: z.number().int().positive(),
    /** M9.8 — the soonest licence or ticket expiry, for the 1-month reminder. */
    nextComplianceExpiry: IsoDateSchema.nullable(),
    /** §6A.8 — sync health per device, since there is no error tracking. */
    lastSyncAt: IsoDateTimeSchema.nullable(),
    pendingSyncActions: z.number().int().nonnegative(),
  })
  .meta({ id: 'Driver' });

/* ── Runs ───────────────────────────────────────────────────────────────── */

/**
 * Where a run is in its life.
 *
 * `planning` is the only state in which stops may be added or removed — once a
 * driver has the run on his phone, changing its contents underneath him is how
 * a stop gets missed. `tipped-off` is separate from `closed` because the docket
 * arrives before anyone has checked the reconciliation against it.
 */
export const RUN_STATUSES = [
  'planning',
  'assigned',
  'in-progress',
  'tipped-off',
  'closed',
] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES).meta({ id: 'RunStatus' });
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  planning: 'Planning',
  assigned: 'Assigned',
  'in-progress': 'In progress',
  'tipped-off': 'Tipped off',
  closed: 'Closed',
};

/**
 * A job as it sits on a run — the card the allocator drags.
 *
 * `readyDate` and `targetDate` are both here on Matt's instruction (45:46:
 * *"the only thing I'd add to these job cards is the date that they're ready"*).
 * They are not two names for one date, and the gap between them is the whole
 * planning problem: ready is when the plasterer finished, target is ready plus
 * the 3–5 day turnaround Matt quotes his builders.
 */
export const RunStopSummarySchema = z
  .object({
    id: ObjectIdSchema,
    jobNumber: z.number().int().positive(),
    /** Position in the run. Rewritten wholesale when the route is optimised. */
    sequence: z.number().int().positive(),
    status: JobStatusSchema,
    accountName: NonEmptyStringSchema,
    builderName: z.string(),
    siteName: NonEmptyStringSchema,
    suburb: NonEmptyStringSchema,
    zone: ZoneSchema,
    serviceLevel: ServiceLevelSchema,
    readyDate: IsoDateSchema,
    targetDate: IsoDateSchema,
    /**
     * Null on a fixed-price builder's PO, which carries no area at all — Matt,
     * 31:22: *"with this customer, you won't know square meters."* The tip-off
     * reconciliation must exclude such stops from the m²-weighted split rather
     * than read the absence as zero, which would hand them no weight and give
     * their share to everybody else.
     */
    expectedAreaM2: z.number().nonnegative().nullable(),
    atRisk: z.boolean(),
  })
  .meta({ id: 'RunStopSummary' });

/**
 * The weighbridge docket for one run.
 *
 * Per run, never per day — see the note at the top of this file. `netKg` is the
 * figure the reconciliation divides: crane-weighed bags are subtracted first,
 * and what remains is split across the hand-loaded stops in proportion to m².
 */
export const RunTipOffSchema = z
  .object({
    /**
     * Null when the DRIVER recorded the tip-off.
     *
     * There is no facility picker on the driver’s Tip-off screen — they are at
     * the weighbridge with a docket in their hand, and which transfer station
     * the truck is standing in is not a question worth asking them. The office
     * fills it in afterwards; `driver.repository.ts` writes null on that path
     * and says so.
     *
     * This was `NonEmptyStringSchema`, which made the office dispatch board fail
     * to parse for the whole day as soon as any driver weighed off — the single
     * most routine end-of-day action in the product killed the allocator’s only
     * screen. Nullable is what the write path has always produced.
     */
    facility: NonEmptyStringSchema.nullable(),
    docketNumber: z.string().nullable(),
    netKg: z.number().nonnegative(),
    tippedOffAt: IsoDateTimeSchema,
    docketPhotoUrl: z.string().nullable(),
  })
  .meta({ id: 'RunTipOff' });

/**
 * A run — the thing that gets assigned.
 *
 * `driverId` is nullable because a run exists before anyone is put on it. The
 * allocator builds the shape of the day first and staffs it second, which is
 * the order Matt described at 44:50: *"rather than an allocation board per se,
 * it'd be a run sheet creator."*
 */
export const RunSchema = z
  .object({
    id: ObjectIdSchema,
    runNumber: z.number().int().positive(),
    /** The name the allocator types — "Newcastle run 1" (Matt, 39:41). */
    name: NonEmptyStringSchema,
    date: IsoDateSchema,
    status: RunStatusSchema,
    /** Null until the run is staffed. */
    driverId: ObjectIdSchema.nullable(),
    driverName: z.string().nullable(),
    vehicleLabel: z.string().nullable(),
    /**
     * Which of this driver's runs for the day this is — 1 for the morning South
     * Coast trip, 2 for the afternoon Sydney one (Matt, 40:03). Null while the
     * run is unassigned.
     */
    sequenceForDay: z.number().int().positive().nullable(),
    /** Distinct suburbs covered, in stop order. The board groups on these. */
    suburbs: z.array(NonEmptyStringSchema),
    stops: z.array(RunStopSummarySchema),
    totalExpectedAreaM2: z.number().nonnegative(),
    totalBags: z.number().int().nonnegative(),
    /**
     * When Google Route Optimization last ordered the stops. Null means the
     * sequence is the allocator's own work, and re-optimising would throw it
     * away — so the UI asks first rather than silently reordering.
     */
    optimisedAt: IsoDateTimeSchema.nullable(),
    /** Null until the driver tips off. One docket, one run. */
    tipOff: RunTipOffSchema.nullable(),
  })
  .meta({ id: 'Run' });

/** A run as it appears against a driver on the board — no stop detail. */
export const AssignedRunSummarySchema = z
  .object({
    id: ObjectIdSchema,
    runNumber: z.number().int().positive(),
    name: NonEmptyStringSchema,
    status: RunStatusSchema,
    sequenceForDay: z.number().int().positive(),
    suburbs: z.array(NonEmptyStringSchema),
    stopCount: z.number().int().nonnegative(),
    totalExpectedAreaM2: z.number().nonnegative(),
    atRiskCount: z.number().int().nonnegative(),
  })
  .meta({ id: 'AssignedRunSummary' });

/** Creating a run. Jobs may be added later, so `jobIds` is allowed to be empty. */
export const CreateRunInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name the run — dispatch and drivers both call it by name')
      .max(60),
    date: IsoDateSchema,
    driverId: ObjectIdSchema.nullable(),
    jobIds: z.array(ObjectIdSchema),
  })
  .meta({ id: 'CreateRunInput' });

export type CreateRunInput = z.infer<typeof CreateRunInputSchema>;

/* ── The board ──────────────────────────────────────────────────────────── */

/**
 * One driver's load for one date.
 *
 * `runs` is the real content. `jobs` stays as the flattened view because the
 * capacity read-out and the map both want stops without caring which run they
 * came from — but every stop now names its `runId`, so nothing has to guess.
 */
export const DriverDaySchema = z
  .object({
    driverId: ObjectIdSchema,
    driverName: NonEmptyStringSchema,
    date: IsoDateSchema,
    status: DriverStatusSchema,
    capacity: z.number().int().positive(),
    assignedCount: z.number().int().nonnegative(),
    /** Ordered by `sequenceForDay`. Two entries is a normal day, not an error. */
    runs: z.array(AssignedRunSummarySchema),
    jobs: z.array(
      z.object({
        id: ObjectIdSchema,
        jobNumber: z.number().int().positive(),
        sequence: z.number().int().positive(),
        /** Which run this stop belongs to. */
        runId: ObjectIdSchema,
        status: JobStatusSchema,
        accountName: NonEmptyStringSchema,
        siteName: NonEmptyStringSchema,
        suburb: NonEmptyStringSchema,
        zone: ZoneSchema,
        serviceLevel: ServiceLevelSchema,
        expectedAreaM2: z.number().nonnegative().nullable(),
        /** M3.5 — past its target date, so it gets highlighted on the board. */
        atRisk: z.boolean(),
      }),
    ),
  })
  .meta({ id: 'DriverDay' });

/** One job waiting to be put on a run. */
export const UnallocatedJobSchema = z
  .object({
    id: ObjectIdSchema,
    jobNumber: z.number().int().positive(),
    accountName: NonEmptyStringSchema,
    builderName: z.string(),
    siteName: NonEmptyStringSchema,
    suburb: NonEmptyStringSchema,
    zone: ZoneSchema,
    serviceLevel: ServiceLevelSchema,
    readyDate: IsoDateSchema,
    targetDate: IsoDateSchema,
    expectedAreaM2: z.number().nonnegative().nullable(),
    atRisk: z.boolean(),
  })
  .meta({ id: 'UnallocatedJob' });

/**
 * Everything the allocation board renders for one date.
 *
 * `unallocated` and `unallocatedBySuburb` hold the same jobs twice on purpose.
 * A run gets built from an *area* — *"you might have Kellyville, Box Hill, four
 * or five suburbs close together, you'll put them on one run"* (41:17) — so the
 * suburb bucket is what the allocator actually reaches for, and computing it in
 * the UI would mean every consumer re-deriving the same grouping.
 */
export const AllocationBoardSchema = z
  .object({
    date: IsoDateSchema,
    unallocated: z.array(UnallocatedJobSchema),
    unallocatedBySuburb: z.array(
      z.object({
        suburb: NonEmptyStringSchema,
        zone: ZoneSchema,
        jobs: z.array(UnallocatedJobSchema),
        totalExpectedAreaM2: z.number().nonnegative(),
        atRiskCount: z.number().int().nonnegative(),
      }),
    ),
    /** Runs for the date, including ones nobody is on yet. */
    runs: z.array(RunSchema),
    drivers: z.array(DriverDaySchema),
  })
  .meta({ id: 'AllocationBoard' });

/* ── The run sheet ──────────────────────────────────────────────────────── */

/**
 * M3.2 — one stop on the run sheet.
 *
 * Every field here exists because a driver standing at a gate needs it: the lot
 * number because street numbers do not exist yet in greenfield estates, the
 * contact to tap-to-call when the gate is shut, the expected m² so they know
 * what they are collecting before they open the truck.
 */
export const RunSheetStopSchema = z
  .object({
    id: ObjectIdSchema,
    sequence: z.number().int().positive(),
    jobNumber: z.number().int().positive(),
    status: JobStatusSchema,
    accountName: NonEmptyStringSchema,
    builderName: z.string(),
    siteName: NonEmptyStringSchema,
    lotNumber: z.string().nullable(),
    addressLine: NonEmptyStringSchema,
    suburb: NonEmptyStringSchema,
    zone: ZoneSchema,
    /** The customer's PO or job reference — one field (Matt, 9:08). */
    poNumber: z.string().nullable(),
    contactName: z.string().nullable(),
    contactMobile: z.string().nullable(),
    expectedAreaM2: z.number().nonnegative().nullable(),
    bagCount: z.number().int().nonnegative(),
    accessNotes: z.string(),
    craneAvailable: z.boolean(),
    inductionRequired: z.boolean(),
    serviceLevel: ServiceLevelSchema,
    latitude: z.number(),
    longitude: z.number(),
  })
  .meta({ id: 'RunSheetStop' });

/**
 * The printed and on-phone run sheet, for ONE run.
 *
 * Keyed by run rather than by driver-and-date. A driver with a morning and an
 * afternoon run needs two of these, and the tip-off that closes each one
 * belongs to that run — which is the whole reason runs exist as a record.
 */
export const RunSheetSchema = z
  .object({
    runId: ObjectIdSchema,
    runNumber: z.number().int().positive(),
    runName: NonEmptyStringSchema,
    status: RunStatusSchema,
    sequenceForDay: z.number().int().positive().nullable(),
    driverId: ObjectIdSchema.nullable(),
    driverName: z.string().nullable(),
    driverMobile: z.string().nullable(),
    vehicleLabel: z.string().nullable(),
    date: IsoDateSchema,
    suburbs: z.array(NonEmptyStringSchema),
    stops: z.array(RunSheetStopSchema),
    totalExpectedAreaM2: z.number().nonnegative(),
    totalBags: z.number().int().nonnegative(),
    optimisedAt: IsoDateTimeSchema.nullable(),
    tipOff: RunTipOffSchema.nullable(),
  })
  .meta({ id: 'RunSheet' });

/* ── Map ────────────────────────────────────────────────────────────────── */

/** M3.3 — pins for visual clustering. NOT a routing result. */
export const MapPinSchema = z
  .object({
    id: ObjectIdSchema,
    jobNumber: z.number().int().positive(),
    latitude: z.number(),
    longitude: z.number(),
    status: JobStatusSchema,
    accountName: NonEmptyStringSchema,
    siteName: NonEmptyStringSchema,
    suburb: NonEmptyStringSchema,
    zone: ZoneSchema,
    driverName: z.string().nullable(),
    /** Which run the pin belongs to, so the map can colour by run. */
    runId: ObjectIdSchema.nullable(),
    runName: z.string().nullable(),
    serviceLevel: ServiceLevelSchema,
    atRisk: z.boolean(),
  })
  .meta({ id: 'MapPin' });

export type Driver = z.infer<typeof DriverSchema>;
export type RunStopSummary = z.infer<typeof RunStopSummarySchema>;
export type RunTipOff = z.infer<typeof RunTipOffSchema>;
export type Run = z.infer<typeof RunSchema>;
export type AssignedRunSummary = z.infer<typeof AssignedRunSummarySchema>;
export type DriverDay = z.infer<typeof DriverDaySchema>;
export type UnallocatedJob = z.infer<typeof UnallocatedJobSchema>;
export type AllocationBoard = z.infer<typeof AllocationBoardSchema>;
export type RunSheetStop = z.infer<typeof RunSheetStopSchema>;
export type RunSheet = z.infer<typeof RunSheetSchema>;
export type MapPin = z.infer<typeof MapPinSchema>;
