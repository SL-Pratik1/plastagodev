import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { useServices } from '@/services/services-context';

/**
 * The Extractor tab's session (I6).
 *
 * ── Why a query and not a mutation, when the endpoint is a POST ───────────
 * Because from the page's point of view this is a resource it needs in order to
 * render, and React Query's loading and error states are exactly what the tab
 * has to show while it waits. The POST is an implementation detail of the
 * broker — it creates a session at a third party — not a user action.
 *
 * The cost of that choice is that a query is refetchable, so the settings below
 * exist to stop it refetching when a refetch would be pointless or harmful.
 */

/**
 * How long before expiry the session is treated as spent.
 *
 * Ten minutes, wider than the server's own five-minute reuse margin. The server
 * decides whether to hand back a cached row; this decides whether a tab that
 * has been open for a day should get a new one. Being the wider of the two
 * means the client asks before the server would refuse.
 */
const RENEW_WITHIN_MS = 10 * 60_000;

export function useExtractorSession() {
  const { extractor } = useServices();

  return useQuery({
    queryKey: queryKeys.extractor.session(),
    queryFn: () => extractor.createSession(),

    /*
     * Stale as soon as it is close to expiring, and fresh until then.
     *
     * A fixed `staleTime` would either re-mint a good session on every mount or
     * hold a dead one for a day. This asks the data itself.
     */
    staleTime: (query) => {
      const expiresAt = query.state.data?.expiresAt;
      if (!expiresAt) return 0;

      const remaining = Date.parse(expiresAt) - Date.now() - RENEW_WITHIN_MS;
      return remaining > 0 ? remaining : 0;
    },

    /*
     * ⚠️ Retries are off.
     *
     * Every failure this endpoint produces is one a retry cannot fix: a user
     * with no email address, a role the extractor refuses, or a vendor that is
     * down. Retrying three times turns each of those into a fifteen-second wait
     * before the same message appears, and the screen offers an explicit Retry
     * for the case where trying again is genuinely worth it.
     */
    retry: false,

    /* Re-minting on every window focus would hammer a third party all day. */
    refetchOnWindowFocus: false,
  });
}

/**
 * Clears the cached session, server-side and here, then mints a fresh one.
 *
 * The recovery path for "Invalid session" *inside* the iframe — which the page
 * cannot detect, because a cross-origin frame does not report its own errors.
 * So this is a button, not an automatic reaction.
 */
export function useExtractorSessionReset() {
  const { extractor } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => extractor.forgetSession(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.extractor.session() }),
  });
}
