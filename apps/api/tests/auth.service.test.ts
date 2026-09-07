import { OtpChallengeSchema, SessionSchema } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_REASON_PATH, type AuthReason } from '../src/lib/auth-error.js';
import { createFakeAuth, createFakeRepository, VALID_CODE } from './helpers/fake-auth.js';

/**
 * The sign-in state machine (§9, M1.5).
 *
 * These assert on the REASON a sign-in failed, not just that it did. That
 * distinction is the product requirement: `auth-messages.ts` in the web app
 * shows different copy — and different recovery actions — for an expired code,
 * a wrong one and a spent challenge, so a service that collapsed them into
 * "authentication failed" would leave the user with no way forward.
 */

let repo: ReturnType<typeof createFakeRepository>;
let auth: ReturnType<typeof createFakeAuth>;

// A GETTER, not a value: `vi.mock` factories are hoisted above every import, so
// the fakes do not exist yet when this runs. Resolving them on each access lets
// `beforeEach` hand out a clean pair per test.
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

/** The reason the API put at the reserved issue path. */
function reasonOf(error: unknown): AuthReason | undefined {
  const issues = (error as { issues?: Array<{ path: string; message: string }> }).issues ?? [];
  return issues.find((issue) => issue.path === AUTH_REASON_PATH)?.message as AuthReason | undefined;
}

async function expectReason(call: Promise<unknown>, reason: AuthReason): Promise<unknown> {
  const error = await call.then(
    () => {
      throw new Error(`expected ${reason} but the call resolved`);
    },
    (caught: unknown) => caught,
  );
  expect(reasonOf(error)).toBe(reason);
  return error;
}

beforeEach(() => {
  repo = createFakeRepository();
  auth = createFakeAuth();
});

