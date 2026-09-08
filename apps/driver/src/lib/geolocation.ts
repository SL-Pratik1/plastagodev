/**
 * A position fix for the driver app (M4.2).
 *
 * ── Why this lives in `lib/` and not in a service ─────────────────────────
 * It talks to the browser, not to the server, so it is the same code whether
 * the data layer is a mock or the real API. It lived in the mock service while that was
 * the only driver implementation; it moved here when the mocks were deleted,
 * unchanged.
 */

/**
 * How long the app is prepared to wait before acting without coordinates.
 *
 * Two and a half seconds. Long enough for a warm fix, short enough that a driver
 * tapping "Complete" is never left wondering whether the tap registered.
 */
const POSITION_TIMEOUT_MS = 2_500;

export interface PositionFix {
  latitude: number;
  longitude: number;
  accuracyMetres: number | null;
}

/**
 * A position fix, or null.
 *
 * ── This must never block, and the browser's own timeout is not enough ─────
 * M4.2 wants a position on every status change, but "wants" is not "requires":
 * losing the *action* because the GPS was slow is far worse than losing the
 * coordinates. A driver in a basement car park, or one who denied location,
 * still has to be able to mark a job complete.
 *
 * ⚠️ The `timeout` option covers *acquiring* a fix — it does NOT cover the
 * permission prompt. Where permission has never been granted or the prompt is
 * sitting behind the app, neither callback fires and the promise never settles.
 * That is not theoretical: it made every driver action hang silently with no
 * error, no toast and no navigation, which is the worst possible failure on the
 * button that finishes a job.
 *
 * So the race below is the actual guarantee. `Promise.race` against a timer
 * means this settles within `POSITION_TIMEOUT_MS` no matter what the
 * geolocation implementation does.
 */
export function currentPosition(): Promise<PositionFix | null> {
  if (!('geolocation' in navigator)) return Promise.resolve(null);

  const fix = new Promise<PositionFix | null>((resolve) => {
    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            latitude: Number(position.coords.latitude.toFixed(6)),
            longitude: Number(position.coords.longitude.toFixed(6)),
            accuracyMetres:
              position.coords.accuracy === null ? null : Math.round(position.coords.accuracy),
          });
        },
        () => {
          resolve(null);
        },
        { enableHighAccuracy: true, timeout: POSITION_TIMEOUT_MS, maximumAge: 30_000 },
      );
    } catch {
      // Some embedded browsers throw synchronously on a blocked API.
      resolve(null);
    }
  });

  const giveUp = new Promise<null>((resolve) => {
    window.setTimeout(() => {
      resolve(null);
    }, POSITION_TIMEOUT_MS);
  });

  return Promise.race([fix, giveUp]);
}

/** Today, as the business reckons it. The driver app's run sheet is a day. */
export function todayInSydney(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}
