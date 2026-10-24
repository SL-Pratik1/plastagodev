import {
  IsoDateSchema,
  ObjectIdSchema,
  RegoPeriodSchema,
  VehicleDefectStateSchema,
  VehicleExpenseDraftSchema,
  VehicleTypeSchema,
} from '@plastago/shared';
import * as z from 'zod';

/**
 * Request shapes that belong to the transport rather than the domain.
 *
 * `VehicleDraft` and `VehicleExpenseDraft` live in `@plastago/shared` — the
 * console and the contract must agree on what a vehicle IS.
 */

export const VehicleIdParamsSchema = z
  .object({ id: ObjectIdSchema })
  .meta({ id: 'VehicleIdParams' });

export const VehicleDefectParamsSchema = z
  .object({ id: ObjectIdSchema, defectId: ObjectIdSchema })
  .meta({ id: 'VehicleDefectParams' });

export const ListVehiclesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    sort: z.string().trim().max(40).optional(),
    q: z.string().trim().max(120).optional(),
    type: VehicleTypeSchema.optional(),
    status: z.enum(['active', 'inactive']).optional(),
    registration: z.enum(['expired', 'due-soon', 'valid']).optional(),
    service: z.enum(['expired', 'due-soon', 'valid']).optional(),
    defects: z.enum(['open', 'none']).optional(),
  })
  .meta({ id: 'ListVehiclesQuery' });

/** A vehicle's pre-start checks, a page at a time — all of them, or one day's (23 Oct). */
export const VehiclePreStartsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(10),
    date: IsoDateSchema.optional(),
  })
  .meta({ id: 'VehiclePreStartsQuery' });

/** In service, or off the road. Never a delete — see the service. */
export const SetVehicleActiveSchema = z
  .object({ active: z.boolean() })
  .meta({ id: 'SetVehicleActive' });

/** `null` unassigns. The pairing is one-to-one. */
export const AssignDriverSchema = z
  .object({ driverName: z.string().trim().max(80).nullable() })
  .meta({ id: 'AssignVehicleDriver' });

/** W113 — booking the next service. `null` clears the booking. */
export const SetNextServiceSchema = z
  .object({ dueOn: IsoDateSchema.nullable() })
  .meta({ id: 'SetNextService' });

export const SetDefectStateSchema = z
  .object({ state: VehicleDefectStateSchema })
  .meta({ id: 'SetVehicleDefectState' });

/**
 * F43 — a renewal, optionally with the invoice.
 *
 * The expense is optional because somebody may renew now and enter the cost
 * later; it is on THIS request because the moment they renew is the only moment
 * they have the amount in front of them.
 */
export const RenewRegistrationSchema = z
  .object({
    expense: VehicleExpenseDraftSchema.nullable().default(null),
    /** 3, 6 or 12 months, chosen on this renewal. Absent: the vehicle's current length. */
    periodMonths: RegoPeriodSchema.optional(),
  })
  .meta({ id: 'RenewRegistration' });
