import { useEffect } from 'react';
import { Navigate } from 'react-router';
import { FullPageLoader } from '@/components/full-page-loader';
import { driverAppHref } from '@/config/driver-origin';
import { useAuth } from '@/features/auth/auth-context';
import { landingPathFor } from '@/features/auth/permissions';

/**
 * `/` — role-based landing.
 *
 * This is the replacement the scaffold's `pages/landing.tsx` asked for: office
 * and admin roles land on the console, customer roles on the portal, and a
 * signed-out visitor goes to sign-in. Nobody chooses their surface from a menu;
 * their role already decided it (§6A.5).
 */
export function RootRedirect() {
  const { status, user } = useAuth();

  /*
   * A driver-only user belongs on the driver origin (Matt, 29:04).
   *
   * Only when `driver` is their ONLY role. Someone who also allocates — Matt's
   * driver manager, 27:01 — has business on both surfaces and uses the role
   * switcher, so bouncing them off this one would trap them on the wrong app.
   *
   * A full page load rather than a route change, because it is a different
   * origin. Done in an effect so React is not asked to render during a
   * navigation it cannot see the end of.
   */
  const driverOnly = user?.roles.length === 1 && user.role === 'driver';
  const driverHref = driverOnly ? driverAppHref('/') : null;

  useEffect(() => {
    if (driverHref !== null) window.location.replace(driverHref);
  }, [driverHref]);

  if (status === 'loading') return <FullPageLoader />;
  if (!user) return <Navigate to="/auth/sign-in" replace />;
  // Held on the loader while the browser leaves for the driver origin.
  if (driverHref !== null) return <FullPageLoader />;

  return <Navigate to={landingPathFor(user.role)} replace />;
}
