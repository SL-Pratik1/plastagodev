import { useMemo, useRef } from 'react';

/**
 * Asks for freshly signed photo URLs when a tile fails to load — at most once
 * a minute.
 *
 * ── Why a refresh at all ──────────────────────────────────────────────────
 * Photo URLs are signed for fifteen minutes, and the screens that show them
 * stay open far longer. A tile whose link has expired can only be healed by a
 * fresh read of the record, which signs new links.
 *
 * ── Why a cap ─────────────────────────────────────────────────────────────
 * A tile can also fail for reasons a fresh read does not cure — the object is
 * missing from the bucket, the bucket host is blocked, the file will not
 * decode. Every read signs a NEW link, the tile remounts on it, fails again and
 * asks again, so without a cap the screen re-fetched the record and
 * re-downloaded every photo in a loop for as long as it was open. One refresh a
 * minute still heals the expired case at once, and turns the others into a
 * quiet placeholder.
 */
export function useStaleUrlRefresh(
  refetch: (() => unknown) | undefined,
  minIntervalMs = 60_000,
): (() => void) | undefined {
  const lastAt = useRef<number | null>(null);

  return useMemo(() => {
    if (refetch === undefined) return undefined;

    return () => {
      const now = Date.now();
      if (lastAt.current !== null && now - lastAt.current < minIntervalMs) return;
      lastAt.current = now;
      void refetch();
    };
  }, [refetch, minIntervalMs]);
}
