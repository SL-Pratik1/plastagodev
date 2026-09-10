import { API_PREFIX } from '@plastago/shared';
import { Router, type Express } from 'express';
import { accountRouter } from './domains/accounts/account.router.js';
import { authRouter } from './domains/auth/auth.router.js';
import { dashboardRouter } from './domains/dashboard/dashboard.router.js';
import { dispatchRouter } from './domains/dispatch/dispatch.router.js';
import { driverRouter } from './domains/driver/driver.router.js';
import { extractorRouter } from './domains/extractor/extractor.router.js';
import { vehicleRouter } from './domains/fleet/vehicle.router.js';
import { healthRouter } from './domains/health/health.router.js';
import { invoiceRouter } from './domains/invoices/invoice.router.js';
import { jobRouter } from './domains/jobs/job.router.js';
import { notificationRouter } from './domains/notifications/notification.router.js';
import { lookupRouter } from './domains/lookups/lookup.router.js';
import { placeRouter } from './domains/places/place.router.js';
import { rosterRouter } from './domains/roster/roster.router.js';
import { reportRouter } from './domains/reports/report.router.js';
import { portalRouter } from './domains/portal/portal.router.js';
import { poWebhookRouter } from './domains/queues/po-webhook.router.js';
import { queueRouter } from './domains/queues/queue.router.js';
import { settingsRouter } from './domains/settings/settings.router.js';
import { userRouter } from './domains/users/user.router.js';
import { storageRouter } from './domains/storage/storage.router.js';

/**
 * Single place where routers are mounted. Adding a domain means one import and
 * one `use` line here — nothing is auto-discovered, so the routing table is
 * always readable in one file.
 */
export function mountRoutes(app: Express): void {
  // Platform probes live outside the versioned contract.
  app.use(healthRouter);

  // The stub storage provider stands in for S3 in development. Unreachable when
  // STORAGE_PROVIDER=s3 — see the note on the router.
  app.use(storageRouter);

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

  // M4 — the driver's phone. Everything under here is scoped to the signed-in
  // driver's own work; see the note on the router.
  v1.use('/driver', driverRouter);

  // M7 — invoicing. Reads are scoped so a customer sees their own; the acts
  // that decide what gets billed are gated in the service.
  v1.use('/invoices', invoiceRouter);

  // M2.6 · M2.7 · M7.3 — the office's worklists. Everything waiting on a human
  // decision, oldest first, because the old row is the one that costs money.
  v1.use('/queues', queueRouter);

  /*
   * I6 — the purchase-order extractor's callback.
   *
   * Mounted apart from `/queues` because it is the one route in the versioned
   * API with no session: the caller is a machine and authenticates with a shared
   * secret instead. Keeping it out of `queueRouter` means that router's contract
   * stays "everything here is authenticated" — see the note on the router.
   */
  v1.use('/webhooks', poWebhookRouter);

  /*
   * I6 — the Extractor tab's session broker.
   *
   * Mounted apart from `/queues` and `/settings` because it belongs to neither:
   * it authorises nothing about a purchase order and configures nothing on this
   * side. Its whole job is to mint a third party's credential for a browser
   * without the credential that mints it ever reaching one.
   */
  v1.use('/extractor', extractorRouter);

  // M5 — the customer portal. Scoped entirely from the session; no route here
  // takes an account id, so no URL can widen what a customer sees.
  v1.use('/portal', portalRouter);

  // M1.5 — who can get into the system. Gated to operations and super-admins;
  // customers manage their own supervisors through the portal instead.
  v1.use('/users', userRouter);

  // M9.7 · F43 — the fleet. Odometer and expenses go in, cost per kilometre
  // comes out; nothing here accepts a cost figure.
  v1.use('/vehicles', vehicleRouter);

  // M9.1-M9.6 — fixed named reports, plus M9.5 diversion certificates. No
  // generic query endpoint, deliberately: see the note on the router.
  v1.use('/reports', reportRouter);

  // M8.7 — the internal notification centre. Scoped to the caller's own inbox;
  // no route takes a user id.
  v1.use('/notifications', notificationRouter);

  // M9.4 · F15 — the admin dashboard. One call for the whole screen.
  v1.use('/dashboard', dashboardRouter);

  /*
   * M9.8 · F53 / M9.9 · F22 — the office's view of the driver: credentials,
   * training and how their quarter went. `/driver` (singular, above) is the
   * driver's OWN app and a different audience entirely.
   */
  v1.use('/drivers', rosterRouter);

  /*
   * Reference lists for pickers. Mounted alongside the place router, which owns
   * `/lookups/places` — a public suburb table and the customer register have
   * different access rules, so they stay different domains.
   */
  v1.use('/lookups', lookupRouter);

  v1.get('/', (_req, res) => {
    res.json({ message: 'PlastaGo API v1', docs: '/openapi.json' });
  });

  app.use(API_PREFIX, v1);
}
