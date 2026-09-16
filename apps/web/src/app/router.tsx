import { Suspense, type ReactNode } from 'react';
import { createBrowserRouter, type RouteObject } from 'react-router';
import type { Surface } from '@plastago/shared';
import {
  CustomerCreatePage,
  CustomerDetailPage,
  CustomersPage,
  DashboardPage,
  DispatchPage,
  DriverDetailPage,
  DriverJobContaminationPage,
  DriverJobDetailPage,
  DriverJobFutilePage,
  DriverJobPhotosPage,
  DriverNavigatePage,
  DriverJobRiskAssessmentPage,
  DriverJobWeightsPage,
  DriverPreStartPage,
  DriverReportDefectPage,
  DriverRunSheetPage,
  DriversPage,
  DriverTipOffPage,
  InvoiceDetailPage,
  InvoicesPage,
  JobCreatePage,
  JobDetailPage,
  JobsPage,
  NotificationsPage,
  PortalAccountPage,
  PortalBookPage,
  PortalCertificatesPage,
  PortalNotificationsPage,
  PortalDashboardPage,
  PortalInvoicesPage,
  PortalJobDetailPage,
  PortalJobEditPage,
  PortalJobsPage,
  PortalReportsPage,
  PortalWelcomePage,
  PortalSupervisorsPage,
  QueueApprovalsPage,
  QueueAwaitingPoPage,
  QueueChangeRequestsPage,
  QueueFutilePage,
  QueueLeadCreatePage,
  QueueLeadDetailPage,
  QueueLeadsPage,
  QueuePoReviewDetailPage,
  PortalPurchaseOrdersPage,
  QueueCallUpReviewPage,
  QueueCallUpsPage,
  QueuePoReviewPage,
  ReportsPage,
  ExtractorPage,
  SettingsPage,
  XeroPage,
  UserDetailPage,
  UsersPage,
  VehicleDetailPage,
  VehiclesPage,
} from './lazy-pages';
import { PageSkeleton } from '@/components/page-skeleton';
import { SURFACE_PREFIX, servesSurface } from '@/config/surfaces';
import { RequireAuth } from '@/features/auth/require-auth';
import { RequireCapability } from '@/features/auth/require-capability';
import { RequireBuilderAccount } from '@/features/portal/require-builder-account';
import { AdminShell } from '@/layouts/admin-shell';
import { AuthLayout } from '@/layouts/auth-layout';
import { DriverShell } from '@/layouts/driver-shell';
import { PlainLayout } from '@/layouts/plain-layout';
import { PortalLayout } from '@/layouts/portal-layout';
import { ForbiddenPage } from '@/pages/auth/forbidden';
import { RootRedirect } from '@/pages/auth/root-redirect';
import { SignInPage } from '@/pages/auth/sign-in';
import { SurfaceElsewhere } from '@/pages/auth/surface-elsewhere';
import { VerifyOtpPage } from '@/pages/auth/verify-otp';
import { NotFoundPage } from '@/pages/not-found';
import { RouteError } from './route-error';

/**
 * The whole route table, in one file.
 *
 * Role-based routing (§6A.5): `/admin/*` is the office console (M2, M3, M7, M9),
 * `/portal/*` is the customer portal (M5) and `/driver/*` is the driver app
 * (M4) — one codebase, three surfaces, three shells.
 *
 * ── Why this table is not the same on every server ────────────────────────
 * Each surface has its own origin (`config/surfaces.ts`), and this file is
 * started once per surface. Only the surface a given server owns has its routes
 * mounted; the other two are replaced by a redirect to the origin that does own
 * them. `surfaceRoutes` below is where that happens, and it explains why the
 * capability guards were not sufficient on their own.
 *
 * It once went the other way. The driver screens were a separate Vite app, and
 * were folded back in because a page can only ever offer to install ITSELF —
 * `beforeinstallprompt` is never delivered to a page outside the target
 * manifest's scope, so no "Install the driver app" button could exist in the
 * console while the two were separate origins. The split restores the separate
 * origins, but the Install button survives, because the driver's origin now
 * serves the driver surface and nothing else: it installs itself, under its own
 * manifest, which is what `vite.config.ts` builds per surface.
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

/**
 * Mount a surface's routes, or stand a signpost where they used to be.
 *
 * ── Why the guards were not enough on their own ───────────────────────────
 * Every surface boundary below is already wrapped in a `RequireCapability`, and
 * for a customer who wanders onto `/admin` that is a complete answer: they lack
 * `admin:access` and get redirected home.
 *
 * It is not an answer for the person who HOLDS the capability. An office user
 * opening `/admin` on the portal's origin passes the guard and is shown the
 * console — served from the customer portal's address, under the portal's
 * manifest and service worker. Nothing was leaked to anyone unauthorised, and
 * the split was still defeated: the addresses stopped meaning anything.
 *
 * So the routes are absent rather than guarded, and being absent is what
 * `SurfaceElsewhere` turns into a redirect to the origin that does serve them.
 *
 * In single-server mode (`PLASTAGO_SURFACES=all`) `servesSurface` is true for all
 * three and this collapses back to mounting everything, unchanged.
 */
