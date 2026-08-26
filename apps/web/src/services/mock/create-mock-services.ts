import type { Services } from '../types.js';
import { createMockAuditService } from './audit.mock.js';
import { createMockAuthService } from './auth.mock.js';
import { createMockCustomerService } from './customers.mock.js';
import { createMockDashboardService } from './dashboard.mock.js';
import { createMockDispatchService } from './dispatch.mock.js';
import { createMockDriverService, createMockVehicleService } from './fleet.mock.js';
import { createMockInvoiceService } from './invoices.mock.js';
import { createMockJobService } from './jobs.mock.js';
import { createMockLookupService } from './lookups.mock.js';
import { createMockNotificationService } from './notifications.mock.js';
import { createMockPortalService } from './portal.mock.js';
import { createMockQueueService } from './queues.mock.js';
import { createMockReportService } from './reports.mock.js';
import { createMockSettingsService } from './settings.mock.js';
import { createMockUserService } from './users.mock.js';

/**
 * The mock implementation of every service.
 *
 * This is the only place the app knows it is running on fixtures. Swapping to
 * the real backend is one line in `main.tsx` — `createHttpServices(api)` instead
 * of `createMockServices()` — plus writing those adapters. No screen, hook or
 * component changes.
 *
 * All the mocks share one in-memory store (`./store.ts`), so an action in one
 * domain is visible in the others: allocate a job on the board and the jobs grid
 * shows the driver.
 */
export function createMockServices(): Services {
  return {
    auth: createMockAuthService(),
    lookups: createMockLookupService(),
    users: createMockUserService(),
    customers: createMockCustomerService(),
    jobs: createMockJobService(),
    dispatch: createMockDispatchService(),
    dashboard: createMockDashboardService(),
    invoices: createMockInvoiceService(),
    reports: createMockReportService(),
    drivers: createMockDriverService(),
    vehicles: createMockVehicleService(),
    notifications: createMockNotificationService(),
    settings: createMockSettingsService(),
    audit: createMockAuditService(),
    queues: createMockQueueService(),
    portal: createMockPortalService(),
  };
}
