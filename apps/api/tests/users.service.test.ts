import type { Role, UserDraft } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeAuditRepository } from './helpers/fake-audit.js';

/**
 * User administration (M1.5).
 *
 * ── What is actually under test ───────────────────────────────────────────
 * Three rules the database cannot express.
 *
 * The one that matters most is the LAST-ADMIN guard: suspending or demoting the
 * only remaining super-admin locks everybody out of user administration, and the
 * only recovery is somebody editing the database by hand.
 *
 * Then scoping — a customer role without an account sees nothing, and one with
 * the wrong account sees somebody else's work — and the fact that a user is
 * never deleted, because their name is frozen onto everything they did.
 */

let created: Array<Record<string, unknown>> = [];
let updated: Array<Record<string, unknown>> = [];
let statusChanges: Array<{ id: string; status: string }> = [];

/** What the repository reports back. Set per test. */
let stored: Record<string, unknown> | null = null;
let identifierTaken = false;
let otherActiveAdmins = 1;
let accountFound = true;

/*
 * M1.6 — this suite's service records to the audit log. Faked like every other
 * repository: the real one would buffer a write against a MongoDB that is not
 * there and time out. See `helpers/fake-audit.ts`.
 */
vi.mock('../src/domains/audit/audit.repository.js', () => ({
  auditRepository: makeFakeAuditRepository(),
}));


vi.mock('../src/domains/users/user.repository.js', () => ({
  userRepository: {
    list: () =>
      Promise.resolve({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } }),
    findById: () => Promise.resolve(stored),
    identifierTaken: () => Promise.resolve(identifierTaken),
    create: (input: Record<string, unknown>) => {
      created.push(input);
      return Promise.resolve('usr-new');
    },
    update: (id: string, input: Record<string, unknown>) => {
      updated.push({ id, ...input });
      return Promise.resolve(true);
    },
    setStatus: (id: string, status: string) => {
      statusChanges.push({ id, status });
      return Promise.resolve(true);
    },
    countActiveWithRole: () => Promise.resolve(otherActiveAdmins),
  },
}));

vi.mock('../src/domains/accounts/account.repository.js', () => ({
  accountRepository: {
    findById: () =>
      Promise.resolve(accountFound ? { id: 'acc1', name: 'Clarendon Homes' } : null),
  },
}));

const { userService } = await import('../src/domains/users/user.service.js');

const SUPER = {
  userId: 'usr0000000000000000000m1',
  name: 'Matthew Browne',
  roles: ['super-admin'] as Role[],
};

const OPERATIONS = {
  userId: 'usr0000000000000000000o1',
  name: 'Renee Alvarez',
  roles: ['operations'] as Role[],
};

const OFFICE = {
  userId: 'usr0000000000000000000f1',
  name: 'Priya Raman',
  roles: ['office-staff'] as Role[],
};

const TARGET = 'a'.repeat(24);

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET,
    name: 'Dean Kelly',
    email: 'dean@plastago.com.au',
    mobile: null,
    role: 'allocator',
    roles: ['allocator'],
    status: 'active',
    brandIds: ['plastago'],
    accountId: null,
    accountName: null,
    lastSignedInAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    jobTitle: 'Driver Manager',
    invitedBy: 'Matthew Browne',
    notes: '',
    devices: [],
    recentSignIns: [],
    ...overrides,
  };
}

function draft(overrides: Partial<UserDraft> = {}): UserDraft {
  return {
    name: 'Sam Farrar',
    email: 'sam@plastago.com.au',
    mobile: '',
    role: 'office-staff',
    additionalRoles: [],
    jobTitle: 'Office Administrator',
    brandIds: ['plastago'],
    accountId: null,
    notes: '',
    ...overrides,
  };
}

beforeEach(() => {
  created = [];
  updated = [];
  statusChanges = [];
  stored = user();
  identifierTaken = false;
  otherActiveAdmins = 1;
  accountFound = true;
});

