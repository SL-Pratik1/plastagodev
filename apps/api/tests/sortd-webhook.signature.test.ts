import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySortdSignature } from '../src/lib/sortd-webhook.js';

/**
 * Sortd webhook signatures — `HMAC-SHA256(secret, "${timestamp}.${rawBody}")`.
 *
 * Pure: no env, no network. The secrets below are fixtures, not credentials.
 */

const SECRET = 'driver-app-secret-fixture-0123456789';
const OTHER_SECRET = 'portal-app-secret-fixture-9876543210';
const NOW_MS = Date.parse('2026-10-16T02:00:00Z');
const NOW_S = String(Math.floor(NOW_MS / 1000));
const BODY = '{"event":"ticket.created","ticket":{"id":"t1"}}';

function sign(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

const valid = {
  rawBody: BODY,
  timestamp: NOW_S,
  signature: sign(SECRET, NOW_S, BODY),
  secret: SECRET,
  nowMs: NOW_MS,
};

describe('verifySortdSignature', () => {
  it('accepts a delivery signed with this surface’s secret', () => {
    expect(verifySortdSignature(valid)).toEqual({ ok: true });
  });

  it('accepts an upper-case hex digest', () => {
    expect(verifySortdSignature({ ...valid, signature: valid.signature.toUpperCase() })).toEqual({
      ok: true,
    });
  });

  it('refuses a delivery signed with ANOTHER surface’s secret', () => {
    const signature = sign(OTHER_SECRET, NOW_S, BODY);
    expect(verifySortdSignature({ ...valid, signature })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses everything when the surface has no secret — never falls open', () => {
    expect(verifySortdSignature({ ...valid, secret: null })).toEqual({
      ok: false,
      reason: 'no_secret',
    });
    expect(verifySortdSignature({ ...valid, secret: '', signature: '' })).toEqual({
      ok: false,
      reason: 'no_secret',
    });
  });

  it('refuses a body that was changed after signing', () => {
    expect(verifySortdSignature({ ...valid, rawBody: BODY.replace('t1', 't2') })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a body that was re-serialised (whitespace differs)', () => {
    const reserialised = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(verifySortdSignature({ ...valid, rawBody: reserialised }).ok).toBe(false);
  });

  it('refuses a signature over the body alone, without the timestamp', () => {
    const bodyOnly = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(verifySortdSignature({ ...valid, signature: bodyOnly }).ok).toBe(false);
  });

  it('refuses transposed timestamp and signature', () => {
    expect(
      verifySortdSignature({ ...valid, timestamp: valid.signature, signature: valid.timestamp }),
    ).toEqual({ ok: false, reason: 'bad_timestamp' });
  });

  it('refuses missing headers', () => {
    expect(verifySortdSignature({ ...valid, timestamp: '' })).toEqual({
      ok: false,
      reason: 'missing_headers',
    });
    expect(verifySortdSignature({ ...valid, signature: '' })).toEqual({
      ok: false,
      reason: 'missing_headers',
    });
  });

  it('refuses a timestamp that is not unix seconds', () => {
    for (const timestamp of ['abc', '1.5e9', ' 1760580000', '-1760580000']) {
      expect(verifySortdSignature({ ...valid, timestamp })).toEqual({
        ok: false,
        reason: 'bad_timestamp',
      });
    }
  });

  it('refuses a replay older than five minutes, and one from the future', () => {
    for (const offset of [-301, 301]) {
      const timestamp = String(Number(NOW_S) + offset);
      expect(
        verifySortdSignature({ ...valid, timestamp, signature: sign(SECRET, timestamp, BODY) }),
      ).toEqual({ ok: false, reason: 'stale_timestamp' });
    }
  });

  it('accepts a timestamp just inside the window', () => {
    const timestamp = String(Number(NOW_S) - 299);
    expect(
      verifySortdSignature({ ...valid, timestamp, signature: sign(SECRET, timestamp, BODY) }),
    ).toEqual({ ok: true });
  });

  it('answers a wrong-length signature with a refusal, not a throw', () => {
    expect(() => verifySortdSignature({ ...valid, signature: 'abc' })).not.toThrow();
    expect(verifySortdSignature({ ...valid, signature: 'abc' })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
});
