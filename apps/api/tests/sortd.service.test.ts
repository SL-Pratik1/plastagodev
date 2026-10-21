import { ROLES, ROLE_SURFACE, type Role } from '@plastago/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Sortd session broker — which app, which role, which tenant, and the
 * cache rules in front of the vendor.
 *
 * ── Why the real Sortd is unreachable from this file ──────────────────────
 * `env` is replaced wholesale, so the keys in a developer's `.env` are never
 * read, and the base URL is a `.invalid` host that cannot resolve. `fetch` is
 * stubbed, and the stub FAILS THE TEST if anything asks for another host —
 * so a refactor that bypasses the client is caught rather than sent.
 */

const FAKE_BASE = 'https://sortd.test.invalid';
const KEYS = {
  admin: 'sk_app_admin_fixture',
  portal: 'sk_app_portal_fixture',
  driver: 'sk_app_driver_fixture',
} as const;

const fakeEnv = vi.hoisted(() => ({
  SORTD_API_KEY_ADMIN: 'sk_app_admin_fixture' as string | undefined,
  SORTD_API_KEY_PORTAL: 'sk_app_portal_fixture' as string | undefined,
  SORTD_API_KEY_DRIVER: 'sk_app_driver_fixture' as string | undefined,
  SORTD_ENABLED: undefined as string | undefined,
}));

vi.mock('../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/env.js')>();
  return {
    ...actual,
    sortdBaseUrl: 'https://sortd.test.invalid',
    env: new Proxy(actual.env, {
      get: (target, key) =>
        typeof key === 'string' && key.startsWith('SORTD_')
          ? (fakeEnv as Record<string, unknown>)[key]
          : Reflect.get(target, key),
    }),
  };
});

/* ── An in-memory repository ──────────────────────────────────────────────── */

interface Row {
  surface: 'admin' | 'portal' | 'driver';
  sessionId: string;
  expiresAt: Date;
  sortdRole: 'user' | 'admin' | 'owner';
  appTenantId: string | null;
}

const store = vi.hoisted(() => ({
  sessions: new Map<string, Row>(),
  users: new Map<string, { email: string | null; name: string }>(),
  accounts: new Map<string, string>(),
}));

vi.mock('../src/domains/sortd/sortd.repository.js', () => ({
  sortdRepository: {
    findSession: (userId: string, surface: string) =>
      Promise.resolve(store.sessions.get(`${userId}:${surface}`) ?? null),
    saveSession: (input: Row & { userId: string }) => {
      const { userId, ...row } = input;
      store.sessions.set(`${userId}:${row.surface}`, row);
      return Promise.resolve();
    },
    takeAllSessions: (userId: string) => {
      const taken: Row[] = [];
      for (const [key, row] of store.sessions) {
        if (key.startsWith(`${userId}:`)) {
          taken.push(row);
          store.sessions.delete(key);
        }
      }
      return Promise.resolve(taken);
    },
    findIdentity: (userId: string) => Promise.resolve(store.users.get(userId) ?? null),
    findAccountName: (accountId: string) => Promise.resolve(store.accounts.get(accountId) ?? null),
  },
}));

const { accessFor, placeholderEmailFor, sortdService } = await import(
  '../src/domains/sortd/sortd.service.js'
);

/* ── A fetch that only knows the fake Sortd ───────────────────────────────── */

interface Call {
  method: string;
  path: string;
  authorization: string;
  body: Record<string, unknown> | null;
}

let calls: Call[] = [];
let respond: (call: Call) => { status: number; body?: unknown } = () => ({ status: 500 });
let minted = 0;

const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== FAKE_BASE) {
    throw new Error(`Test tried to reach ${url.origin} — only the fake Sortd is allowed`);
  }

  const headers = new Headers(init?.headers);
  const call: Call = {
    method: init?.method ?? 'GET',
    path: url.pathname,
    authorization: headers.get('authorization') ?? '',
    body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
  };
  calls.push(call);

  const { status, body } = respond(call);
  return Promise.resolve(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
});

