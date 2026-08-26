import { createBrowserRouter } from 'react-router';
import { RequireAuth } from '@/features/auth/require-auth';
import { AuthLayout, DriverLayout } from '@/layouts/driver-layout';
import { JobContaminationPage } from '@/pages/job-contamination';
import { JobDetailPage } from '@/pages/job-detail';
import { JobFutilePage } from '@/pages/job-futile';
import { JobPhotosPage } from '@/pages/job-photos';
import { JobRiskAssessmentPage } from '@/pages/job-risk-assessment';
import { JobWeightsPage } from '@/pages/job-weights';
import { MePage } from '@/pages/me';
import { PreStartPage } from '@/pages/pre-start';
import { ReportDefectPage } from '@/pages/report-defect';
import { RunSheetPage } from '@/pages/run-sheet';
import { SignInPage } from '@/pages/sign-in';
import { TipOffPage } from '@/pages/tip-off';
import { RouteError } from './route-error';

/**
 * The driver app's routes (M4).
 *
 * ── Nothing is lazily loaded here, and that is deliberate ─────────────────
 * The web app code-splits by nav group because an office user on a desk
 * connection can afford a chunk fetch mid-navigation. A driver cannot: they may
 * open the futile screen for the first time standing in a greenfield estate with
 * no coverage, and a lazily-loaded route that has never been fetched is a blank
 * screen at the exact moment the app is supposed to prove itself.
 *
 * So the whole app ships in the shell the service worker pre-caches. It is small
 * — ten screens with no charts and no data grid — and "works with no signal"
 * (M4.12) means every screen, not the ones you happened to visit first.
 *
 * ── Every route is a two-place change ─────────────────────────────────────
 * Here, and in Flutter (§6A.4). The route names are part of that shared
 * understanding, which is why they mirror the domain rather than the components.
 */
export const router = createBrowserRouter([
  {
    path: '/',
    errorElement: <RouteError />,
    children: [
      {
        element: <AuthLayout />,
        children: [{ path: 'sign-in', element: <SignInPage /> }],
      },

      {
        element: <RequireAuth />,
        children: [
          {
            element: <DriverLayout />,
            children: [
              { index: true, element: <RunSheetPage /> },

              // M4.8a — before the run, and it blocks it.
              { path: 'pre-start', element: <PreStartPage /> },

              // M4.1, M4.2 — the job, and the single next action on it.
              { path: 'jobs/:jobId', element: <JobDetailPage /> },
              { path: 'jobs/:jobId/photos', element: <JobPhotosPage /> },
              { path: 'jobs/:jobId/weights', element: <JobWeightsPage /> },
              { path: 'jobs/:jobId/futile', element: <JobFutilePage /> },
              { path: 'jobs/:jobId/contamination', element: <JobContaminationPage /> },
              { path: 'jobs/:jobId/risk-assessment', element: <JobRiskAssessmentPage /> },

              // M4.4 — end of run.
              { path: 'tip-off', element: <TipOffPage /> },

              // M4.9 — the truck itself.
              { path: 'report', element: <ReportDefectPage /> },

              // M4.12 — the queue, and the driver's own details.
              { path: 'me', element: <MePage /> },
            ],
          },
        ],
      },
    ],
  },
]);
