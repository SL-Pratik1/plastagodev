import { useEffect } from 'react';
import { Navigate, Outlet } from 'react-router';
import { FullPageLoader } from '@/components/full-page-loader';
import { leaveForSurface, roleSurfaceHref } from '@/config/surfaces';
import { useAuth } from './auth-context';
import { landingPathFor, type Capability } from './permissions';

export interface RequireCapabilityProps {
  capability: Capability;
  /**
   * `redirect` sends the user to their own landing page — right for a surface
   * boundary, where they are simply in the wrong application. `deny` renders a
   * 403 — right for a screen inside a surface they do belong in, where silently
   * moving them is confusing.
   */
  onDenied?: 'redirect' | 'deny';
}

/**
 * Role gate, expressed as a capability (see `permissions.ts` for why).
 *
 * Nested inside `<RequireAuth>` so it can assume a user exists; if it somehow
 * renders without one, it fails closed rather than open.
 */
export function RequireCapability({ capability, onDenied = 'deny' }: RequireCapabilityProps) {
  const { user, can } = useAuth();

  /*
   * "Their own landing page" can now be on another origin, and a router
   * redirect cannot cross one. Resolved up here rather than at the point of
   * use because the effect that performs the crossing is a hook, and hooks
   * cannot sit behind the early returns below.
   *
   * `leaveFor` is null in every case that is not a cross-origin bounce —
   * denied-with-a-403, a surface this build already serves, and single-server
   * mode — so the paths below are the ones this component always had.
   */
  const denied = user !== null && !can(capability);
  const leaveFor =
    user !== null && denied && onDenied === 'redirect'
      ? roleSurfaceHref(user.role, landingPathFor(user.role))
      : null;

  useEffect(() => {
    if (leaveFor !== null) leaveForSurface(leaveFor);
  }, [leaveFor]);

  if (!user) return <Navigate to="/auth/sign-in" replace />;

  if (denied) {
    if (onDenied !== 'redirect') return <Navigate to="/forbidden" replace state={{ capability }} />;
    // Held on the loader while the browser leaves for their own surface.
    return leaveFor !== null ? (
      <FullPageLoader />
    ) : (
      <Navigate to={landingPathFor(user.role)} replace />
    );
  }

  return <Outlet />;
}
