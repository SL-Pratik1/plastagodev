import { VehicleDraftSchema, VehicleExpenseDraftSchema } from '@plastago/shared';
import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { vehicleController } from './vehicle.controller.js';
import {
  AssignDriverSchema,
  ListVehiclesQuerySchema,
  RenewRegistrationSchema,
  SetDefectStateSchema,
  SetNextServiceSchema,
  SetVehicleActiveSchema,
  VehicleDefectParamsSchema,
  VehicleIdParamsSchema,
} from './vehicle.schemas.js';

/**
 * Router layer — paths and middleware only. No logic.
 *
 * ── Why the gate is at the door and again in the service ──────────────────
 * Cost per kilometre is commercial, so the whole router is internal. Inside it
 * the line moves again: an allocator books a service and pairs a driver, but
 * buying and retiring trucks is operations. That finer rule lives in the service
 * next to its reasoning, because it is about the ACTION rather than the route.
 */
export const vehicleRouter = Router();

vehicleRouter.use(requireAuth);
vehicleRouter.use(requireRole('super-admin', 'operations', 'allocator', 'office-staff'));

vehicleRouter.get(
  '/',
  validate({ query: ListVehiclesQuerySchema }),
  asyncHandler(vehicleController.list),
);

vehicleRouter.get(
  '/:id',
  validate({ params: VehicleIdParamsSchema }),
  asyncHandler(vehicleController.get),
);

vehicleRouter.post(
  '/',
  validate({ body: VehicleDraftSchema }),
  asyncHandler(vehicleController.create),
);

vehicleRouter.patch(
  '/:id',
  validate({ params: VehicleIdParamsSchema, body: VehicleDraftSchema }),
  asyncHandler(vehicleController.update),
);

/**
 * In service, or off the road.
 *
 * ⚠️ Never a delete. A truck that did 400 jobs last year has to stay
 * attributable — the same rule as a suspended user.
 */
vehicleRouter.post(
  '/:id/active',
  validate({ params: VehicleIdParamsSchema, body: SetVehicleActiveSchema }),
  asyncHandler(vehicleController.setActive),
);

/** `null` unassigns. The pairing is one-to-one and shows on both screens. */
vehicleRouter.post(
  '/:id/driver',
  validate({ params: VehicleIdParamsSchema, body: AssignDriverSchema }),
  asyncHandler(vehicleController.assignDriver),
);

/* ── F43 · the input side of cost per kilometre ──────────────────────────── */

vehicleRouter.post(
  '/:id/expenses',
  validate({ params: VehicleIdParamsSchema, body: VehicleExpenseDraftSchema }),
  asyncHandler(vehicleController.addExpense),
);

/** W113 — booking the next service. The allocator's job. */
vehicleRouter.post(
  '/:id/next-service',
  validate({ params: VehicleIdParamsSchema, body: SetNextServiceSchema }),
  asyncHandler(vehicleController.setNextService),
);

/**
 * Rolls the expiry forward by the vehicle's own period, optionally with cost.
 *
 * The expense rides along because the moment somebody renews is the only moment
 * they have the amount in front of them.
 */
vehicleRouter.post(
  '/:id/registration/renew',
  validate({ params: VehicleIdParamsSchema, body: RenewRegistrationSchema }),
  asyncHandler(vehicleController.renewRegistration),
);

/* ── M4.9 · W33 · driver-reported defects ────────────────────────────────── */

/** open → scheduled → resolved. See the note on `setDefectState`. */
vehicleRouter.post(
  '/:id/defects/:defectId/state',
  validate({ params: VehicleDefectParamsSchema, body: SetDefectStateSchema }),
  asyncHandler(vehicleController.setDefectState),
);
