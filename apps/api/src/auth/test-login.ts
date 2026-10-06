import { normaliseMobile } from '@plastago/shared';
import { env } from '../config/env.js';

/**
 * The fixed-code test login — one driver mobile that signs in with a FIXED
 * code and is never sent an SMS.
 *
 * ── Why it exists ───────────────────────────────────────────────────────────
 * For the Flutter developer building the driver app against the live API, who
 * has no phone our SMS reaches. So it works in production on purpose: the live
 * API is the one the app is built on.
 *
 * ⚠️ Anyone who knows this pair IS that driver. What keeps it narrow: one
 * number, and only ever a driver-only account (`auth.service.ts` refuses it for
 * anyone holding another role). The account must never be a real person's.
 * To close it, delete `TEST_LOGIN` and its two callers, and release.
 *
 * 0491 570 156 is in ACMA's range reserved for fiction — no real phone holds
 * it, so no stranger can be signed in as by accident.
 *
 * ── How the code becomes fixed ──────────────────────────────────────────────
 * Better Auth's phone plugin always generates a random code and stores it
 * before calling `sendOTP`, and has no option to choose the code. So for this
 * one number `sendOTP` swaps the stored row for one holding the fixed code
 * instead of sending an SMS. Everything after that is Better Auth's own
 * verification, unchanged: the expiry, the attempt count, single use and the
 * session it issues.
 */
export const TEST_LOGIN = { mobile: '0491570156', code: '246810' } as const;

/** The two calls on Better Auth's internal adapter this needs — nothing more. */
interface VerificationStore {
  deleteVerificationByIdentifier(identifier: string): Promise<unknown>;
  createVerificationValue(data: {
    value: string;
    identifier: string;
    expiresAt: Date;
  }): Promise<unknown>;
}

/** True when this mobile, in any format, is the test login. */
export function isTestLogin(mobile: string): boolean {
  return normaliseMobile(mobile) === TEST_LOGIN.mobile;
}

/**
 * Replaces the random code Better Auth just stored with the fixed one.
 *
 * Delete-then-create rather than an update: an earlier, unexpired row for the
 * same number would otherwise still be on file, and which one verification
 * reads would be up to the adapter.
 */
export async function pinTestLoginCode(phoneNumber: string, store: VerificationStore): Promise<void> {
  await store.deleteVerificationByIdentifier(phoneNumber);
  await store.createVerificationValue({
    // `<code>:<failed attempts>` — the format the phone plugin writes and reads.
    value: `${TEST_LOGIN.code}:0`,
    identifier: phoneNumber,
    // The same lifetime every other sign-in code gets.
    expiresAt: new Date(Date.now() + env.OTP_TTL_SECONDS * 1000),
  });
}
