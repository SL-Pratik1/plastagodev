import { OtpChallengeSchema } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeAuth, createFakeRepository, VALID_CODE } from './helpers/fake-auth.js';

/**
 * Production sign-in privacy: the response must not reveal whether an account
 * exists (§9).
 *
 * ── Why this is a separate file ─────────────────────────────────────────────
 * `revealUnknownIdentifier` is resolved once, at module load, from NODE_ENV.
 * That is the right shape for the application — a security posture should not
 * be a runtime toggle something can flip mid-process — but it means the two
 * behaviours cannot be exercised in one file. This file mocks the environment
 * as production; `auth.service.test.ts` covers the development behaviour.
 *
 * ── What is being protected ─────────────────────────────────────────────────
 * The customer portal's sign-in form is on the public internet. "Does this
 * address have an account with PlastaGo" is the question an attacker answers
 * first, because a confirmed list of a builder's staff addresses is what makes
 * a phishing run against them credible. So an unknown identifier gets a
 * challenge that looks exactly like a real one, and no message is sent.
 */

let repo: ReturnType<typeof createFakeRepository>;
let auth: ReturnType<typeof createFakeAuth>;

vi.mock('../src/config/env.js', () => ({
  env: {
    NODE_ENV: 'production',
    LOG_LEVEL: 'silent',
    OTP_TTL_SECONDS: 300,
    OTP_RESEND_COOLDOWN_SECONDS: 30,
    OTP_MAX_ATTEMPTS: 5,
    OTP_MAX_SENDS_PER_HOUR: 6,
    AUTH_SESSION_TTL_HOURS: 8,
    OTP_SENDER_NAME: 'PlastaGo',
  },
  isProduction: true,
  isTest: false,
  requireDatabase: true,
  // The whole point of this file.
  revealUnknownIdentifier: false,
}));

vi.mock('../src/domains/auth/auth.repository.js', () => ({
  get authRepository() {
    return repo.repository;
  },
}));

vi.mock('../src/auth/better-auth.js', () => ({
  getAuth: () => auth,
  isAuthReady: () => true,
  initAuth: () => Promise.resolve(),
}));

const { authService } = await import('../src/domains/auth/auth.service.js');

const ctx = { ip: '203.0.113.10', headers: new Headers() };

beforeEach(() => {
  repo = createFakeRepository();
  auth = createFakeAuth();
});

describe('unknown identifiers in production', () => {
  it('answers with a normal-looking challenge instead of admitting it is unknown', async () => {
    const challenge = await authService.requestCode(
      { identifier: 'stranger@example.com' },
      ctx,
    );

    // Satisfies the contract, so a caller cannot spot a decoy by its shape.
    expect(() => OtpChallengeSchema.parse(challenge)).not.toThrow();
    expect(challenge.channel).toBe('email');
    // First character, then one bullet per remaining character of the local
    // part — so the length is not itself a hint that this one is fabricated.
    expect(challenge.sentTo).toBe('s•••••••@example.com');
    expect(challenge.attemptsRemaining).toBe(5);
  });

  it('sends nothing at all', async () => {
    await authService.requestCode({ identifier: 'stranger@example.com' }, ctx);
    await authService.requestCode({ identifier: '0499999999' }, ctx);

    expect(auth.emailsSent).toHaveLength(0);
    expect(auth.smsSent).toHaveLength(0);
  });

  it('is indistinguishable from a real challenge, field for field', async () => {
    repo.addUser({ email: 'real@plastago.com.au' });

    const real = await authService.requestCode({ identifier: 'real@plastago.com.au' }, ctx);
    const decoy = await authService.requestCode({ identifier: 'fake@plastago.com.au' }, ctx);

    // Same keys, same types. Only the values that legitimately differ do.
    expect(Object.keys(decoy).sort()).toEqual(Object.keys(real).sort());
    expect(decoy.channel).toBe(real.channel);
    expect(decoy.attemptsRemaining).toBe(real.attemptsRemaining);
  });

  it('fails verification as a wrong code, never as an unknown account', async () => {
    const decoy = await authService.requestCode({ identifier: 'stranger@example.com' }, ctx);

    const error = await authService
      .verifyCode({ challengeId: decoy.challengeId, code: VALID_CODE }, ctx)
      .then(
        () => {
          throw new Error('a decoy must never open a session');
        },
        (caught: unknown) => caught,
      );

    // 401 CODE_INCORRECT — exactly what a real challenge with a bad code gives.
    const issues = (error as { issues: Array<{ path: string; message: string }> }).issues;
    expect(issues).toEqual(
      expect.arrayContaining([{ path: 'authReason', message: 'CODE_INCORRECT' }]),
    );
    expect(repo.signedIn).toHaveLength(0);
  });

  it('burns attempts on a decoy, so guessing does not reveal one either', async () => {
    const decoy = await authService.requestCode({ identifier: 'stranger@example.com' }, ctx);

    for (let i = 0; i < 4; i += 1) {
      await expect(
        authService.verifyCode({ challengeId: decoy.challengeId, code: '000000' }, ctx),
      ).rejects.toBeTruthy();
    }

    // Reaching CODE_ATTEMPTS_EXCEEDED on the same guess count as a real one is
    // what keeps the two paths symmetric.
    const error = await authService
      .verifyCode({ challengeId: decoy.challengeId, code: '000000' }, ctx)
      .catch((caught: unknown) => caught);

    const issues = (error as { issues: Array<{ path: string; message: string }> }).issues;
    expect(issues).toEqual(
      expect.arrayContaining([{ path: 'authReason', message: 'CODE_ATTEMPTS_EXCEEDED' }]),
    );
  });

  it('refuses a suspended account the same way, without confirming it exists', async () => {
    repo.addUser({ email: 'suspended@plastago.com.au', status: 'suspended' });

    const challenge = await authService.requestCode(
      { identifier: 'suspended@plastago.com.au' },
      ctx,
    );

    expect(() => OtpChallengeSchema.parse(challenge)).not.toThrow();
    expect(auth.emailsSent).toHaveLength(0);
  });
});
