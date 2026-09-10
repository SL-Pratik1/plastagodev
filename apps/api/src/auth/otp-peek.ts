import { revealOtpCode } from '../config/env.js';

/**
 * Hands the code just issued back to the sign-in response, for shared
 * environments where nobody can read the server log.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * On staging, `MAIL_PROVIDER`/`SMS_PROVIDER` are `stub`: the code is printed to
 * the log and never sent. That is fine for whoever owns the deployment and
 * useless for a client developer working against it, who then cannot sign in at
 * all without dashboard access to somebody else's hosting account.
 *
 * ⚠️ While this is on, the code is NOT a second factor. Anyone who can name an
 * identifier can sign in as that person. That is why `revealOtpCode` is forced
 * off in production (see env.ts) rather than merely defaulting to off — a
 * misconfigured variable must not be able to open the front door.
 *
 * Kept in memory, never persisted: writing it down would recreate the plain-text
 * storage problem that `storeOTP: 'hashed'` exists to avoid.
 */
const issued = new Map<string, string>();

/** Called from the Better Auth send callbacks, which see the plain code. */
export function rememberOtpCode(identifier: string, code: string): void {
  if (!revealOtpCode) return;
  issued.set(identifier, code);
}

/**
 * Reads and clears the code for one identifier.
 *
 * Single use, so a code cannot be re-read after the response that carried it —
 * the window stays as short as the feature allows.
 */
export function takeOtpCode(identifier: string): string | null {
  if (!revealOtpCode) return null;
  const code = issued.get(identifier) ?? null;
  issued.delete(identifier);
  return code;
}

/** Test seam — the map is process-wide and would otherwise leak between cases. */
export function clearOtpCodes(): void {
  issued.clear();
}
