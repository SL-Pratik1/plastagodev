import { X509Certificate } from 'node:crypto';

/**
 * Reading a certificate-and-key out of a single environment variable.
 *
 * ── Why three spellings are accepted ──────────────────────────────────────
 * A PEM file is several lines, and a hosting dashboard's environment field
 * often is not. So the same certificate arrives as the PEM itself, as the PEM
 * with its line breaks typed as `\n`, or as the whole file base64-encoded onto
 * one line — the last being what the handover notes recommend, because it
 * survives every copy and paste. All three become the same PEM here, so the
 * rest of the code only ever sees one.
 */
export function pemFromSetting(value: string): string {
  const trimmed = value.trim();

  if (trimmed.includes('-----BEGIN')) return trimmed.replace(/\\n/g, '\n');

  return Buffer.from(trimmed, 'base64').toString('utf8').trim();
}

/**
 * Why this PEM cannot sign us in, or null when it can.
 *
 * ⚠️ BOTH halves are required. Microsoft holds the public certificate; we prove
 * we own it by signing with the private key. A setting holding only the
 * certificate — the half that was emailed to the client — looks complete and
 * fails on the first sign-in code of the day.
 */
export function pemProblem(pem: string): string | null {
  if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
    return 'Must contain the certificate (-----BEGIN CERTIFICATE-----)';
  }
  if (pem.includes('-----BEGIN ENCRYPTED PRIVATE KEY-----')) {
    return 'The private key must not be password-protected';
  }
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(pem)) {
    return 'Must contain the private key as well as the certificate';
  }
  return null;
}

/** When the certificate in this PEM stops working, or null if unreadable. */
export function certificateExpiry(pem: string): Date | null {
  const block = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem)?.[0];
  if (!block) return null;

  try {
    return new Date(new X509Certificate(block).validTo);
  } catch {
    return null;
  }
}
