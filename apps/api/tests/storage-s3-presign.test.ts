import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Presigned uploads against the REAL provider (§6A.10 #9).
 *
 * ── The bug this exists to catch ──────────────────────────────────────────
 * A presigned PUT is a signature over a specific set of headers. AWS lists them
 * in the URL as `X-Amz-SignedHeaders`, and S3 recomputes the signature from the
 * headers the request actually carries — so a header that was signed but never
 * handed to the client means every upload comes back `SignatureDoesNotMatch`.
 *
 * That is exactly what happened: the command asked for `ServerSideEncryption`,
 * the SDK signed `x-amz-server-side-encryption`, and `headers` carried only the
 * content type and length. Every lead attachment, job photo and weighbridge
 * docket failed against the real bucket while the stub kept working, because
 * the stub does not verify signatures.
 *
 * ── Why the real SDK and not a mock ───────────────────────────────────────
 * The thing under test is what the AWS signer decides to sign. Mocking the
 * signer would assert our own assumption back at us — which is the assumption
 * that was wrong. Signing is pure local computation, so this reaches no network
 * and the credentials below are nonsense on purpose.
 */

const TTL = 900;

/*
 * Only `env` itself is replaced; the module's other exports are pulled through.
 * The logger imports `isProduction` from here, so a partial mock of a config
 * module is a module that throws on import.
 */
vi.mock('../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/env.js')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      STORAGE_PROVIDER: 's3',
      S3_BUCKET: 'plastago-test-bucket',
      S3_REGION: 'ap-southeast-2',
      S3_ENDPOINT: '',
      S3_KEY_PREFIX: 'plastago',
      S3_URL_TTL_SECONDS: TTL,
      S3_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    },
  };
});

const { getStorage, setStorageForTesting } = await import('../src/integrations/storage.js');

beforeEach(() => {
  setStorageForTesting(undefined);
});

describe('a presigned upload to S3', () => {
  it('hands over every header it asked AWS to sign', async () => {
    const upload = await getStorage().presignUpload({
      key: 'plastago/leads/aaaaaaaaaaaaaaaaaaaaaaaa/attachments/x.pdf',
      contentType: 'application/pdf',
      contentLength: 12_345,
    });

    const signed = (new URL(upload.uploadUrl).searchParams.get('X-Amz-SignedHeaders') ?? '')
      .split(';')
      .filter((name) => name !== '' && name !== 'host');

    expect(signed.length).toBeGreaterThan(0);

    // Case-insensitively, because a header name is not case-sensitive and the
    // signer lower-cases what it lists.
    const handed = Object.keys(upload.headers).map((name) => name.toLowerCase());
    for (const name of signed) {
      expect(handed, `signed but not returned: ${name}`).toContain(name);
    }
  });

  /*
   * Named explicitly as well as covered by the invariant above. The invariant
   * proves the two sets agree; this proves encryption is still being asked for
   * at all, so a future "fix" cannot satisfy the invariant by quietly dropping
   * it from the command.
   */
  it('still requires the object to be encrypted', async () => {
    const upload = await getStorage().presignUpload({
      key: 'plastago/jobs/aaaaaaaaaaaaaaaaaaaaaaaa/photos/x.jpg',
      contentType: 'image/jpeg',
      contentLength: 2048,
    });

    expect(upload.headers['x-amz-server-side-encryption']).toBe('AES256');
    expect(new URL(upload.uploadUrl).searchParams.get('X-Amz-SignedHeaders')).toContain(
      'x-amz-server-side-encryption',
    );
  });

  it('declares the content type and length the signature covers', async () => {
    const upload = await getStorage().presignUpload({
      key: 'plastago/leads/aaaaaaaaaaaaaaaaaaaaaaaa/attachments/x.pdf',
      contentType: 'application/pdf',
      contentLength: 12_345,
    });

    expect(upload.headers['Content-Type']).toBe('application/pdf');
    expect(upload.headers['Content-Length']).toBe('12345');
    expect(upload.key).toBe('plastago/leads/aaaaaaaaaaaaaaaaaaaaaaaa/attachments/x.pdf');
  });

  it('expires, and says when', async () => {
    const before = Date.now();
    const upload = await getStorage().presignUpload({
      key: 'plastago/leads/aaaaaaaaaaaaaaaaaaaaaaaa/attachments/x.pdf',
      contentType: 'application/pdf',
      contentLength: 10,
    });

    expect(new URL(upload.uploadUrl).searchParams.get('X-Amz-Expires')).toBe(String(TTL));
    const expiresAt = new Date(upload.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + TTL * 1000 - 5000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + TTL * 1000 + 5000);
  });
});
