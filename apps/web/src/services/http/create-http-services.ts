import type { ApiClient } from '@plastago/api-client';
import type { Services } from '../types.js';
import {
  createHttpCustomerService,
  createHttpDispatchService,
  createHttpInvoiceService,
  createHttpJobService,
  createHttpReportService,
  createHttpVehicleService,
} from './admin.http.js';
import { createHttpAuthService } from './auth.http.js';
import { createHttpDriverRunService } from './driver-run.http.js';
import { createHttpExtractorService } from './extractor.http.js';
import { createHttpPortalService } from './portal.http.js';
import { createHttpQueueService } from './queues.http.js';
import {
  createHttpAuditService,
  createHttpDashboardService,
  createHttpDriverService,
  createHttpLookupService,
  createHttpNotificationService,
  createHttpSettingsService,
  createHttpUserService,
} from './reference.http.js';

/**
 * The service graph, over the real API.
 *
 * ── There is no mock fallback any more ────────────────────────────────────
 * There used to be: each domain moved from `mock` to `http` as its endpoints
 * landed, and the mock kept the app running in between. Every domain is now
 * real, so the fallback is gone and `services/mock/` with it. Keeping a mock
 * beside a working backend is how a screen ends up quietly reading fixtures for
 * a month without anybody noticing.
 *
 * The screens did not change. That is the point of the seam described in
 * `services/README.md`: both sides implemented the same interfaces from
 * `types.ts`, so the swap is this file.
 */
export function createHttpServices(api: ApiClient): Services {
  return {
    auth: createHttpAuthService(api),
    lookups: createHttpLookupService(api),
    users: createHttpUserService(api),
    customers: createHttpCustomerService(api),
    jobs: createHttpJobService(api),
    dispatch: createHttpDispatchService(api),
    dashboard: createHttpDashboardService(api),
    invoices: createHttpInvoiceService(api),
    reports: createHttpReportService(api),
    drivers: createHttpDriverService(api),
    vehicles: createHttpVehicleService(api),
    notifications: createHttpNotificationService(api),
    settings: createHttpSettingsService(api),
    extractor: createHttpExtractorService(api),
    audit: createHttpAuditService(api),
    queues: createHttpQueueService(api),
    portal: createHttpPortalService(api),
    driverRun: createHttpDriverRunService(api),
  };
}
