import { hasSiteSupervisors } from '@plastago/shared';
import { Navigate, Outlet } from 'react-router';
import { PageSkeleton } from '@/components/page-skeleton';
import { usePortalScope } from './queries';

/**
 * A portal screen that exists only for a BUILDER account.
 *
 * ── Why a second guard beside the capability one ──────────────────────────
 * `RequireCapability` answers "may this ROLE open this screen". Builder or
 * contractor is not a role — it is a property of the ACCOUNT (Matt, 21:55), and
 * the two are independent: a contractor's administrator holds
 * `portal:supervisors` exactly like a builder's, because the capability follows
 * the role.
 *
 * Site supervisors are a builder concept, so the nav already hides the item for
 * a contractor. Hiding is not preventing: `/portal/supervisors` typed into the
 * address bar rendered the working screen, and only the API refusal that now sits
 * behind it stopped anything being created. This turns that refusal into the
 * normal "not allowed" page rather than a screen that loads and then errors on
 * every query.
 *
 * ⚠️ Still not the boundary. `assertBuilderAdministrator` on the server is —
 * this is what the customer SEES.
 */
export function RequireBuilderAccount() {
  const scope = usePortalScope();

  /*
   * The scope arrives a moment after the shell. Rendering the skeleton rather
   * than guessing keeps a builder from being bounced to /forbidden on a slow
   * connection — the same failure direction the nav takes, where a type-gated
   * item stays hidden until the answer is known.
   */
  if (scope.isPending) return <PageSkeleton />;

  if (!scope.data || !hasSiteSupervisors(scope.data.accountType)) {
    return <Navigate to="/forbidden" replace state={{ reason: 'builder-accounts-only' }} />;
  }

  return <Outlet />;
}
