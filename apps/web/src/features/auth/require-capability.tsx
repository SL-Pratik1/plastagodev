import { Navigate, Outlet } from 'react-router';
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

  if (!user) return <Navigate to="/auth/sign-in" replace />;

  if (!can(capability)) {
    return onDenied === 'redirect' ? (
      <Navigate to={landingPathFor(user.role)} replace />
    ) : (
      <Navigate to="/forbidden" replace state={{ capability }} />
    );
  }

  return <Outlet />;
}
