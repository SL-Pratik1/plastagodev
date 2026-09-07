import type { CreateRunInputSchema } from '@plastago/shared';
import type { Response } from 'express';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { dispatchService } from './dispatch.service.js';
import type {
  AddStopBodySchema,
  AssignRunBodySchema,
  DateQuerySchema,
  RenameRunBodySchema,
  ReorderRunBodySchema,
  RunIdParamsSchema,
  RunStopParamsSchema,
} from './dispatch.schemas.js';

/**
 * Controller layer — HTTP in, HTTP out. No business rules, no Mongoose.
 *
 * Handlers are arrow-function properties, not methods: Express receives them as
 * bare references, so a `this`-bound method would silently lose its receiver.
 */
export const dispatchController = {
  board: async (
    req: ValidatedRequest<{ query: typeof DateQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await dispatchService.board(req.validated.query.date));
  },

  mapPins: async (
    req: ValidatedRequest<{ query: typeof DateQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await dispatchService.mapPins(req.validated.query.date));
  },

  drivers: async (_req: ValidatedRequest<object>, res: Response): Promise<void> => {
    res.json(await dispatchService.drivers());
  },

  createRun: async (
    req: ValidatedRequest<{ body: typeof CreateRunInputSchema }>,
    res: Response,
  ): Promise<void> => {
    const run = await dispatchService.createRun(req.validated.body);
    // 201 with the created run: the board needs its id to render the column.
    res.status(201).json(run);
  },

  runSheet: async (
    req: ValidatedRequest<{ params: typeof RunIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await dispatchService.runSheet(req.validated.params.id));
  },

  renameRun: async (
    req: ValidatedRequest<{ params: typeof RunIdParamsSchema; body: typeof RenameRunBodySchema }>,
    res: Response,
  ): Promise<void> => {
    await dispatchService.renameRun(req.validated.params.id, req.validated.body.name);
    res.status(204).send();
  },

  deleteRun: async (
    req: ValidatedRequest<{ params: typeof RunIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    await dispatchService.deleteRun(req.validated.params.id);
    res.status(204).send();
  },

  addJob: async (
    req: ValidatedRequest<{ params: typeof RunIdParamsSchema; body: typeof AddStopBodySchema }>,
    res: Response,
  ): Promise<void> => {
    await dispatchService.addJobToRun(req.validated.params.id, req.validated.body.jobId);
    res.status(204).send();
  },

  removeJob: async (
    req: ValidatedRequest<{ params: typeof RunStopParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    await dispatchService.removeJobFromRun(req.validated.params.id, req.validated.params.jobId);
    res.status(204).send();
  },

  reorderRun: async (
    req: ValidatedRequest<{ params: typeof RunIdParamsSchema; body: typeof ReorderRunBodySchema }>,
    res: Response,
  ): Promise<void> => {
    await dispatchService.reorderRun(req.validated.params.id, req.validated.body.jobIds);
    res.status(204).send();
  },

  /** Returns the run: the new order is the whole point of the call. */
  optimiseRun: async (
    req: ValidatedRequest<{ params: typeof RunIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await dispatchService.optimiseRun(req.validated.params.id));
  },

  assignRun: async (
    req: ValidatedRequest<{ params: typeof RunIdParamsSchema; body: typeof AssignRunBodySchema }>,
    res: Response,
  ): Promise<void> => {
    await dispatchService.assignRun(req.validated.params.id, req.validated.body.driverId);
    res.status(204).send();
  },

  unassignRun: async (
    req: ValidatedRequest<{ params: typeof RunIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    await dispatchService.unassignRun(req.validated.params.id);
    res.status(204).send();
  },
};