function surfaceRoutes(surface: Surface, route: RouteObject): RouteObject[] {
  return servesSurface(surface) ? [route] : [];
}

/**
 * The signposts, for every surface this build does not serve.
 *
 * ⚠️ Mounted OUTSIDE `<RequireAuth>`, unlike the routes they replace. A link to
 * another surface is most often opened in a browser with no session — it came
 * from an email — and authenticating someone here would sign them in on the
 * wrong origin and then still have to move them. Send them first; let the
 * origin that owns the page ask who they are.
 *
 * Empty in single-server mode, where there is nowhere else to send anybody.
 */
function elsewhereRoutes(): RouteObject[] {
  return (['admin', 'portal', 'driver'] as const)
    .filter((surface) => !servesSurface(surface))
    .flatMap((surface) => {
      // `/portal` and `/portal/*`: the subtree moves, and the path inside it is
      // the part worth carrying across.
      const prefix = SURFACE_PREFIX[surface].slice(1);
      return [
        { path: prefix, element: <SurfaceElsewhere surface={surface} /> },
        { path: `${prefix}/*`, element: <SurfaceElsewhere surface={surface} /> },
      ];
    });
}

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
        ],
      },

      // ── Authenticated ─────────────────────────────────────────────────
      {
        element: <RequireAuth />,
        children: [
          ...surfaceRoutes('admin', {
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
                      {
                        // M5.4 — the office end of the portal’s only
                        // post-allocation channel. See the screen.
                        path: 'queues/change-requests',
                        element: load(<QueueChangeRequestsPage />),
                      },
                      { path: 'queues/po-review', element: load(<QueuePoReviewPage />) },
                      { path: 'queues/call-ups', element: load(<QueueCallUpsPage />) },
                      {
                        path: 'queues/call-up-review',
                        element: load(<QueueCallUpReviewPage />),
                      },
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
                      // Before the :leadId route. React Router ranks a static
                      // segment above a dynamic one regardless of order, so this
                      // is for the human reader rather than the matcher — but a
                      // lead whose id is literally "new" is the kind of thing
                      // that only ever gets discovered in production.
                      { path: 'queues/leads/new', element: load(<QueueLeadCreatePage />) },
                      { path: 'queues/leads/:leadId', element: load(<QueueLeadDetailPage />) },
                    ],
                  },

                  // Commercial
                  {
                    element: <RequireCapability capability="accounts:manage" />,
                    children: [
                      { path: 'customers', element: load(<CustomersPage />) },
                      /*
                        Before the :customerId route, or "new" is read as an id.
                        Matt, 6:10 — an account can be created without a lead.
                      */
                      { path: 'customers/new', element: load(<CustomerCreatePage />) },
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
                    // The narrower grant opens the screen; the page narrows what
                    // it shows for anyone who lacks full `users:manage`.
                    element: <RequireCapability capability="users:manage-customers" />,
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
                    element: <RequireCapability capability="extractor:use" />,
                    children: [{ path: 'extractor', element: load(<ExtractorPage />) }],
                  },
                  {
                    /*
                     * I1 · M7.8 — gated on `integrations:manage`, which is the
                     * Administrator's alone. Deliberately NOT `settings:manage`:
                     * connecting Xero binds the company's invoicing to a set of
                     * accounting books, which is a different decision from
                     * changing a platform setting.
                     */
                    element: <RequireCapability capability="integrations:manage" />,
                    children: [{ path: 'xero', element: load(<XeroPage />) }],
                  },
                  {
                    element: <RequireCapability capability="settings:manage" />,
                    children: [{ path: 'settings', element: load(<SettingsPage />) }],
                  },
                ],
              },
            ],
          }),

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
          ...surfaceRoutes('portal', {
            path: 'portal',
            element: <RequireCapability capability="portal:access" onDenied="redirect" />,
            children: [
              {
                element: <PortalLayout />,
                children: [
                  { index: true, element: load(<PortalDashboardPage />) },

                  // Pickups — both customer roles.
                  /*
                    Journey A.4 — outside the capability guards on purpose.
                    An account waiting on its terms has to be able to reach the
                    one screen that lifts that wait; gating it behind the same
                    checks as the rest of the portal would lock the customer out
                    of the only door available to them.
                  */
                  { path: 'welcome', element: load(<PortalWelcomePage />) },
                  { path: 'jobs', element: load(<PortalJobsPage />) },
                  /*
                   * M2.12b — deliberately NOT behind `portal:book`. A site
                   * supervisor must be able to give us a date for an order we
                   * already hold (Matt, 30:40); the booking capability is about
                   * raising work that has no order behind it.
                   */
                  {
                    path: 'purchase-orders',
                    element: load(<PortalPurchaseOrdersPage />),
                  },
                  { path: 'jobs/:jobId', element: load(<PortalJobDetailPage />) },
                  { path: 'jobs/:jobId/edit', element: load(<PortalJobEditPage />) },

                  {
                    element: <RequireCapability capability="portal:book" />,
                    children: [{ path: 'book', element: load(<PortalBookPage />) }],
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
                    /*
                     * Two gates, because two different things can refuse this
                     * screen: the ROLE (a site supervisor does not manage other
                     * supervisors) and the ACCOUNT TYPE (a contractor has none —
                     * Matt, 21:55). The nav hides the item for a contractor;
                     * hiding is not preventing, so the type is checked here too,
                     * and again on the server, which is the actual boundary.
                     */
                    element: <RequireCapability capability="portal:supervisors" />,
                    children: [
                      {
                        element: <RequireBuilderAccount />,
                        children: [
                          { path: 'supervisors', element: load(<PortalSupervisorsPage />) },
                        ],
                      },
                    ],
                  },
                  {
                    element: <RequireCapability capability="portal:account" />,
                    children: [{ path: 'account', element: load(<PortalAccountPage />) }],
                  },
                  {
                    /*
                     * M8.1 / M8.2 — the customer's updates. Gated on the same
                     * capability as the bell that links to it, so a role that
                     * cannot see the bell cannot reach the screen either.
                     */
                    element: <RequireCapability capability="notifications:read" />,
                    children: [
                      { path: 'notifications', element: load(<PortalNotificationsPage />) },
                    ],
                  },
                ],
              },
            ],
          }),

          /*
           * The driver app (M4).
           *
           * ── One capability for the whole surface, and why that is right ──
           * The console and the portal gate screen groups individually because
           * roles differ within them. The driver surface has one role who does
           * all of it; what varies is which RUN they are given, and that is
           * server-side data scoping, not a browser permission. So the boundary
           * is guarded once, here, and nothing inside needs a second check.
           *
           * `onDenied="redirect"` because reaching `/driver` as an office user
           * means being in the wrong application, not lacking a permission —
           * the same judgement `/admin` and `/portal` already make.
           *
           * ⚠️ `DriverShell` is EAGER while its pages are lazy. On a phone with
           * no signal the shell is what proves the app is alive; putting a
           * suspense fallback in front of the header and its sync badge would
           * mean a driver opening the app offline sees a blank screen first.
           */
          ...surfaceRoutes('driver', {
            path: 'driver',
            element: <RequireCapability capability="driver:access" onDenied="redirect" />,
            children: [
              {
                element: <DriverShell />,
                children: [
                  { index: true, element: load(<DriverRunSheetPage />) },

                  // M4.8a — before the run, and it blocks it.
                  { path: 'pre-start', element: load(<DriverPreStartPage />) },

                  // M4.1, M4.2 — the job, and the single next action on it.
                  { path: 'jobs/:jobId', element: load(<DriverJobDetailPage />) },
                  { path: 'jobs/:jobId/navigate', element: load(<DriverNavigatePage />) },
                  { path: 'jobs/:jobId/photos', element: load(<DriverJobPhotosPage />) },
                  { path: 'jobs/:jobId/weights', element: load(<DriverJobWeightsPage />) },
                  { path: 'jobs/:jobId/futile', element: load(<DriverJobFutilePage />) },
                  {
                    path: 'jobs/:jobId/contamination',
                    element: load(<DriverJobContaminationPage />),
                  },
                  {
                    path: 'jobs/:jobId/risk-assessment',
                    element: load(<DriverJobRiskAssessmentPage />),
                  },

                  // M4.4 — end of run.
                  { path: 'tip-off', element: load(<DriverTipOffPage />) },

                  // M4.9 — the truck itself.
                  { path: 'report', element: load(<DriverReportDefectPage />) },

                  // M4.12 — the queue, and the driver's own details.
                ],
              },
            ],
          }),
        ],
      },

      // ── Surfaces this build does not serve ────────────────────────────
      // Before the catch-all, or `*` would answer "not found" to a link that
      // has a perfectly good home on another origin.
      ...elsewhereRoutes(),

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
