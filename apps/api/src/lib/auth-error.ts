import type { ErrorCode, FieldIssue } from '@plastago/shared';
import { AppError } from './app-error.js';

/**
 * Sign-in failures, as the SCREEN needs to distinguish them.
 *
 * ── Why these are carried in `issues` and not in `error.code` ───────────────
 * `ErrorCodeSchema` in `@plastago/shared` is a closed union of nine transport
 * codes — `CONFLICT`, `NOT_FOUND`, `RATE_LIMITED` and so on. It has no member
 * for "the code was right but it expired", and adding one would edit the frozen
 * contract that the Flutter app pins (§6A.9).
 *
 * But the sign-in screen genuinely must tell these apart: `auth-messages.ts`
 * has different copy for an expired code ("send a new one"), a wrong one ("2
 * attempts left") and a burned challenge ("start again") — and showing the
 * wrong one of those three leaves the user stuck.
 *
 * So the transport code stays honest about the CLASS of failure, and the exact
 * reason travels as a field issue at the reserved path below. That is a legal
 * `ApiError` — `FieldIssue` is `{ path, message }` and nothing more — so no
 * schema moves, and `ApiRequestError.fieldErrors` already surfaces it to the
 * client for free.
 *
 * ⚠️ If the contract is ever reopened, these seven belong in `ErrorCodeSchema`
 * directly and this indirection should be deleted. It is a consequence of the
 * freeze, not a design preference. The web adapter reads the reserved path in
 * exactly one place, so that change is small on both sides.
 */
export const AUTH_REASONS = [
  'IDENTIFIER_UNKNOWN',
  'ACCOUNT_SUSPENDED',
  'CHALLENGE_NOT_FOUND',
  'CODE_INCORRECT',
  'CODE_EXPIRED',
  'CODE_ATTEMPTS_EXCEEDED',
  'RESEND_TOO_SOON',
] as const;

export type AuthReason = (typeof AUTH_REASONS)[number];

/**
 * The reserved `FieldIssue.path` that carries the reason.
 *
 * Not a real field on any form, which is why it is safe: react-hook-form maps
 * field errors by name, and no input is called this.
 */
export const AUTH_REASON_PATH = 'authReason';

/**
 * How each reason presents on the wire.
 *
 * The status is what a proxy, a log aggregator and a browser devtools panel see,
 * so it has to be defensible on its own: a wrong code is a failed
 * authentication (401), a spent challenge is gone (404), and both throttles are
 * 429 because that is what they are.
 */
const WIRE: Record<AuthReason, { status: number; code: ErrorCode }> = {
  IDENTIFIER_UNKNOWN: { status: 404, code: 'NOT_FOUND' },
  ACCOUNT_SUSPENDED: { status: 403, code: 'FORBIDDEN' },
  CHALLENGE_NOT_FOUND: { status: 404, code: 'NOT_FOUND' },
  CODE_INCORRECT: { status: 401, code: 'UNAUTHENTICATED' },
  CODE_EXPIRED: { status: 401, code: 'UNAUTHENTICATED' },
  CODE_ATTEMPTS_EXCEEDED: { status: 429, code: 'RATE_LIMITED' },
  RESEND_TOO_SOON: { status: 429, code: 'RATE_LIMITED' },
};

/**
 * Raise a sign-in failure.
 *
 * `details` becomes extra field issues, which reach the browser as
 * `ApiRequestError.fieldErrors`. The one the UI actually consumes today is
 * `attemptsRemaining` — `auth-messages.ts` reads it to warn before the last
 * attempt is spent, so it must be sent with every `CODE_INCORRECT`.
 *
 * @param message Safe to display, but the UI resolves its own copy from the
 *                reason. This is what lands in the server log.
 */
export function authError(
  reason: AuthReason,
  message: string,
  details?: Readonly<Record<string, string>>,
): AppError {
  const { status, code } = WIRE[reason];

  const issues: FieldIssue[] = [{ path: AUTH_REASON_PATH, message: reason }];
  for (const [path, value] of Object.entries(details ?? {})) {
    issues.push({ path, message: value });
  }

  return new AppError(status, code, message, { issues });
}
