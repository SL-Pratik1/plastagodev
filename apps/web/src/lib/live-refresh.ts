/**
 * Query options for an office view of what drivers are changing right now.
 *
 * Matt (21 Oct): the phone said "Completed" and the job page still said "On
 * site". The server had the completion; the page had read the job once, and
 * nothing — no push, no focus refetch — ever asked again. A page left open now
 * re-reads every 20 seconds, and again when the tab comes back into view.
 * React Query pauses the interval while the tab is hidden, so a forgotten tab
 * costs nothing.
 */
export const LIVE_REFRESH = {
  refetchInterval: 20_000,
  refetchOnWindowFocus: true,
} as const;
