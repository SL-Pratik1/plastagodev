import { Suspense, type ReactNode } from 'react';
import { createBrowserRouter } from 'react-router';
import {
  AuditLogPage,
  CustomerDetailPage,
  CustomersPage,
  DashboardPage,
  DispatchPage,
  DriverDetailPage,
  DriversPage,
  FoundationPage,
  InvoiceDetailPage,
  InvoicesPage,
  JobCreatePage,
  JobDetailPage,
  JobsPage,
  NotificationsPage,
  PortalAccountPage,
  PortalBookPage,
  PortalCertificatesPage,
  PortalDashboardPage,
  PortalInvoicesPage,
  PortalJobDetailPage,
  PortalJobEditPage,
  PortalJobsPage,
  PortalReportsPage,
  PortalSiteDetailPage,
  PortalSitesPage,
  PortalSupervisorsPage,
  QueueApprovalsPage,
  QueueAwaitingPoPage,
  QueueFutilePage,
  QueueLeadDetailPage,
  QueueLeadsPage,
  QueuePoReviewDetailPage,
  QueuePoReviewPage,
  ReportsPage,
  SettingsPage,
  UserDetailPage,
  UsersPage,
  VehicleDetailPage,
  VehiclesPage,
} from './lazy-pages';
import { PageSkeleton } from '@/components/page-skeleton';
import { RequireAuth } from '@/features/auth/require-auth';
import { RequireCapability } from '@/features/auth/require-capability';
import { AdminShell } from '@/layouts/admin-shell';
import { AuthLayout } from '@/layouts/auth-layout';
import { PlainLayout } from '@/layouts/plain-layout';
import { PortalLayout } from '@/layouts/portal-layout';
import { DriverAppPage } from '@/pages/auth/driver-app';
import { ForbiddenPage } from '@/pages/auth/forbidden';
import { RootRedirect } from '@/pages/auth/root-redirect';
import { SignInPage } from '@/pages/auth/sign-in';
import { VerifyOtpPage } from '@/pages/auth/verify-otp';
import { NotFoundPage } from '@/pages/not-found';
import { RouteError } from './route-error';

/**
 * The whole route table, in one file.
 *
 * Role-based routing (§6A.5): `/admin/*` is the office console (M2, M3, M7, M9)
 * and `/portal/*` is the customer portal (M5) — one app, one session, two
 * shells. The driver app is a SEPARATE Vite app because its service worker and
 * offline shell need their own build configuration.
 *
 * ── How access is enforced ─────────────────────────────────────────────────
 * Guards wrap each route GROUP, never individual pages, exactly as this file has
 * instructed since the scaffold. Two layers, and they do different jobs:
 *
 *   <RequireAuth>                    is there a session at all?
 *     └── <RequireCapability>        may this role use this surface / screen?
 *           └── <AdminShell>         the chrome
 *                 └── the page
 *
 * The consequence worth stating: a new screen added under `/admin` is protected
 * by virtue of existing. There is no per-page check for anyone to forget, and one
 * file — `features/auth/permissions.ts` — decides both what the guard allows and
 * what the navigation shows.
 *
 * Surface boundaries use `onDenied="redirect"` (a customer typing `/admin` is in
 * the wrong app and should just go home); screens inside a surface use the
 * default `deny` and render a 403, because silently moving someone who *is* in
 * the right place is disorienting.
 *
 * ── Code splitting ────────────────────────────────────────────────────────
 * The auth screens and the shells load eagerly: they are on the critical path to
 * first paint and splitting them would add a spinner to the very first
 * interaction. Everything behind the shell is lazy, split by nav group, so
 * signing in does not download the Recharts bundle, the dispatch board and every
 * detail page before showing a dashboard.
 */
const load = (element: ReactNode) => <Suspense fallback={<PageSkeleton />}>{element}</Suspense>;

