import type { VehicleDraftSchema, VehicleExpenseDraftSchema } from '@plastago/shared';
import type { Response } from 'express';
import { AppError } from '../../lib/app-error.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { vehicleService, type Caller } from './vehicle.service.js';
import type {
  AssignDriverSchema,
  ListVehiclesQuerySchema,
  RenewRegistrationSchema,
  SetDefectStateSchema,
  SetNextServiceSchema,
  SetVehicleActiveSchema,
  VehicleDefectParamsSchema,
  VehicleIdParamsSchema,
} from './vehicle.schemas.js';

/** Controller layer — HTTP in, HTTP out. No business rules, no Mongoose. */

function callerFrom(req: { auth?: Express.Request['auth'] }): Caller {
  if (!req.auth) throw AppError.unauthenticated('Sign in to continue');

  return {
    userId: req.auth.userId,
    name: req.auth.name,
    roles: req.auth.roles as Caller['roles'],
  };
}

export const vehicleController = {
  list: async (
    req: ValidatedRequest<{ query: typeof ListVehiclesQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await vehicleService.list(req.validated.query, callerFrom(req)));
  },

  get: async (
    req: ValidatedRequest<{ params: typeof VehicleIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await vehicleService.get(req.validated.params.id, callerFrom(req)));
  },

  create: async (
    req: ValidatedRequest<{ body: typeof VehicleDraftSchema }>,
    res: Response,
  ): Promise<void> => {
    res.status(201).json(await vehicleService.create(req.validated.body, callerFrom(req)));
  },

  update: async (
    req: ValidatedRequest<{
      params: typeof VehicleIdParamsSchema;
      body: typeof VehicleDraftSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    res.json(
      await vehicleService.update(req.validated.params.id, req.validated.body, callerFrom(req)),
    );
  },

  setActive: async (
    req: ValidatedRequest<{
      params: typeof VehicleIdParamsSchema;
      body: typeof SetVehicleActiveSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    res.json(
      await vehicleService.setActive(
        req.validated.params.id,
        req.validated.body.active,
        callerFrom(req),
      ),
    );
  },

  assignDriver: async (
    req: ValidatedRequest<{
      params: typeof VehicleIdParamsSchema;
      body: typeof AssignDriverSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    res.json(
      await vehicleService.assignDriver(
        req.validated.params.id,
        req.validated.body.driverName,
        callerFrom(req),
      ),
    );
  },

  /** Returns the WHOLE vehicle — one expense moves four figures at once. */
  addExpense: async (
    req: ValidatedRequest<{
      params: typeof VehicleIdParamsSchema;
      body: typeof VehicleExpenseDraftSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    res
      .status(201)
      .json(
        await vehicleService.addExpense(
          req.validated.params.id,
          req.validated.body,
          callerFrom(req),
        ),
      );
  },

  setNextService: async (
    req: ValidatedRequest<{
      params: typeof VehicleIdParamsSchema;
      body: typeof SetNextServiceSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    res.json(
      await vehicleService.setNextService(
        req.validated.params.id,
        req.validated.body.dueOn,
        callerFrom(req),
      ),
    );
  },

  renewRegistration: async (
    req: ValidatedRequest<{
      params: typeof VehicleIdParamsSchema;
      body: typeof RenewRegistrationSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    res.json(
      await vehicleService.renewRegistration(
        req.validated.params.id,
        req.validated.body.expense,
        callerFrom(req),
      ),
    );
  },

  setDefectState: async (
    req: ValidatedRequest<{
      params: typeof VehicleDefectParamsSchema;
      body: typeof SetDefectStateSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    res.json(
      await vehicleService.setDefectState(
        req.validated.params.id,
        req.validated.params.defectId,
        req.validated.body.state,
        callerFrom(req),
      ),
    );
  },
};
