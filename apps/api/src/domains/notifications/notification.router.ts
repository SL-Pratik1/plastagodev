import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { notificationController } from './notification.controller.js';
import {
  ListNotificationsQuerySchema,
  NotificationIdsSchema,
} from './notification.schemas.js';

/**
 * Router layer — paths and middleware only. No logic.
 *
 * ── Why there is no user id anywhere ──────────────────────────────────────
 * A caller reads and marks their OWN inbox, resolved from the session. There is
 * nothing in a URL to change, so there is no way to read somebody else's — which
 * matters because a notification names a customer, a job number and an amount.
 */
export const notificationRouter = Router();

notificationRouter.use(requireAuth);

notificationRouter.get(
  '/',
  validate({ query: ListNotificationsQuerySchema }),
  asyncHandler(notificationController.list),
);

/** Two numbers, nothing else — the shell polls this on every page. */
notificationRouter.get('/summary', asyncHandler(notificationController.summary));

notificationRouter.post(
  '/read',
  validate({ body: NotificationIdsSchema }),
  asyncHandler(notificationController.markRead),
);

notificationRouter.post('/read-all', asyncHandler(notificationController.markAllRead));

/**
 * M8.7 — the sweep that chases.
 *
 * Normally scheduled; this is the manual trigger, gated to operations because
 * it writes into everybody's inbox.
 */
notificationRouter.post(
  '/sweep',
  requireRole('super-admin', 'operations'),
  asyncHandler(notificationController.runSweep),
);
