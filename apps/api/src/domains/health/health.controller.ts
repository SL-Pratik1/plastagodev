import type { Request, Response } from 'express';
import { healthService } from './health.service.js';

/**
 * Controller layer — translates HTTP to and from the service. No business rules
 * here, and no database access; if a controller grows an `if` about domain
 * meaning, that `if` belongs in the service.
 *
 * Handlers are arrow-function properties, not methods. Express receives them as
 * bare references, so a `this`-bound method would silently lose its receiver.
 */
export const healthController = {
  getLiveness: (_req: Request, res: Response): void => {
    res.json(healthService.getLiveness());
  },

  getReadiness: async (_req: Request, res: Response): Promise<void> => {
    const readiness = await healthService.getReadiness();
    // 503 while degraded so the platform's load balancer stops sending traffic.
    res.status(readiness.status === 'ready' ? 200 : 503).json(readiness);
  },
};
