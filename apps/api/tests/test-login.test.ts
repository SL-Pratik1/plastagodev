import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeAuth, createFakeRepository } from './helpers/fake-auth.js';

/**
 * The fixed-code test login. It is a deliberate hole in sign-in on the live
 * API, so its edges are tested rather than trusted: one number, driver-only
 * accounts, and every other number left exactly as it was.
 */

let repo: ReturnType<typeof createFakeRepository>;
let auth: ReturnType<typeof createFakeAuth>;

vi.mock('../src/domains/users/user.repository.js', () => ({
  userRepository: { recordSignIn: () => Promise.resolve() },
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

const { TEST_LOGIN, isTestLogin, pinTestLoginCode } = await import('../src/auth/test-login.js');
const { authService } = await import('../src/domains/auth/auth.service.js');

const ctx = { ip: '203.0.113.10', headers: new Headers() };

beforeEach(() => {
  repo = createFakeRepository();
  auth = createFakeAuth();
});

describe('isTestLogin', () => {
  it('matches the number in any format the keypad produces, and no other', () => {
    expect(isTestLogin('0491 570 156')).toBe(true);
    expect(isTestLogin('+61491570156')).toBe(true);
    expect(isTestLogin('0491570157')).toBe(false);
  });
});

describe('pinTestLoginCode', () => {
  it('replaces the stored random code with the fixed one', async () => {
    const rows = new Map<string, string>([[TEST_LOGIN.mobile, '913407:0']]);
    const store = {
      deleteVerificationByIdentifier: (id: string) => Promise.resolve(rows.delete(id)),
      createVerificationValue: (data: { value: string; identifier: string }) =>
        Promise.resolve(rows.set(data.identifier, data.value)),
    };

    await pinTestLoginCode(TEST_LOGIN.mobile, store);

    expect(rows.get(TEST_LOGIN.mobile)).toBe('246810:0');
  });
});

describe('signing in with it', () => {
  it('is never capped, because it sends nothing', async () => {
    repo.addUser({ email: null, mobile: TEST_LOGIN.mobile, role: 'driver' });

    // Past the six an hour every real number is held to.
    for (let i = 0; i < 10; i += 1) {
      await authService.requestCode({ identifier: TEST_LOGIN.mobile }, ctx);
    }

    expect(auth.smsSent).toHaveLength(10);
  });

  // A fixed code on an office or admin account would be a back door.
  it('refuses an account holding any role besides driver, and issues nothing', async () => {
    repo.addUser({
      email: null,
      mobile: TEST_LOGIN.mobile,
      role: 'driver',
      roles: ['driver', 'allocator'],
    });

    await expect(
      authService.requestCode({ identifier: TEST_LOGIN.mobile }, ctx),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(auth.smsSent).toHaveLength(0);
  });

  it('leaves every other number on the normal ceiling', async () => {
    repo.addUser({ email: null, mobile: '0412345678', role: 'driver' });

    for (let i = 0; i < 6; i += 1) {
      await authService.requestCode({ identifier: '0412345678' }, ctx);
    }

    await expect(authService.requestCode({ identifier: '0412345678' }, ctx)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });
});
