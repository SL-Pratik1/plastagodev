import { describe, expect, it } from 'vitest';
import {
  MAX_UPLOAD_BYTES,
  UPLOADABLE_TYPES,
  buildKey,
  signStubToken,
  stubPathFor,
  verifyStubToken,
} from '../src/integrations/storage.js';

/**
 * Object storage (§6A.10 #9).
 *
 * These tests are about the SECURITY properties, not about S3. Uploads come
 * from a phone on a building site, and the two things that must hold are that a
 * caller cannot choose where their bytes land, and cannot mint their own upload
 * URL. Both are cheap to get wrong and expensive to notice later.
 */

const JOB_ID = 'a'.repeat(24);

describe('storage keys', () => {
  it('scopes a key by owner so policies can be written against a path', () => {
    const key = buildKey({
      scope: 'jobs',
      ownerId: JOB_ID,
      kind: 'photos',
      contentType: 'image/jpeg',
    });

    expect(key).toMatch(new RegExp(`^jobs/${JOB_ID}/photos/[0-9a-f-]{36}\\.jpg$`));
  });

  it('never reuses a key, even for identical input', () => {
    const once = buildKey({ scope: 'jobs', ownerId: JOB_ID, kind: 'photos', contentType: 'image/jpeg' });
    const twice = buildKey({ scope: 'jobs', ownerId: JOB_ID, kind: 'photos', contentType: 'image/jpeg' });

    // Two phones both produce `IMG_0001.jpg`. A collision would overwrite the
    // evidence for a futile charge with a different job's photo.
    expect(once).not.toBe(twice);
  });

  /*
   * ⚠️ The owner id reaches `buildKey` from a route parameter. A `..` in it
   * escapes the prefix the key is meant to stay inside.
   */
  it('refuses an owner id that is not an id', () => {
    for (const ownerId of ['../../etc', 'not-an-id', '', '../a'.repeat(6)]) {
      expect(() =>
        buildKey({ scope: 'jobs', ownerId, kind: 'photos', contentType: 'image/jpeg' }),
      ).toThrow(/non-id owner/);
    }
  });

  it('falls back to a neutral extension for an unknown type', () => {
    const key = buildKey({
      scope: 'jobs',
      ownerId: JOB_ID,
      kind: 'photos',
      contentType: 'application/x-made-up',
    });
    expect(key.endsWith('.bin')).toBe(true);
  });
});

describe('what a phone may upload', () => {
  it('accepts the formats a phone camera actually produces', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/heic', 'application/pdf']) {
      expect(UPLOADABLE_TYPES.has(type)).toBe(true);
    }
  });

  /*
   * The bucket is served back to browsers, and an SVG executes script in the
   * origin that serves it. An allow-list makes that class of bug unreachable.
   */
  it('refuses formats that execute when served back', () => {
    for (const type of ['image/svg+xml', 'text/html', 'application/javascript']) {
      expect(UPLOADABLE_TYPES.has(type)).toBe(false);
    }
  });

  it('caps an upload well above a phone photo and well below a video', () => {
    expect(MAX_UPLOAD_BYTES).toBeGreaterThan(5 * 1024 * 1024);
    expect(MAX_UPLOAD_BYTES).toBeLessThanOrEqual(20 * 1024 * 1024);
  });
});

describe('stub upload tokens', () => {
  const key = `jobs/${JOB_ID}/photos/x.jpg`;

  it('accepts a token it issued', () => {
    const expiresAt = Date.now() + 60_000;
    expect(verifyStubToken(key, expiresAt, signStubToken(key, expiresAt))).toBe(true);
  });

  /*
   * Without this the stub's upload route would accept a write to any key
   * anybody named — a world-writable bucket on the developer's laptop.
   */
  it('rejects a token minted for a different key', () => {
    const expiresAt = Date.now() + 60_000;
    const other = signStubToken(`jobs/${'b'.repeat(24)}/photos/x.jpg`, expiresAt);

    expect(verifyStubToken(key, expiresAt, other)).toBe(false);
  });

  it('rejects a token whose expiry has been extended by the caller', () => {
    const expiresAt = Date.now() + 60_000;
    const token = signStubToken(key, expiresAt);

    // The expiry is signed, so moving it invalidates the signature.
    expect(verifyStubToken(key, expiresAt + 3_600_000, token)).toBe(false);
  });

  it('rejects an expired token', () => {
    const expiresAt = Date.now() - 1000;
    expect(verifyStubToken(key, expiresAt, signStubToken(key, expiresAt))).toBe(false);
  });

  it('rejects rubbish without throwing', () => {
    const expiresAt = Date.now() + 60_000;
    for (const token of ['', 'x', 'z'.repeat(32), 'not-hex']) {
      expect(verifyStubToken(key, expiresAt, token)).toBe(false);
    }
    expect(verifyStubToken(key, Number.NaN, signStubToken(key, Number.NaN))).toBe(false);
  });
});

describe('stub path resolution', () => {
  it('keeps a well-formed key inside the storage root', () => {
    expect(() => stubPathFor(`jobs/${JOB_ID}/photos/x.jpg`)).not.toThrow();
  });

  /*
   * ⚠️ The last line of defence before a filesystem write. A traversal here
   * writes anywhere the process can reach.
   */
  it('refuses a key that climbs out of the root', () => {
    for (const key of ['../secrets.env', 'jobs/../../etc/passwd', '../../../a']) {
      expect(() => stubPathFor(key)).toThrow(/escapes the storage root/);
    }
  });
});
