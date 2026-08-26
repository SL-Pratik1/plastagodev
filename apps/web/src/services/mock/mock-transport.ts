/**
 * Shared behaviour for the mock adapters.
 *
 * The latency is not decoration. A mock that resolves synchronously means every
 * skeleton, spinner and disabled-button state is dead code that nobody sees
 * until the real API is slow — and by then the loading states are wrong. A
 * deliberate delay keeps them exercised on every click.
 */

/** Roughly a healthy same-region request, with enough jitter to look real. */
export function latency(base = 320, jitter = 180): Promise<void> {
  const ms = base + Math.random() * jitter;
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Session persistence for the mock.
 *
 * Real web auth is a short-lived JWT in an httpOnly cookie (§6A.1), so the
 * browser will never be able to read it — which is exactly why this is confined
 * to the mock adapter. The app itself only ever calls `authService.getSession()`
 * and cannot tell the difference.
 *
 * Every access is guarded: `localStorage` throws outright in a browser with site
 * data blocked, and returns nothing in a fresh private window.
 */
const SESSION_KEY = 'plastago.mock.session';

export function readStored<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A demo in a locked-down browser degrades to "signed out on refresh",
    // which is survivable. Failing the sign-in would not be.
  }
}

export function clearStored(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing useful to do — see above.
  }
}

export const MOCK_SESSION_KEY = SESSION_KEY;

/** Hide most of an email or mobile, leaving enough to recognise it (§9). */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const head = local.slice(0, 1);
  return `${head}${'•'.repeat(Math.max(2, local.length - 1))}@${domain}`;
}

export function maskMobile(mobile: string): string {
  return `•••• ••• ${mobile.slice(-3)}`;
}
