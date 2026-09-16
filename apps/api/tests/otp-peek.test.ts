import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The guard on `revealOtpCode` is the whole feature. If the flag can be turned
 * on in production, the API hands out working credentials to anyone who can
 * name an identifier — so it is tested directly rather than trusted.
 */

const IDENTIFIER = '0455112233';
const CODE = '483920';

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

async function loadPeek(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  return import('../src/auth/otp-peek.js');
}

describe('otp peek', () => {
  it('hands the code back when explicitly enabled outside production', async () => {
    const peek = await loadPeek({ NODE_ENV: 'development', AUTH_REVEAL_OTP_CODE: 'true' });

    peek.rememberOtpCode(IDENTIFIER, CODE);

    expect(peek.takeOtpCode(IDENTIFIER)).toBe(CODE);
  });

  it('is single use, so a code cannot be read twice', async () => {
    const peek = await loadPeek({ NODE_ENV: 'development', AUTH_REVEAL_OTP_CODE: 'true' });

    peek.rememberOtpCode(IDENTIFIER, CODE);
    peek.takeOtpCode(IDENTIFIER);

    expect(peek.takeOtpCode(IDENTIFIER)).toBeNull();
  });

  it('stays off by default', async () => {
    const peek = await loadPeek({ NODE_ENV: 'development' });

    peek.rememberOtpCode(IDENTIFIER, CODE);

    expect(peek.takeOtpCode(IDENTIFIER)).toBeNull();
  });

  /*
   * The one that matters. A deployment can set the variable by mistake — copied
   * from a staging config, say — and the code must ignore it.
   */
  it('refuses in production even when the variable says true', async () => {
    const peek = await loadPeek({
      NODE_ENV: 'production',
      AUTH_REVEAL_OTP_CODE: 'true',
      BETTER_AUTH_SECRET: 'x'.repeat(48),
      STORAGE_PROVIDER: 's3',
      S3_REGION: 'ap-southeast-2',
      S3_BUCKET: 'plastago-test',
      MAIL_PROVIDER: 'graph',
      MS_GRAPH_TENANT_ID: 'tenant',
      MS_GRAPH_CLIENT_ID: 'client',
      MS_GRAPH_CLIENT_SECRET: 'secret',
      MS_GRAPH_MAIL_SENDER: 'noreply@plastago.com.au',
      SMS_PROVIDER: 'clicksend',
      CLICKSEND_USERNAME: 'user',
      CLICKSEND_API_KEY: 'key',
      CLICKSEND_FROM: 'PlastaGo',
    });

    peek.rememberOtpCode(IDENTIFIER, CODE);

    expect(peek.takeOtpCode(IDENTIFIER)).toBeNull();
  });

  it('keeps codes separate per identifier', async () => {
    const peek = await loadPeek({ NODE_ENV: 'development', AUTH_REVEAL_OTP_CODE: 'true' });

    peek.rememberOtpCode(IDENTIFIER, CODE);
    peek.rememberOtpCode('matt@plastago.com.au', '111222');

    expect(peek.takeOtpCode('matt@plastago.com.au')).toBe('111222');
    expect(peek.takeOtpCode(IDENTIFIER)).toBe(CODE);
  });
});
