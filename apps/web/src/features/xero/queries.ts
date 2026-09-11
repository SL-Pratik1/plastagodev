import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { useServices } from '@/services/services-context';

/**
 * The Xero connection (I1 · M7.8).
 *
 * ── Why the status is polled at all ───────────────────────────────────────
 * A Xero connection can stop working without anybody touching PlastaGo: the
 * grant is revoked from inside Xero, or the sixty-day refresh window lapses.
 * A page that only ever reads on mount would keep showing "Connected" to
 * somebody looking at it precisely because they suspect it is not.
 *
 * Polling is slow — a minute — because the state changes on the order of
 * days and the page is usually left open on a second monitor.
 */
const POLL_MS = 60_000;

export function useXeroStatus() {
  const { xero } = useServices();

  return useQuery({
    queryKey: queryKeys.xero.status(),
    queryFn: () => xero.status(),
    refetchInterval: POLL_MS,
    /*
     * The most valuable refetch of all: somebody who has just come back from
     * the Xero consent screen in another tab, or who has switched away to
     * revoke the grant and switched back to check.
     */
    refetchOnWindowFocus: true,
  });
}

/**
 * Starts the handshake, then navigates the whole window to Xero.
 *
 * ── Why `window.location.assign` and not a fetch-follow or a popup ────────
 * Xero's consent screen is a full third-party login. It cannot render inside
 * an XHR response, and a popup is blocked in exactly the case that matters —
 * an administrator clicking Connect for the first time, on a browser with
 * default settings. Replacing the window is what actually works, and it is
 * also what a user expects when they are about to be asked for a password
 * belonging to somebody other than us.
 *
 * The URL is pinned to `login.xero.com` in the service layer, so this cannot
 * become an open redirect.
 */
export function useConnectXero() {
  const { xero } = useServices();

  return useMutation({
    mutationFn: () => xero.beginConnect(),
    onSuccess: ({ authorizeUrl }) => {
      window.location.assign(authorizeUrl);
    },
  });
}

export function useDisconnectXero() {
  const { xero } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => xero.disconnect(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.xero.all });
    },
  });
}
