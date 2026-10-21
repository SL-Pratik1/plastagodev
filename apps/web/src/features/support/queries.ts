import { useQuery } from '@tanstack/react-query';
import { useCurrentUser } from '@/features/auth/auth-context';
import { queryKeys } from '@/lib/query-keys';
import { useServices } from '@/services/services-context';

/**
 * Ask for a fresh session this long before the current one expires.
 *
 * Wider than the server's five-minute reuse margin, so the browser asks before
 * the server would refuse. The server extends rather than replaces a live
 * session, so the id normally comes back unchanged and the widget is not
 * touched — this exists for the tab that has been open all day.
 */
const RENEW_WITHIN_MS = 10 * 60_000;

/**
 * The support bubble's session for whoever is signed in.
 *
 * ── `gcTime: 0` is the sign-out rule ──────────────────────────────────────
 * The widget mounts with the shell and unmounts with it, so dropping the data
 * the moment nothing observes it means a sign-out takes the session id with
 * it. Without this, signing out and back in without a reload would boot the
 * widget from a cached id the server has just revoked.
 *
 * ── `retry: false` ────────────────────────────────────────────────────────
 * The server already turns its own failures into `enabled: false`. A rejected
 * promise means the API itself is unreachable, and the screen has bigger news
 * than a missing bubble.
 */
export function useSupportSession() {
  const user = useCurrentUser();
  const { support } = useServices();

  return useQuery({
    queryKey: queryKeys.support.session(user.id, user.role),
    queryFn: () => support.session(),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data?.enabled) return false;

      const due = Date.parse(data.expiresAt) - Date.now() - RENEW_WITHIN_MS;
      // Never a tight loop: a clock that disagrees with Sortd's waits a minute.
      return Math.max(due, 60_000);
    },
  });
}
