import { Navigate, Outlet, useLocation } from 'react-router';
import { FullPageLoader } from '@/components/full-page-loader';
import { useAuth } from './auth-context';

/**
 * Gate for every authenticated route group.
 *
 * Applied at the ROUTE GROUP, never inside a page — as `app/router.tsx` has
 * instructed since the scaffold. One place to audit, and impossible for a new
 * screen to forget: a page added under `/admin` is protected by existing.
 *
 * The `from` location is carried through so a deep link survives sign-in. A
 * supervisor who taps a link to a specific job in an email, signs in, and lands
 * on a dashboard instead has been made to do the navigation twice.
 */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <FullPageLoader label="Checking your session" />;
  }

  if (status === 'anonymous') {
    return (
      <Navigate
        to="/auth/sign-in"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }

  return <Outlet />;
}