describe('who may administer users', () => {
  it('lets a super-admin in', async () => {
    await expect(userService.list({ page: 1, pageSize: 20 }, SUPER)).resolves.toBeDefined();
  });

  it('lets operations in', async () => {
    await expect(userService.list({ page: 1, pageSize: 20 }, OPERATIONS)).resolves.toBeDefined();
  });

  /* A driver has no business knowing the office roster. */
  it('keeps office staff out', async () => {
    await expect(userService.list({ page: 1, pageSize: 20 }, OFFICE)).rejects.toMatchObject({
      status: 403,
    });
  });

  /*
   * Operations administers users, but handing out the role that can remove your
   * own is a different power.
   */
  it('refuses operations granting super-admin', async () => {
    await expect(
      userService.create(draft({ role: 'super-admin' }), OPERATIONS),
    ).rejects.toMatchObject({ status: 403 });

    expect(created).toHaveLength(0);
  });

  it('allows a super-admin to grant it', async () => {
    await expect(userService.create(draft({ role: 'super-admin' }), SUPER)).resolves.toBeDefined();
  });
});

describe('⚠️ the last-admin guard', () => {
  /*
   * The rule this file exists for. Locking everybody out of user administration
   * has no in-product recovery — it needs somebody editing the database.
   */
  it('refuses to suspend the only active super-admin', async () => {
    stored = user({ roles: ['super-admin'], role: 'super-admin' });
    otherActiveAdmins = 0;

    await expect(userService.setStatus(TARGET, 'suspended', SUPER)).rejects.toMatchObject({
      status: 409,
    });

    expect(statusChanges).toHaveLength(0);
  });

  it('allows it when another active super-admin remains', async () => {
    stored = user({ roles: ['super-admin'], role: 'super-admin' });
    otherActiveAdmins = 1;

    await expect(userService.setStatus(TARGET, 'suspended', SUPER)).resolves.toBeDefined();
  });

  /* The same guard on the ROLE path — demoting is as fatal as suspending. */
  it('refuses to demote the only active super-admin', async () => {
    stored = user({ roles: ['super-admin'], role: 'super-admin' });
    otherActiveAdmins = 0;

    await expect(
      userService.update(TARGET, draft({ role: 'office-staff' }), SUPER),
    ).rejects.toMatchObject({ status: 409 });

    expect(updated).toHaveLength(0);
  });

  it('allows an edit that keeps the role', async () => {
    stored = user({ roles: ['super-admin'], role: 'super-admin' });
    otherActiveAdmins = 0;

    // Not a demotion — the guard must not fire on an unrelated change.
    await expect(
      userService.update(TARGET, draft({ role: 'super-admin', jobTitle: 'Director' }), SUPER),
    ).resolves.toBeDefined();
  });

  it('refuses to suspend your own login', async () => {
    stored = user({ id: SUPER.userId });

    await expect(userService.setStatus(SUPER.userId, 'suspended', SUPER)).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('customer roles must carry an account', () => {
  /*
   * ⚠️ The portal's whole boundary is this field. Without it a supervisor sees
   * nothing; with the wrong one they see somebody else's work.
   */
  it('refuses a supervisor with no account', async () => {
    await expect(
      userService.create(
        draft({ role: 'customer-site-supervisor', accountId: null, mobile: '0400111222' }),
        SUPER,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses an office role WITH an account', async () => {
    await expect(
      userService.create(draft({ role: 'office-staff', accountId: 'acc1' }), SUPER),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses an account that does not exist', async () => {
    accountFound = false;

    await expect(
      userService.create(
        draft({ role: 'customer-administrator', accountId: 'acc-missing' }),
        SUPER,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  /*
   * An office view is unscoped and wins everywhere, so the account would
   * silently stop meaning anything.
   */
  it('refuses mixing a customer role with an office one', async () => {
    await expect(
      userService.create(
        draft({
          role: 'customer-administrator',
          additionalRoles: ['office-staff'],
          accountId: 'acc1',
        }),
        SUPER,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('accepts a customer administrator with an account', async () => {
    await expect(
      userService.create(draft({ role: 'customer-administrator', accountId: 'acc1' }), SUPER),
    ).resolves.toBeDefined();
  });
});

describe('identifiers', () => {
  it('accepts an email with no mobile', async () => {
    await userService.create(draft({ mobile: '' }), SUPER);

    expect(created[0]).toMatchObject({ email: 'sam@plastago.com.au', mobile: null });
  });

  /* Most site supervisors have a phone and no work email (§9). */
  it('accepts a mobile with no email', async () => {
    await userService.create(
      draft({ email: '', mobile: '0400111222', role: 'driver' }),
      SUPER,
    );

    expect(created[0]).toMatchObject({ mobile: '0400111222', email: null });
  });

  it('refuses neither', async () => {
    await expect(
      userService.create(draft({ email: '', mobile: '' }), SUPER),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses an identifier somebody else already has', async () => {
    identifierTaken = true;

    await expect(userService.create(draft(), SUPER)).rejects.toMatchObject({ status: 409 });
    expect(created).toHaveLength(0);
  });

  it('lowercases the email so one person cannot have two logins', async () => {
    await userService.create(draft({ email: 'Sam@PlastaGo.com.AU' }), SUPER);

    expect(created[0]?.email).toBe('sam@plastago.com.au');
  });
});

describe('roles', () => {
  /* Matt, 27:01 — an allocator who covers a driver's shift holds both. */
  it('keeps the main role and merges the extras', async () => {
    await userService.create(
      draft({ role: 'allocator', additionalRoles: ['driver'] }),
      SUPER,
    );

    expect(created[0]?.role).toBe('allocator');
    expect(created[0]?.roles).toEqual(['allocator', 'driver']);
  });

  it('does not duplicate a role listed twice', async () => {
    await userService.create(
      draft({ role: 'allocator', additionalRoles: ['allocator'] }),
      SUPER,
    );

    expect(created[0]?.roles).toEqual(['allocator']);
  });
});

describe('creating and inviting', () => {
  /*
   * Somebody who has never signed in has not proved they can be reached. An
   * active-looking row hides the invitations that silently failed.
   */
  it('never creates a user as active', async () => {
    await userService.create(draft(), SUPER);

    // The service passes no status; the repository forces `invited`.
    expect(created[0]).not.toHaveProperty('status');
  });

  it('records who invited them', async () => {
    await userService.create(draft(), SUPER);

    expect(created[0]?.invitedBy).toBe('Matthew Browne');
  });

  it('re-invites somebody who has never signed in', async () => {
    stored = user({ status: 'invited', lastSignedInAt: null });

    await expect(userService.resendInvite(TARGET, SUPER)).resolves.toBeUndefined();
  });

  /*
   * A sign-in link nobody asked for is indistinguishable from phishing, from
   * the recipient's point of view.
   */
  it('refuses to re-invite somebody who has already signed in', async () => {
    stored = user({ lastSignedInAt: '2026-09-01T00:00:00.000Z' });

    await expect(userService.resendInvite(TARGET, SUPER)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses to re-invite a suspended user', async () => {
    stored = user({ status: 'suspended', lastSignedInAt: null });

    await expect(userService.resendInvite(TARGET, SUPER)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses to re-invite somebody with no way to reach them', async () => {
    stored = user({ email: null, mobile: null, lastSignedInAt: null });

    await expect(userService.resendInvite(TARGET, SUPER)).rejects.toMatchObject({ status: 409 });
  });
});

describe('status changes', () => {
  it('suspends and reactivates', async () => {
    await userService.setStatus(TARGET, 'suspended', SUPER);

    expect(statusChanges[0]).toEqual({ id: TARGET, status: 'suspended' });
  });

  it('says so when the status is already what was asked for', async () => {
    stored = user({ status: 'active' });

    await expect(userService.setStatus(TARGET, 'active', SUPER)).rejects.toMatchObject({
      status: 409,
    });
  });

  /*
   * ⚠️ `status` is not reachable from the edit path. Folding them together
   * would let a routine correction suspend somebody by accident.
   */
  it('does not change status through an edit', async () => {
    await userService.update(TARGET, draft({ jobTitle: 'New title' }), SUPER);

    expect(updated[0]).not.toHaveProperty('status');
    expect(statusChanges).toHaveLength(0);
  });

  it('404s a user who does not exist', async () => {
    stored = null;

    await expect(userService.setStatus(TARGET, 'suspended', SUPER)).rejects.toMatchObject({
      status: 404,
    });
  });
});
