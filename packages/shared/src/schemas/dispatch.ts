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
 * Deliberately manual. With two active drivers and ~7 jobs a day, hand
 * allocation is faster, safer and more transparent than a rules engine —
 * automatic assignment (F58) and route optimisation (F19) are both out of scope,
 * so nothing here models them.
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

/** One driver's load for one date, as the allocation board needs it. */
export const DriverDaySchema = z
  .object({
    driverId: ObjectIdSchema,
    driverName: NonEmptyStringSchema,
    date: IsoDateSchema,
    status: DriverStatusSchema,
    capacity: z.number().int().positive(),
    assignedCount: z.number().int().nonnegative(),
    jobs: z.array(
      z.object({
        id: ObjectIdSchema,
        jobNumber: z.number().int().positive(),
        sequence: z.number().int().positive(),
        status: JobStatusSchema,
        accountName: NonEmptyStringSchema,
        siteName: NonEmptyStringSchema,
        suburb: NonEmptyStringSchema,
        zone: ZoneSchema,
        serviceLevel: ServiceLevelSchema,
        expectedAreaM2: z.number().nonnegative(),
        /** M3.5 — past its target date, so it gets highlighted on the board. */
        atRisk: z.boolean(),
      }),
    ),
  })
  .meta({ id: 'DriverDay' });

/** Everything the allocation board renders for one date. */
export const AllocationBoardSchema = z
  .object({
    date: IsoDateSchema,
    unallocated: z.array(
      z.object({
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
        expectedAreaM2: z.number().nonnegative(),
        atRisk: z.boolean(),
      }),
    ),
    drivers: z.array(DriverDaySchema),
  })
  .meta({ id: 'AllocationBoard' });

/**
 * M3.2 — the run sheet.
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
    customerReference: z.string().nullable(),
    contactName: z.string().nullable(),
    contactMobile: z.string().nullable(),
    expectedAreaM2: z.number().nonnegative(),
    bagCount: z.number().int().nonnegative(),
    accessNotes: z.string(),
    craneAvailable: z.boolean(),
    inductionRequired: z.boolean(),
    serviceLevel: ServiceLevelSchema,
    latitude: z.number(),
    longitude: z.number(),
  })
  .meta({ id: 'RunSheetStop' });

export const RunSheetSchema = z
  .object({
    driverId: ObjectIdSchema,
    driverName: NonEmptyStringSchema,
    driverMobile: z.string(),
    vehicleLabel: z.string().nullable(),
    date: IsoDateSchema,
    stops: z.array(RunSheetStopSchema),
    totalExpectedAreaM2: z.number().nonnegative(),
    totalBags: z.number().int().nonnegative(),
  })
  .meta({ id: 'RunSheet' });

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
    serviceLevel: ServiceLevelSchema,
    atRisk: z.boolean(),
  })
  .meta({ id: 'MapPin' });

export type Driver = z.infer<typeof DriverSchema>;
export type DriverDay = z.infer<typeof DriverDaySchema>;
export type AllocationBoard = z.infer<typeof AllocationBoardSchema>;
export type RunSheetStop = z.infer<typeof RunSheetStopSchema>;
export type RunSheet = z.infer<typeof RunSheetSchema>;
export type MapPin = z.infer<typeof MapPinSchema>;
