import type { ApiClient } from '@plastago/api-client';
import { createMockServices } from '../mock/create-mock-services.js';
import type { Services } from '../types.js';
import { createHttpAuthService } from './auth.http.js';

/**
 * The HTTP service graph — real endpoints where they exist, mocks elsewhere.
 *
 * ── Why this is a hybrid rather than an all-or-nothing swap ─────────────────
 * There are nineteen service interfaces and roughly 139 methods behind them.
 * Waiting until every endpoint exists before switching any of them would mean
 * one enormous cutover, with the first real integration bug arriving at the
 * same moment as the hundredth — and no way to tell which change caused what.
 *
 * So the graph is composed: each domain moves from `mock` to `http` on the day
 * its endpoints land, and the mock keeps the app running in the meantime. The
 * screens cannot tell the difference, because both sides implement the same
 * interfaces.
 *
 * Wiring a newly built domain is one line below, plus its adapter. Once the
 * last one is real, the fallback and the whole `mock/` folder are deleted.
 *
 *     WIRED   auth
 *     MOCKED  users, customers, jobs, dispatch, dashboard, invoices, reports,
 *             drivers, vehicles, notifications, settings, portal, queues,
 *             audit, lookups, driverRun
 */
export function createHttpServices(api: ApiClient): Services {
  // Everything not yet wired. Retained rather than stubbed with throws so the
  // console and the portal stay demonstrable while the backend is built.
  const fallback = createMockServices();

  return {
    ...fallback,
    auth: createHttpAuthService(api),
  };
}
