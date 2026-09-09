import type { Response } from 'express';
import { AppError } from '../../lib/app-error.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { notificationService, type Caller } from './notification.service.js';
import type {
  ListNotificationsQuerySchema,
  NotificationIdsSchema,
} from './notification.schemas.js';

/** Controller layer — HTTP in, HTTP out. No business rules, no Mongoose. */

function callerFrom(req: { auth?: Express.Request['auth'] }): Caller {
  if (!req.auth) throw AppError.unauthenticated('Sign in to continue');

  return {
    userId: req.auth.userId,
    name: req.auth.name,
    roles: req.auth.roles as Caller['roles'],
  };
}

export const notificationController = {
  list: async (
    req: ValidatedRequest<{ query: typeof ListNotificationsQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await notificationService.list(req.validated.query, callerFrom(req)));
  },

  /** The badge. Polled by the shell, so it is deliberately two numbers. */
  summary: async (req: ValidatedRequest<object>, res: Response): Promise<void> => {
    res.json(await notificationService.summary(callerFrom(req)));
  },

  markRead: async (
    req: ValidatedRequest<{ body: typeof NotificationIdsSchema }>,
    res: Response,
  ): Promise<void> => {
    const changed = await notificationService.markRead(req.validated.body.ids, callerFrom(req));
    res.json({ changed });
  },

  markAllRead: async (req: ValidatedRequest<object>, res: Response): Promise<void> => {
    const changed = await notificationService.markAllRead(callerFrom(req));
    res.json({ changed });
  },

  /** 202 — the sweep runs on a schedule; this is the manual trigger. */
  runSweep: async (_req: ValidatedRequest<object>, res: Response): Promise<void> => {
    res.status(202).json(await notificationService.runQueueSweep());
  },

  /** 202: the reminders are going out, and the counts say how many. */
  runReadinessReminders: async (_req: unknown, res: Response): Promise<void> => {
    res.status(202).json(await notificationService.runReadinessReminders());
  },
};
