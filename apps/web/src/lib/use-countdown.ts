import { useEffect, useState } from 'react';
import { secondsUntil } from './format';

/**
 * Seconds remaining until an ISO instant, re-rendering once a second and
 * stopping at zero.
 *
 * Used for the OTP expiry and the resend cooldown. Both need to be *visible*:
 * a disabled "Resend" button with no countdown reads as broken, and a code that
 * silently expires makes the user think they typed it wrong.
 *
 * ── Why a tick counter instead of storing the seconds ──────────────────────
 * The remaining time is not state — it is a function of `until` and the clock.
 * Storing it means keeping two things in sync, and the resync has to happen the
 * moment `until` changes (a resend issues a new expiry), which lands you calling
 * setState inside an effect body and cascading a render.
 *
 * So state holds only a tick, incremented from the interval callback, and the
 * value is derived during render. A new `until` is reflected on the very next
 * render rather than up to a second later, and the interval clears itself once
 * the countdown reaches zero instead of ticking behind an idle screen.
 */
export function useCountdown(until: string | null | undefined): number {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!until) return;
    if (secondsUntil(until) <= 0) return;

    const timer = setInterval(() => {
      setTick((current) => current + 1);
      if (secondsUntil(until) <= 0) clearInterval(timer);
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, [until]);

  return secondsUntil(until);
}

/** `4:32` for a minutes-and-seconds countdown, `0:07` near the end. */
export function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes)}:${String(rest).padStart(2, '0')}`;
}
