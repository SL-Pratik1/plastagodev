import { API_PREFIX } from '@plastago/shared';
import { Router, type Express } from 'express';
import { healthRouter } from './domains/health/health.router.js';

/**
 * Single place where routers are mounted. Adding a domain means one import and
 * one `use` line here — nothing is auto-discovered, so the routing table is
 * always readable in one file.
 */
export function mountRoutes(app: Express): void {
  // Platform probes live outside the versioned contract.
  app.use(healthRouter);

  const v1 = Router();

  // v1.use('/auth', authRouter);
  // v1.use('/accounts', accountsRouter);
  // v1.use('/jobs', jobsRouter);

  v1.get('/', (_req, res) => {
    res.json({ message: 'PlastaGo API v1', docs: '/openapi.json' });
  });

  app.use(API_PREFIX, v1);
}
