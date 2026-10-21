import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signature verification for Sortd webhooks.
 *
 * Sortd signs `${timestamp}.${rawBody}` with the app's webhook secret and sends
 * the hex digest in `X-Sortd-Signature` beside `X-Sortd-Timestamp`. Two things
 * about that are easy to get wrong, and both produce a verifier that looks
 * right and is not:
 *
 *  1. The signed string is NOT the body alone. A signature over the body alone
 *     never ages, so a captured request could be replayed forever.
 *  2. The RAW bytes must be used. `express.json()` parses and re-serialises,
 *     and a re-serialised body no longer matches the digest — which is why the
 *     route is mounted ahead of the JSON parser in `server.ts`.
 */

/** How old a timestamp may be before the delivery is treated as a replay. */
const MAX_SKEW_SECONDS = 5 * 60;

/**
 * Named fields rather than four positional strings, deliberately.
 *
 * The vendor's own guide documents `(rawBody, timestamp, signature, secret)`
 * and warns in bold that transposing `timestamp` and `signature` is the common
 * mistake. All four are strings, so the compiler cannot help, and the result
 * does not error — it rejects every real delivery while a test that transposes
 * them the same way still passes. Named fields remove the mistake rather than
 * documenting it.
 */
export interface SortdSignatureInput {
  /** The exact bytes received, before any parsing. */
  rawBody: string;
  /** `X-Sortd-Timestamp` — unix seconds, as sent. */
  timestamp: string;
  /** `X-Sortd-Signature` — lowercase hex HMAC-SHA256. */
  signature: string;
  /** The secret for the surface this delivery claims to be for. */
  secret: string | null;
  /** Injected so a test can pin the clock. */
  nowMs?: number;
}

/** Why a delivery was refused. Logged, never returned to the caller. */
export type SortdSignatureFailure =
  | 'no_secret'
  | 'missing_headers'
  | 'bad_timestamp'
  | 'stale_timestamp'
  | 'bad_signature';

export type SortdSignatureResult = { ok: true } | { ok: false; reason: SortdSignatureFailure };

export function verifySortdSignature(input: SortdSignatureInput): SortdSignatureResult {
  const { rawBody, timestamp, signature, secret, nowMs = Date.now() } = input;

  /*
   * ⚠️ NO SECRET MEANS REFUSE EVERYTHING — never fall open.
   *
   * An unset secret compared against an absent header is the classic way an
   * endpoint meant for one caller becomes reachable by anyone. Here that would
   * let a stranger post fabricated support tickets into the super-admins'
   * inboxes, with a link in the email.
   */
  if (!secret) return { ok: false, reason: 'no_secret' };
  if (!timestamp || !signature) return { ok: false, reason: 'missing_headers' };

  // Unix seconds, digits only. `Number('')` and `Number(' 12 ')` are both
  // numbers, and neither is a timestamp Sortd sent.
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'bad_timestamp' };

  const skewSeconds = Math.abs(nowMs / 1000 - Number(timestamp));
  if (skewSeconds > MAX_SKEW_SECONDS) return { ok: false, reason: 'stale_timestamp' };

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

  /*
   * Length first, because `timingSafeEqual` THROWS on a length mismatch rather
   * than returning false — a short signature would surface as a 500 instead of
   * a 401. That leaks only the digest's length, which is public anyway.
   */
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.toLowerCase());
  if (a.length !== b.length) return { ok: false, reason: 'bad_signature' };

  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}