/** A Sortd that mints, refreshes and revokes like the real one. */
function healthySortd(call: Call) {
  if (call.method === 'POST' && call.path === '/api/embed/sessions') {
    minted += 1;
    return { status: 201, body: { sessionId: `ess_${String(minted)}`, expiresAt: inHours(24) } };
  }
  if (call.method === 'PUT' && call.path.endsWith('/refresh')) {
    const id = decodeURIComponent(call.path.split('/')[4] ?? '');
    return { status: 200, body: { sessionId: id, expiresAt: inHours(24) } };
  }
  if (call.method === 'DELETE') return { status: 200, body: { ok: true } };
  return { status: 404 };
}

function inHours(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

const USER = '64b000000000000000000001';
const ACCOUNT = '64b0000000000000000000a1';

beforeEach(() => {
  calls = [];
  minted = 0;
  respond = healthySortd;
  store.sessions.clear();
  store.users.clear();
  store.accounts.clear();
  store.users.set(USER, { email: 'pat@builder.com.au', name: 'Pat Builder' });
  store.accounts.set(ACCOUNT, 'Clarendon Homes');
  fakeEnv.SORTD_API_KEY_ADMIN = KEYS.admin;
  fakeEnv.SORTD_API_KEY_PORTAL = KEYS.portal;
  fakeEnv.SORTD_API_KEY_DRIVER = KEYS.driver;
  fakeEnv.SORTD_ENABLED = undefined;
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ── Roles ────────────────────────────────────────────────────────────────── */

describe('accessFor — every PlastaGo role', () => {
  const expected: Record<Role, { sortdRole: string; tenant: boolean }> = {
    'super-admin': { sortdRole: 'owner', tenant: false },
    operations: { sortdRole: 'user', tenant: false },
    'office-staff': { sortdRole: 'user', tenant: false },
    allocator: { sortdRole: 'user', tenant: false },
    driver: { sortdRole: 'user', tenant: false },
    'customer-administrator': { sortdRole: 'admin', tenant: true },
    'customer-site-supervisor': { sortdRole: 'user', tenant: true },
  };

  it.each(ROLES.map((role) => [role]))('%s', (role) => {
    const access = accessFor({ userId: USER, role, accountId: ACCOUNT });

    expect(access.sortdRole).toBe(expected[role].sortdRole);
    expect(access.appTenantId).toBe(expected[role].tenant ? ACCOUNT : null);
    expect(access.surface).toBe(ROLE_SURFACE[role]);
  });

  it('never grants admin without a tenant', () => {
    for (const role of ROLES) {
      try {
        const access = accessFor({ userId: USER, role, accountId: null });
        if (access.sortdRole === 'admin') expect.fail(`${role} got admin with no tenant`);
      } catch (error) {
        expect((error as { status?: number }).status).toBe(403);
      }
    }
  });

  it('refuses a customer administrator with no account', () => {
    expect(() =>
      accessFor({ userId: USER, role: 'customer-administrator', accountId: null }),
    ).toThrow(/needs an account/);
  });

  it('gives staff no tenant even when an account id is on the record', () => {
    expect(accessFor({ userId: USER, role: 'operations', accountId: ACCOUNT }).appTenantId).toBe(
      null,
    );
  });
});

/* ── Minting ──────────────────────────────────────────────────────────────── */

describe('sessionFor', () => {
  it('mints with the key for the caller’s surface', async () => {
    const cases: Array<[Role, keyof typeof KEYS]> = [
      ['office-staff', 'admin'],
      ['customer-site-supervisor', 'portal'],
      ['driver', 'driver'],
    ];

    for (const [role, surface] of cases) {
      calls = [];
      store.sessions.clear();
      await sortdService.sessionFor({ userId: USER, role, accountId: ACCOUNT });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.authorization).toBe(`Bearer ${KEYS[surface]}`);
    }
  });

  it('sends a customer administrator as admin of their own account', async () => {
    await sortdService.sessionFor({ userId: USER, role: 'customer-administrator', accountId: ACCOUNT });

    expect(calls[0]?.body).toEqual({
      externalUserId: USER,
      email: 'pat@builder.com.au',
      name: 'Pat Builder',
      role: 'admin',
      appTenantId: ACCOUNT,
      appTenantName: 'Clarendon Homes',
    });
  });

  it('sends the super-admin as owner, with no tenant', async () => {
    await sortdService.sessionFor({ userId: USER, role: 'super-admin', accountId: null });

    expect(calls[0]?.body).toMatchObject({ role: 'owner' });
    expect(calls[0]?.body).not.toHaveProperty('appTenantId');
  });

  it('gives a driver with no email an undeliverable placeholder', async () => {
    store.users.set(USER, { email: null, name: 'Troy Holm' });

    await sortdService.sessionFor({ userId: USER, role: 'driver', accountId: null });

    expect(calls[0]?.body?.email).toBe(placeholderEmailFor(USER));
    expect(String(calls[0]?.body?.email)).toMatch(/\.invalid$/);
  });

  it('reuses a cached session with time left — no call to Sortd', async () => {
    const first = await sortdService.sessionFor({ userId: USER, role: 'driver', accountId: null });
    calls = [];

    const second = await sortdService.sessionFor({ userId: USER, role: 'driver', accountId: null });

    expect(second).toEqual(first);
    expect(calls).toHaveLength(0);
  });

  it('extends a session near expiry instead of replacing it', async () => {
    store.sessions.set(`${USER}:driver`, {
      surface: 'driver',
      sessionId: 'ess_old',
      expiresAt: new Date(Date.now() + 60_000),
      sortdRole: 'user',
      appTenantId: null,
    });

    const session = await sortdService.sessionFor({ userId: USER, role: 'driver', accountId: null });

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'PUT /api/embed/sessions/ess_old/refresh',
    ]);
    expect(session?.sessionId).toBe('ess_old');
    expect(store.sessions.get(`${USER}:driver`)?.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + 23 * 3_600_000,
    );
  });

  it('mints afresh when Sortd refuses the refresh', async () => {
    store.sessions.set(`${USER}:driver`, {
      surface: 'driver',
      sessionId: 'ess_gone',
      expiresAt: new Date(Date.now() + 60_000),
      sortdRole: 'user',
      appTenantId: null,
    });
    respond = (call) => (call.method === 'PUT' ? { status: 404 } : healthySortd(call));

    const session = await sortdService.sessionFor({ userId: USER, role: 'driver', accountId: null });

    expect(calls.map((call) => call.method)).toEqual(['PUT', 'POST']);
    expect(session?.sessionId).toBe('ess_1');
  });

  it('replaces AND revokes a session minted as a role the caller no longer has', async () => {
    // Minted while they were a customer administrator…
    store.sessions.set(`${USER}:portal`, {
      surface: 'portal',
      sessionId: 'ess_admin',
      expiresAt: new Date(Date.now() + 20 * 3_600_000),
      sortdRole: 'admin',
      appTenantId: ACCOUNT,
    });

    // …and now they are a site supervisor.
    const session = await sortdService.sessionFor({
      userId: USER,
      role: 'customer-site-supervisor',
      accountId: ACCOUNT,
    });

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'DELETE /api/embed/sessions/ess_admin',
      'POST /api/embed/sessions',
    ]);
    expect(calls[1]?.body?.role).toBe('user');
    expect(session?.sessionId).toBe('ess_1');
    expect(store.sessions.get(`${USER}:portal`)?.sortdRole).toBe('user');
  });

  it('replaces a session minted for another account', async () => {
    store.sessions.set(`${USER}:portal`, {
      surface: 'portal',
      sessionId: 'ess_old_account',
      expiresAt: new Date(Date.now() + 20 * 3_600_000),
      sortdRole: 'admin',
      appTenantId: '64b0000000000000000000ff',
    });

    await sortdService.sessionFor({ userId: USER, role: 'customer-administrator', accountId: ACCOUNT });

    expect(calls.map((call) => call.method)).toEqual(['DELETE', 'POST']);
    expect(store.sessions.get(`${USER}:portal`)?.appTenantId).toBe(ACCOUNT);
  });

  it('keeps one session per surface for someone covering a shift', async () => {
    await sortdService.sessionFor({ userId: USER, role: 'allocator', accountId: null });
    await sortdService.sessionFor({ userId: USER, role: 'driver', accountId: null });

    expect([...store.sessions.keys()].sort()).toEqual([`${USER}:admin`, `${USER}:driver`]);
    expect(calls.map((call) => call.authorization)).toEqual([
      `Bearer ${KEYS.admin}`,
      `Bearer ${KEYS.driver}`,
    ]);
  });

  it('returns null, and calls nobody, for a surface with no key', async () => {
    fakeEnv.SORTD_API_KEY_DRIVER = undefined;

    expect(sortdService.enabledFor({ userId: USER, role: 'driver', accountId: null })).toBe(false);
    expect(await sortdService.sessionFor({ userId: USER, role: 'driver', accountId: null })).toBe(
      null,
    );
    // The other surfaces are unaffected.
    expect(sortdService.enabledFor({ userId: USER, role: 'office-staff', accountId: null })).toBe(
      true,
    );
    expect(calls).toHaveLength(0);
  });

  it('returns null everywhere when SORTD_ENABLED=false, keys and all', async () => {
    fakeEnv.SORTD_ENABLED = 'false';

    for (const role of ROLES) {
      expect(sortdService.enabledFor({ userId: USER, role, accountId: ACCOUNT })).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it('throws when Sortd refuses the mint, without the key in the message', async () => {
    respond = () => ({ status: 401, body: { error: 'bad key sk_app_driver_fixture' } });

    const failure = sortdService.sessionFor({ userId: USER, role: 'driver', accountId: null });

    await expect(failure).rejects.toThrow(/failed: 401/);
    await failure.catch((error: Error) => {
      expect(error.message).not.toContain('sk_app_');
    });
    expect(store.sessions.size).toBe(0);
  });

  it('throws on a session in an unexpected shape rather than caching it', async () => {
    respond = () => ({ status: 201, body: { id: 'ess_1' } });

    await expect(
      sortdService.sessionFor({ userId: USER, role: 'driver', accountId: null }),
    ).rejects.toThrow(/unexpected shape/);
    expect(store.sessions.size).toBe(0);
  });
});

/* ── Sign-out ─────────────────────────────────────────────────────────────── */

describe('revoke', () => {
  it('deletes every surface’s session and revokes each with its own key', async () => {
    await sortdService.sessionFor({ userId: USER, role: 'allocator', accountId: null });
    await sortdService.sessionFor({ userId: USER, role: 'driver', accountId: null });
    calls = [];

    await sortdService.revoke(USER);

    expect(store.sessions.size).toBe(0);
    expect(
      calls.map((call) => `${call.method} ${call.path} ${call.authorization}`).sort(),
    ).toEqual(
      [
        `DELETE /api/embed/sessions/ess_1 Bearer ${KEYS.admin}`,
        `DELETE /api/embed/sessions/ess_2 Bearer ${KEYS.driver}`,
      ].sort(),
    );
  });

  it('still deletes locally when Sortd cannot be reached', async () => {
    await sortdService.sessionFor({ userId: USER, role: 'driver', accountId: null });
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error('ECONNRESET')));

    await expect(sortdService.revoke(USER)).resolves.toBeUndefined();
    expect(store.sessions.size).toBe(0);
  });

  it('is a no-op for someone with no session', async () => {
    await sortdService.revoke(USER);
    expect(calls).toHaveLength(0);
  });
});
