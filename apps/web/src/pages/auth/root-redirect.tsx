import { useEffect } from 'react';
import { Navigate } from 'react-router';
import { FullPageLoader } from '@/components/full-page-loader';
import { leaveForSurface, roleSurfaceHref } from '@/config/surfaces';
import { useAuth } from '@/features/auth/auth-context';
import { landingPathFor } from '@/features/auth/permissions';

/**
 * `/` — role-based landing.
 *
 * This is the replacement the scaffold's `pages/landing.tsx` asked for: office
 * and admin roles land on the console, customer roles on the portal, drivers on
 * their run sheet, and a signed-out visitor goes to sign-in. Nobody chooses
 * their surface from a menu; their role already decided it (§6A.5).
 *
 * ── When the right surface is somewhere else ──────────────────────────────
 * Each surface has its own origin (`config/surfaces.ts`), so "go to your
 * landing page" is sometimes a page load and not a route change. Only
 * sometimes: `roleSurfaceHref` returns null when this build already serves the
 * role's surface, and in single-server mode it always does.
 *
 * ⚠️ Keyed on the role the user is ACTING AS, not on holding a single role.
 * Matt's driver manager (27:01) allocates and drives, and the shell's role
 * switcher is what moves them between the two — bouncing on "has the driver
 * role" would have trapped them on whichever surface they landed on first.
 */
export function RootRedirect() {
  const { status, user } = useAuth();

  /*
   * In an effect, so React is not asked to render through a navigation whose
   * end it cannot see.
   */
  const elsewhere = user ? roleSurfaceHref(user.role, landingPathFor(user.role)) : null;

  useEffect(() => {
    if (elsewhere !== null) leaveForSurface(elsewhere);
  }, [elsewhere]);

  if (status === 'loading') return <FullPageLoader />;
  if (!user) return <Navigate to="/auth/sign-in" replace />;
  // Held on the loader while the browser leaves for the other origin.
  if (elsewhere !== null) return <FullPageLoader />;

  return <Navigate to={landingPathFor(user.role)} replace />;
}
