import { API_PREFIX } from '@plastago/shared';
import { Router, type Express } from 'express';
import { accountRouter } from './domains/accounts/account.router.js';
import { authRouter } from './domains/auth/auth.router.js';
import { dispatchRouter } from './domains/dispatch/dispatch.router.js';
import { healthRouter } from './domains/health/health.router.js';
import { jobRouter } from './domains/jobs/job.router.js';
import { placeRouter } from './domains/places/place.router.js';
import { settingsRouter } from './domains/settings/settings.router.js';

/**
 * Single place where routers are mounted. Adding a domain means one import and
 * one `use` line here — nothing is auto-discovered, so the routing table is
 * always readable in one file.
 */
export function mountRoutes(app: Express): void {
  // Platform probes live outside the versioned contract.
  app.use(healthRouter);

  const v1 = Router();

  // Unauthenticated by design — this is how a session begins (§9).
  v1.use('/auth', authRouter);

  // M2.8 · W8 — accounts. Authenticated inside the router, not here, so a new
  // route cannot be added unprotected by omission.
  v1.use('/accounts', accountRouter);

  // M2.4 · M6 · W7 — platform settings, and the pricing preview that lives with
  // them because a quote is a settings lookup, not a job.
  v1.use('/settings', settingsRouter);

  // M2.1 — the suburb picker. Mounted under `/lookups` because that is what it
  // is to every caller; the remaining lookup lists join it here.
  v1.use('/lookups', placeRouter);

  // M3 — dispatch. Runs, the allocation board and the map. Internal only:
  // the router gates the whole domain, because a customer has no scoped view
  // of a run.
  v1.use('/dispatch', dispatchRouter);

  // M2 — jobs. The centre of the system: everything else either feeds it or
  // reads from it.
  v1.use('/jobs', jobRouter);

  v1.get('/', (_req, res) => {
    res.json({ message: 'PlastaGo API v1', docs: '/openapi.json' });
  });

  app.use(API_PREFIX, v1);
}
