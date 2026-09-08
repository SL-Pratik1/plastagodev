import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { auditController } from './audit.controller.js';
import { AuditIdParamsSchema, ListAuditQuerySchema } from './audit.schemas.js';

/**
 * Router layer — paths and middleware only. No logic.
 *
 * ── ⚠️ There are three routes here and all three are GETs ─────────────────
 * That is not an omission to be filled in later. M1.6 requires the log to be
 * immutable, so there is no POST, no PATCH and no DELETE anywhere in this
 * domain — not even for an administrator. Entries arrive from other services
 * calling `auditService.record()` and from the change-stream backstop, both of
 * which are inside the process. Nothing reaches this collection over HTTP.
 *
 * If an entry is wrong, the answer is to append a correcting one. An audit log
 * with an edit endpoint is not an audit log.
 */
export const auditRouter = Router();

auditRouter.use(requireAuth);

/*
 * Super-admin and operations, matching the console's `audit:read` capability.
 * This is accountability data about staff — who suspended whom, who approved
 * what — and a wider audience makes it a surveillance feed. The service asserts
 * the same rule again, because a route is not where a business rule should be
 * the only time it is stated.
 */
auditRouter.use(requireRole('super-admin', 'operations'));

auditRouter.get(
  '/',
  validate({ query: ListAuditQuerySchema }),
  asyncHandler(auditController.list),
);

/** Before `/:id`, or "coverage" is read as an entry id. */
auditRouter.get('/coverage', asyncHandler(auditController.coverage));

auditRouter.get(
  '/:id',
  validate({ params: AuditIdParamsSchema }),
  asyncHandler(auditController.get),
);
