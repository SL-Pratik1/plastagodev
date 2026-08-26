import { useEffect, useState } from 'react';

/**
 * The current time, as state rather than a call.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * `Date.now()` in a render body is an impure read: two renders of the same props
 * produce different output, which breaks the assumption the React Compiler
 * memoises on — and it means a "3 days old" badge silently goes stale, because
 * nothing re-renders when the clock moves.
 *
 * Reading the clock into state on an interval fixes both. Render stays pure, and
 * an ageing badge on a screen left open all day actually ages.
 *
 * The default interval is a minute: everything this drives is measured in hours
 * or days, so a faster tick would be wasted renders. Pass a shorter one only for
 * something genuinely second-by-second.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);

    return () => {
      clearInterval(timer);
    };
  }, [intervalMs]);

  return now;
}
