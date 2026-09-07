import { CreateRunInputSchema } from '@plastago/shared';
import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { dispatchController } from './dispatch.controller.js';
import {
  AddStopBodySchema,
  AssignRunBodySchema,
  DateQuerySchema,
  RenameRunBodySchema,
  ReorderRunBodySchema,
  RunIdParamsSchema,
  RunStopParamsSchema,
} from './dispatch.schemas.js';

/**
 * Router layer — paths and middleware only. No logic.
 *
 * ── Why this whole domain is role-gated at the door ───────────────────────
 * Runs are internal. A customer never sees one: they see their own job's
 * status, not which truck it is on, who else is on that truck, or what the
 * other builders on the run are paying. There is no useful scoped view of a
 * run for a customer, so there is no scoping in the repository either — the
 * gate here is the boundary, which is why it is applied once to the whole
 * router rather than route by route.
 */
export const dispatchRouter = Router();

dispatchRouter.use(requireAuth);

/**
 * The allocator is the role this screen exists for; operations and admin see
 * everything. Office staff are included because they answer the phone when a
 * builder asks where the truck is.
 */
dispatchRouter.use(requireRole('super-admin', 'operations', 'allocator', 'office-staff'));

/* ── Reading the board ───────────────────────────────────────────────────── */

dispatchRouter.get(
  '/board',
  validate({ query: DateQuerySchema }),
  asyncHandler(dispatchController.board),
);

dispatchRouter.get(
  '/map',
  validate({ query: DateQuerySchema }),
  asyncHandler(dispatchController.mapPins),
);

dispatchRouter.get('/drivers', asyncHandler(dispatchController.drivers));

/* ── Building a run ──────────────────────────────────────────────────────── */

/**
 * Creating, filling and assigning are three calls, not one.
 *
 * The allocator shapes the day before staffing it (Matt, 44:50), so a run with
 * no driver on it is a valid, saveable thing — it is most of what the board
 * holds at 7am.
 */
dispatchRouter.post(
  '/runs',
  validate({ body: CreateRunInputSchema }),
  asyncHandler(dispatchController.createRun),
);

dispatchRouter.get(
  '/runs/:id/sheet',
  validate({ params: RunIdParamsSchema }),
  asyncHandler(dispatchController.runSheet),
);

dispatchRouter.patch(
  '/runs/:id',
  validate({ params: RunIdParamsSchema, body: RenameRunBodySchema }),
  asyncHandler(dispatchController.renameRun),
);

dispatchRouter.delete(
  '/runs/:id',
  validate({ params: RunIdParamsSchema }),
  asyncHandler(dispatchController.deleteRun),
);

dispatchRouter.post(
  '/runs/:id/jobs',
  validate({ params: RunIdParamsSchema, body: AddStopBodySchema }),
  asyncHandler(dispatchController.addJob),
);

dispatchRouter.delete(
  '/runs/:id/jobs/:jobId',
  validate({ params: RunStopParamsSchema }),
  asyncHandler(dispatchController.removeJob),
);

dispatchRouter.post(
  '/runs/:id/reorder',
  validate({ params: RunIdParamsSchema, body: ReorderRunBodySchema }),
  asyncHandler(dispatchController.reorderRun),
);

/** I11 — overwrites any hand-ordering, which is why the UI confirms first. */
dispatchRouter.post(
  '/runs/:id/optimise',
  validate({ params: RunIdParamsSchema }),
  asyncHandler(dispatchController.optimiseRun),
);

/* ── Staffing it ─────────────────────────────────────────────────────────── */

dispatchRouter.post(
  '/runs/:id/assign',
  validate({ params: RunIdParamsSchema, body: AssignRunBodySchema }),
  asyncHandler(dispatchController.assignRun),
);

dispatchRouter.post(
  '/runs/:id/unassign',
  validate({ params: RunIdParamsSchema }),
  asyncHandler(dispatchController.unassignRun),
);