export const router = createBrowserRouter([
  {
    path: '/',
    errorElement: <RouteError />,
    children: [
      // Role-based landing. Replaces the scaffold landing page.
      { index: true, element: <RootRedirect /> },

      // ── Unauthenticated ────────────────────────────────────────────────
      {
        path: 'auth',
        element: <AuthLayout />,
        children: [
          { path: 'sign-in', element: <SignInPage /> },
          { path: 'verify', element: <VerifyOtpPage /> },
          // A driver who signs in here has a valid account but the wrong app.
          { path: 'driver-app', element: <DriverAppPage /> },
        ],
      },

      // ── Authenticated ─────────────────────────────────────────────────
      {
        element: <RequireAuth />,
        children: [
          {
            path: 'admin',
            element: <RequireCapability capability="admin:access" onDenied="redirect" />,
            children: [
              {
                element: <AdminShell />,
                children: [
                  { index: true, element: load(<DashboardPage />) },

                  // Operations
                  {
                    element: <RequireCapability capability="jobs:read" />,
                    children: [
                      { path: 'jobs', element: load(<JobsPage />) },
                      // Before `:jobId`, or "new" would be read as an id.
                      // W47 is the office's, not the allocator's — and booking a
                      // job means agreeing a price.
                      {
                        element: <RequireCapability capability="jobs:create" />,
                        children: [{ path: 'jobs/new', element: load(<JobCreatePage />) }],
                      },
                      { path: 'jobs/:jobId', element: load(<JobDetailPage />) },
                    ],
                  },
                  {
                    element: <RequireCapability capability="dispatch:manage" />,
                    children: [{ path: 'dispatch', element: load(<DispatchPage />) }],
                  },

                  // Queues — the four exception queues share one capability
                  // because they are one job: clearing what the system could
                  // not decide by itself.
                  {
                    element: <RequireCapability capability="queues:action" />,
                    children: [
                      { path: 'queues/futile', element: load(<QueueFutilePage />) },
                      { path: 'queues/approvals', element: load(<QueueApprovalsPage />) },
                      { path: 'queues/awaiting-po', element: load(<QueueAwaitingPoPage />) },
                      { path: 'queues/po-review', element: load(<QueuePoReviewPage />) },
                      {
                        path: 'queues/po-review/:extractionId',
                        element: load(<QueuePoReviewDetailPage />),
                      },
                    ],
                  },
                  {
                    element: <RequireCapability capability="leads:manage" />,
                    children: [
                      { path: 'queues/leads', element: load(<QueueLeadsPage />) },
                      { path: 'queues/leads/:leadId', element: load(<QueueLeadDetailPage />) },
                    ],
                  },

                  // Commercial
                  {
                    element: <RequireCapability capability="accounts:manage" />,
                    children: [
                      { path: 'customers', element: load(<CustomersPage />) },
                      { path: 'customers/:customerId', element: load(<CustomerDetailPage />) },
                    ],
                  },
                  {
                    element: <RequireCapability capability="invoices:read" />,
                    children: [
                      { path: 'invoices', element: load(<InvoicesPage />) },
                      { path: 'invoices/:invoiceId', element: load(<InvoiceDetailPage />) },
                    ],
                  },
                  {
                    element: <RequireCapability capability="reports:read" />,
                    children: [{ path: 'reports', element: load(<ReportsPage />) }],
                  },

                  // People & fleet
                  {
                    element: <RequireCapability capability="users:manage" />,
                    children: [
                      { path: 'users', element: load(<UsersPage />) },
                      { path: 'users/:userId', element: load(<UserDetailPage />) },
                    ],
                  },
                  {
                    element: <RequireCapability capability="drivers:manage" />,
                    children: [
                      { path: 'drivers', element: load(<DriversPage />) },
                      { path: 'drivers/:driverId', element: load(<DriverDetailPage />) },
                    ],
                  },
                  {
                    element: <RequireCapability capability="vehicles:manage" />,
                    children: [
                      { path: 'vehicles', element: load(<VehiclesPage />) },
                      { path: 'vehicles/:vehicleId', element: load(<VehicleDetailPage />) },
                    ],
                  },

                  // Configuration
                  {
                    element: <RequireCapability capability="notifications:read" />,
                    children: [{ path: 'notifications', element: load(<NotificationsPage />) }],
                  },
                  {
                    element: <RequireCapability capability="settings:manage" />,
                    children: [{ path: 'settings', element: load(<SettingsPage />) }],
                  },

                  // System
                  {
                    element: <RequireCapability capability="audit:read" />,
                    children: [{ path: 'audit-log', element: load(<AuditLogPage />) }],
                  },
                  {
                    element: <RequireCapability capability="foundation:view" />,
                    children: [{ path: 'foundation', element: load(<FoundationPage />) }],
                  },
                ],
              },
            ],
          },

          /*
           * The customer portal (M5 Part 1).
           *
           * Guards wrap groups, exactly as on the admin side. The commercial
           * screens sit behind their own capabilities so a Site Supervisor
           * typing `/portal/invoices` gets a 403 rather than an empty grid —
           * M1.5 is explicit that they cannot see pricing.
           *
           * ⚠️ These guards decide what RENDERS. The data scoping — this
           * account, and for a supervisor these sites — is done by the server
           * from the session, and `CustomerPortalService` deliberately takes no
           * account or site parameter so the browser cannot ask for someone
           * else's.
           */
          {
            path: 'portal',
            element: <RequireCapability capability="portal:access" onDenied="redirect" />,
            children: [
              {
                element: <PortalLayout />,
                children: [
                  { index: true, element: load(<PortalDashboardPage />) },

                  // Pickups — both customer roles.
                  { path: 'jobs', element: load(<PortalJobsPage />) },
                  { path: 'jobs/:jobId', element: load(<PortalJobDetailPage />) },
                  { path: 'jobs/:jobId/edit', element: load(<PortalJobEditPage />) },

                  {
                    element: <RequireCapability capability="portal:book" />,
                    children: [{ path: 'book', element: load(<PortalBookPage />) }],
                  },
                  {
                    element: <RequireCapability capability="portal:sites" />,
                    children: [
                      { path: 'sites', element: load(<PortalSitesPage />) },
                      { path: 'sites/:siteId', element: load(<PortalSiteDetailPage />) },
                    ],
                  },

                  // Commercial — Customer Administrator only.
                  {
                    element: <RequireCapability capability="portal:invoices" />,
                    children: [{ path: 'invoices', element: load(<PortalInvoicesPage />) }],
                  },
                  {
                    element: <RequireCapability capability="portal:reports" />,
                    children: [{ path: 'reports', element: load(<PortalReportsPage />) }],
                  },
                  {
                    element: <RequireCapability capability="portal:certificates" />,
                    children: [{ path: 'certificates', element: load(<PortalCertificatesPage />) }],
                  },
                  {
                    element: <RequireCapability capability="portal:supervisors" />,
                    children: [{ path: 'supervisors', element: load(<PortalSupervisorsPage />) }],
                  },
                  {
                    element: <RequireCapability capability="portal:account" />,
                    children: [{ path: 'account', element: load(<PortalAccountPage />) }],
                  },
                ],
              },
            ],
          },
        ],
      },

      // ── Anything else ─────────────────────────────────────────────────
      {
        element: <PlainLayout />,
        children: [
          { path: 'forbidden', element: <ForbiddenPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);
