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

/**
 * M8.3 — the readiness reminders for tomorrow.
 *
 * ⚠️ A separate endpoint from the sweep above, not a flag on it. This one sends
 * MESSAGES to customers; that one writes rows into an internal inbox. Folding
 * them together would mean nobody could re-run the harmless one without
 * risking a second round of texts to every site booked for tomorrow.
 *
 * Normally scheduled in the evening; gated to operations because it spends
 * money and reaches people outside the company.
 */
notificationRouter.post(
  '/readiness-reminders',
  requireRole('super-admin', 'operations'),
  asyncHandler(notificationController.runReadinessReminders),
);
