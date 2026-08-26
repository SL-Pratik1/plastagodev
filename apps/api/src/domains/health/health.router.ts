import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { healthController } from './health.controller.js';

/**
 * Router layer — paths and middleware only.
 *
 * These two probes are mounted at the root rather than under `/api/v1` because
 * they are platform infrastructure, not part of the versioned contract.
 */
export const healthRouter = Router();

healthRouter.get('/healthz', healthController.getLiveness);
healthRouter.get('/readyz', asyncHandler(healthController.getReadiness));
