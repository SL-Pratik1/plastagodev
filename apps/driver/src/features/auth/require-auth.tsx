import { Spinner } from '@plastago/ui';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from './auth-context';

/**
 * Gate for everything except sign-in.
 *
 * Sends the driver back to where they were trying to go after signing in, which
 * matters here more than in the office: a push notification (M4.11) deep-links
 * into a job, and losing that destination means finding it again by hand on a
 * phone, on site.
 */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner label="Loading your run" />
      </div>
    );
  }

  if (status === 'anonymous') {
    return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}
