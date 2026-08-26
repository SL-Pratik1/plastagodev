import { Navigate } from 'react-router';
import { FullPageLoader } from '@/components/full-page-loader';
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

  if (status === 'loading') return <FullPageLoader />;
  if (!user) return <Navigate to="/auth/sign-in" replace />;

  return <Navigate to={landingPathFor(user.role)} replace />;
}
