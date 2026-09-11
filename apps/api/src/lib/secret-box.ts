import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from './app-error.js';

/**
 * Authenticated encryption for the few secrets that live in the DATABASE
 * rather than in the environment.
 *
 * ── Why this exists for exactly one caller today ──────────────────────────
 * Everything else PlastaGo holds is its own credential, sitting in `.env`,
 * protected by whatever protects the host. A Xero refresh token is different in
 * three ways that matter together: it belongs to the CUSTOMER, it grants
 * standing access to their accounting records, and it has to be written to
 * Mongo because it is minted at runtime and rotated on every use. A database
 * backup, a screen-shared Compass window or a `$dump` in a support session
 * should not be a leaked ledger.
 *
 * ── AES-256-GCM, not CBC or a bare cipher ─────────────────────────────────
 * GCM authenticates as well as encrypts, so a tampered ciphertext fails loudly
 * instead of decrypting to plausible rubbish that then gets sent to Xero as a
 * refresh token. The auth tag is what makes that guarantee, and it is stored
 * alongside the payload rather than derived.
 */

/** `v1` so a future key-derivation change can be recognised, not guessed at. */
const VERSION = 'v1';

/**
 * 96 bits, the size GCM is specified for.
 *
 * Not a constant and never reused: a repeated nonce under the same key is the
 * one mistake that breaks GCM completely rather than gradually.
 */
const IV_BYTES = 12;

export interface SealedSecret {
  /** `v1:<iv>:<tag>:<ciphertext>`, all base64url. One string, one column. */
  readonly ciphertext: string;
}

/**
 * The key, resolved per call rather than at module load.
 *
 * ── Why not a module-level constant ───────────────────────────────────────
 * `XERO_ENCRYPTION_KEY` is optional in the schema — it is only required when
 * `XERO_PROVIDER=xero`. Reading it into a constant at import time would make
 * this module throw on a deployment that has Xero switched off and no key,
 * taking the whole API down for a feature nobody enabled.
 */
function key(): Buffer {
  const hex = env.XERO_ENCRYPTION_KEY;

  if (!hex) {
    /*
     * Reachable only through a programming error: the boot check refuses to
     * start with XERO_PROVIDER=xero and no key. Worth its own message anyway,
     * because the alternative failure is a TypeError inside `createCipheriv`
     * that says nothing about which credential is missing.
     */
    throw new Error('XERO_ENCRYPTION_KEY is not set — cannot encrypt or decrypt stored secrets');
  }

  return Buffer.from(hex, 'hex');
}

/** Encrypts one secret for storage. */
export function seal(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);

  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, b64(iv), b64(tag), b64(body)].join(':');
}

/**
 * Decrypts one stored secret.
 *
 * ⚠️ Throws `AppError.dependencyUnavailable`, not a generic error, because the
 * realistic cause is not corruption — it is that `XERO_ENCRYPTION_KEY` was
 * rotated or restored from a different environment. The caller turns that into
 * "reconnect required", which is the only thing a user can actually do about
 * it. A 500 would send them to support instead.
 */
export function open(sealed: string): string {
  const parts = sealed.split(':');

  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw AppError.dependencyUnavailable(
      'The stored Xero connection could not be read. Reconnect to Xero to repair it.',
    );
  }

  const [, ivPart, tagPart, bodyPart] = parts as [string, string, string, string];

  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), unb64(ivPart));
    decipher.setAuthTag(unb64(tagPart));

    return Buffer.concat([decipher.update(unb64(bodyPart)), decipher.final()]).toString('utf8');
  } catch {
    // The tag check failed, or the key changed. Both are the same story to the
    // person reading the screen, and the difference is not one to leak.
    throw AppError.dependencyUnavailable(
      'The stored Xero connection could not be read. Reconnect to Xero to repair it.',
    );
  }
}

const b64 = (value: Buffer): string => value.toString('base64url');
const unb64 = (value: string): Buffer => Buffer.from(value, 'base64url');