describe('requestCode', () => {
  it('routes an email identifier to the email channel and masks the destination', async () => {
    repo.addUser({ email: 'renee@plastago.com.au' });

    const challenge = await authService.requestCode(
      { identifier: 'Renee@Plastago.com.au' },
      ctx,
    );

    expect(() => OtpChallengeSchema.parse(challenge)).not.toThrow();
    expect(challenge.channel).toBe('email');
    // Masked, and identical in shape to what the mock produced, so the screen
    // renders the same either side of the cutover.
    expect(challenge.sentTo).toBe('r••••@plastago.com.au');
    expect(challenge.attemptsRemaining).toBe(5);
    // Case-insensitive: the address is lowercased before it is resolved or sent.
    expect(auth.emailsSent).toEqual([{ email: 'renee@plastago.com.au', type: 'sign-in' }]);
  });

  it('routes an Australian mobile to SMS, in any format the keypad produces', async () => {
    repo.addUser({ email: null, mobile: '0412345678', role: 'driver' });

    const challenge = await authService.requestCode({ identifier: '+61 412 345 678' }, ctx);

    expect(challenge.channel).toBe('sms');
    expect(challenge.sentTo).toBe('•••• ••• 678');
    // Normalised to the stored form before lookup, or the driver is not found.
    expect(auth.smsSent).toEqual(['0412345678']);
  });

  it('reports an unknown identifier in development, so the screen is walkable', async () => {
    await expectReason(
      authService.requestCode({ identifier: 'nobody@plastago.com.au' }, ctx),
      'IDENTIFIER_UNKNOWN',
    );
    expect(auth.emailsSent).toHaveLength(0);
  });

  it('refuses a suspended account and sends nothing', async () => {
    repo.addUser({ email: 'gone@plastago.com.au', status: 'suspended' });

    await expectReason(
      authService.requestCode({ identifier: 'gone@plastago.com.au' }, ctx),
      'ACCOUNT_SUSPENDED',
    );
    expect(auth.emailsSent).toHaveLength(0);
  });

  it('lets an invited user sign in — that is how they activate', async () => {
    repo.addUser({ email: 'new@iplasta.com.au', status: 'invited' });

    const challenge = await authService.requestCode({ identifier: 'new@iplasta.com.au' }, ctx);

    expect(challenge.channel).toBe('email');
    expect(auth.emailsSent).toHaveLength(1);
  });

  it('caps codes per identifier, however many addresses ask for them', async () => {
    repo.addUser({ email: 'busy@plastago.com.au' });

    for (let i = 0; i < 6; i += 1) {
      await authService.requestCode({ identifier: 'busy@plastago.com.au' }, ctx);
    }

    // The seventh is refused: an SMS costs money and a flood of them is
    // harassment of whoever owns the number.
    await expect(
      authService.requestCode({ identifier: 'busy@plastago.com.au' }, {
        ...ctx,
        ip: '198.51.100.7',
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('verifyCode', () => {
  async function challengeFor(email = 'matt@plastago.com.au') {
    const user = repo.addUser({ email });
    const challenge = await authService.requestCode({ identifier: email }, ctx);
    return { user, challenge };
  }

  it('opens a session, forwards the cookie and stamps the sign-in', async () => {
    const { user, challenge } = await challengeFor();

    const result = await authService.verifyCode(
      { challengeId: challenge.challengeId, code: VALID_CODE },
      ctx,
    );

    expect(() => SessionSchema.parse(result.session)).not.toThrow();
    expect(result.session.user.id).toBe(user.id);
    expect(result.session.user.role).toBe('office-staff');
    expect(result.session.user.brandIds).toEqual(['plastago']);
    // The cookie has to reach our response or the browser stays signed out.
    expect(result.setCookie[0]).toContain('HttpOnly');
    expect(repo.signedIn).toHaveLength(1);
    expect(result.session.user.lastSignedInAt).not.toBeNull();
  });

  it('rejects a wrong code and says how many attempts are left', async () => {
    const { challenge } = await challengeFor();

    const error = await expectReason(
      authService.verifyCode({ challengeId: challenge.challengeId, code: '000000' }, ctx),
      'CODE_INCORRECT',
    );

    // `auth-messages.ts` reads this exact key to warn before the last attempt.
    const issues = (error as { issues: Array<{ path: string; message: string }> }).issues;
    expect(issues).toEqual(
      expect.arrayContaining([{ path: 'attemptsRemaining', message: '4' }]),
    );
  });

  it('escalates to a burned challenge once the attempts run out', async () => {
    const { challenge } = await challengeFor();

    for (let i = 0; i < 4; i += 1) {
      await expectReason(
        authService.verifyCode({ challengeId: challenge.challengeId, code: '000000' }, ctx),
        'CODE_INCORRECT',
      );
    }

    // The fifth wrong guess is the last one: the screen must now say "start
    // again", not "try again".
    await expectReason(
      authService.verifyCode({ challengeId: challenge.challengeId, code: '000000' }, ctx),
      'CODE_ATTEMPTS_EXCEEDED',
    );
  });

  it('treats an expired code as expired, and does not spend an attempt on it', async () => {
    const { challenge } = await challengeFor();
    repo.mutateChallenge(challenge.challengeId, { expiresAt: new Date(Date.now() - 1_000) });

    await expectReason(
      authService.verifyCode({ challengeId: challenge.challengeId, code: VALID_CODE }, ctx),
      'CODE_EXPIRED',
    );

    // Running out of time is not a wrong guess. Charging an attempt for it
    // would punish the user for the delay.
    expect(repo.challenges.get(challenge.challengeId)?.attemptsRemaining).toBe(5);
  });

  it('reports an unknown challenge id rather than leaking that it never existed', async () => {
    await expectReason(
      authService.verifyCode({ challengeId: '0'.repeat(24), code: VALID_CODE }, ctx),
      'CHALLENGE_NOT_FOUND',
    );
  });

  it('cannot open two sessions from one code', async () => {
    const { challenge } = await challengeFor();

    await authService.verifyCode({ challengeId: challenge.challengeId, code: VALID_CODE }, ctx);

    // A replayed request, or two arriving together. Only the first may win.
    await expectReason(
      authService.verifyCode({ challengeId: challenge.challengeId, code: VALID_CODE }, ctx),
      'CHALLENGE_NOT_FOUND',
    );
    expect(repo.signedIn).toHaveLength(1);
  });

  it('refuses an account suspended between the code being sent and used', async () => {
    const email = 'about-to-go@plastago.com.au';
    const user = repo.addUser({ email });
    const challenge = await authService.requestCode({ identifier: email }, ctx);

    // The office suspends them while the code is in flight. Status is checked
    // again at verification for exactly this window — an offboarded user must
    // not get in on a code issued a minute earlier.
    repo.setUserStatus(user.id, 'suspended');

    await expectReason(
      authService.verifyCode({ challengeId: challenge.challengeId, code: VALID_CODE }, ctx),
      'ACCOUNT_SUSPENDED',
    );
    expect(repo.signedIn).toHaveLength(0);
  });

  it('refuses a code whose account was deleted before it was used', async () => {
    const email = 'deleted@plastago.com.au';
    const user = repo.addUser({ email });
    const challenge = await authService.requestCode({ identifier: email }, ctx);

    repo.removeUser(user.id);

    await expectReason(
      authService.verifyCode({ challengeId: challenge.challengeId, code: VALID_CODE }, ctx),
      'IDENTIFIER_UNKNOWN',
    );
  });
});

describe('resendCode', () => {
  it('refuses until the cooldown has elapsed', async () => {
    repo.addUser({ email: 'matt@plastago.com.au' });
    const challenge = await authService.requestCode(
      { identifier: 'matt@plastago.com.au' },
      ctx,
    );

    await expectReason(
      authService.resendCode(challenge.challengeId, ctx),
      'RESEND_TOO_SOON',
    );
  });

  it('issues a fresh window and refills the attempts once it has', async () => {
    repo.addUser({ email: 'matt@plastago.com.au' });
    const challenge = await authService.requestCode(
      { identifier: 'matt@plastago.com.au' },
      ctx,
    );

    // Spend an attempt, then let the cooldown pass.
    await expectReason(
      authService.verifyCode({ challengeId: challenge.challengeId, code: '000000' }, ctx),
      'CODE_INCORRECT',
    );
    repo.mutateChallenge(challenge.challengeId, {
      resendAvailableAt: new Date(Date.now() - 1_000),
    });

    const refreshed = await authService.resendCode(challenge.challengeId, ctx);

    expect(refreshed.attemptsRemaining).toBe(5);
    expect(new Date(refreshed.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(auth.emailsSent).toHaveLength(2);
  });

  it('will not resend against a challenge that has already been used', async () => {
    repo.addUser({ email: 'matt@plastago.com.au' });
    const challenge = await authService.requestCode(
      { identifier: 'matt@plastago.com.au' },
      ctx,
    );
    await authService.verifyCode({ challengeId: challenge.challengeId, code: VALID_CODE }, ctx);

    await expectReason(
      authService.resendCode(challenge.challengeId, ctx),
      'CHALLENGE_NOT_FOUND',
    );
  });
});

describe('signOut', () => {
  it('succeeds even with no live session, and returns the clearing cookie', async () => {
    const cookies = await authService.signOut(ctx);
    expect(cookies).toHaveLength(1);
  });
});

describe('the role invariant', () => {
  it('refuses a user whose active role is not one they hold', async () => {
    // A privilege bug, not a display bug: permission checks read the ACTIVE
    // role, so signing this session would grant `super-admin` to someone who
    // only holds `driver`. Mongo cannot express "role must be in roles", so
    // this is the only place it can be caught.
    const user = repo.addUser({ email: 'broken@plastago.com.au', role: 'driver' });
    repo.setUserRoles(user.id, 'super-admin', ['driver']);

    const challenge = await authService.requestCode(
      { identifier: 'broken@plastago.com.au' },
      ctx,
    );

    await expect(
      authService.verifyCode({ challengeId: challenge.challengeId, code: VALID_CODE }, ctx),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
