import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two Sortd routes over HTTP, through the real `createServer()` — so the
 * mount order that keeps the webhook body raw is under test, not assumed.
 *
 * Never reaches the real Sortd: `env` is replaced (fixture keys, a `.invalid`
 * host) and `fetch` fails the test for any other host. Mongo is replaced by an
 * in-memory repository; the bell and the email by spies.
 */

const FAKE_BASE = 'https://sortd.test.invalid';
const SECRETS = {
  driver: 'driver-webhook-secret-fixture-000000',
  portal: 'portal-webhook-secret-fixture-000000',
} as const;

const fakeEnv = vi.hoisted(() => ({
  SORTD_API_KEY_ADMIN: undefined as string | undefined,
  SORTD_API_KEY_PORTAL: 'sk_app_portal_fixture' as string | undefined,
  SORTD_API_KEY_DRIVER: 'sk_app_driver_fixture' as string | undefined,
  SORTD_WEBHOOK_SECRET_ADMIN: undefined as string | undefined,
  SORTD_WEBHOOK_SECRET_PORTAL: 'portal-webhook-secret-fixture-000000' as string | undefined,
  SORTD_WEBHOOK_SECRET_DRIVER: 'driver-webhook-secret-fixture-000000' as string | undefined,
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

/*
 * `requireAuth` reads a session from Mongo. Here the caller is whoever the
 * `x-test-*` headers say — the routes are under test, not the sign-in.
 */
vi.mock('../src/middleware/require-auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/middleware/require-auth.js')>();
  const { AppError } = await import('../src/lib/app-error.js');
  return {
    ...actual,
    requireAuth: (
      req: import('express').Request,
      _res: import('express').Response,
      next: import('express').NextFunction,
    ) => {
      const userId = req.get('x-test-user');
      if (!userId) {
        next(AppError.unauthenticated('Sign in to continue'));
        return;
      }
      const role = req.get('x-test-role') ?? 'driver';
      req.auth = {
        userId,
        name: 'Test Person',
        role,
        roles: [role],
        accountId: req.get('x-test-account') ?? null,
      };
      next();
    },
  };
});

const store = vi.hoisted(() => ({
  sessions: new Map<string, Record<string, unknown>>(),
  claimed: new Set<string>(),
  released: [] as string[],
  claimFails: false,
}));

vi.mock('../src/domains/sortd/sortd.repository.js', () => ({
  sortdRepository: {
    findSession: (userId: string, surface: string) =>
      Promise.resolve(store.sessions.get(`${userId}:${surface}`) ?? null),
    saveSession: (input: { userId: string; surface: string }) => {
      const { userId, ...row } = input;
      store.sessions.set(`${userId}:${row.surface}`, row);
      return Promise.resolve();
    },
    takeAllSessions: (userId: string) => {
      const taken = [...store.sessions.entries()]
        .filter(([key]) => key.startsWith(`${userId}:`))
        .map(([key, row]) => {
          store.sessions.delete(key);
          return row;
        });
      return Promise.resolve(taken);
    },
    findIdentity: () => Promise.resolve({ email: null, name: 'Troy Holm' }),
    findAccountName: () => Promise.resolve('Clarendon Homes'),
    claimWebhookEvent: (key: string) => {
      if (store.claimFails) return Promise.reject(new Error('connection refused'));
      if (store.claimed.has(key)) return Promise.resolve(false);
      store.claimed.add(key);
      return Promise.resolve(true);
    },
    releaseWebhookEvent: (key: string) => {
      store.released.push(key);
      store.claimed.delete(key);
      return Promise.resolve();
    },
  },
}));

const spies = vi.hoisted(() => ({
  notifyOffice: vi.fn(),
  send: vi.fn(),
}));

vi.mock('../src/domains/notifications/notification.service.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/domains/notifications/notification.service.js')>();
  return {
    ...actual,
    notificationService: { ...actual.notificationService, notifyOffice: spies.notifyOffice },
  };
});

vi.mock('../src/domains/notifications/outbound.service.js', () => ({
  outboundService: { send: spies.send },
}));

const { createServer } = await import('../src/server.js');
const app = createServer();

/* ── The fake Sortd ───────────────────────────────────────────────────────── */

let fetchCalls: Array<{ method: string; path: string }> = [];
let sortdStatus = 201;

const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== FAKE_BASE) {
    throw new Error(`Test tried to reach ${url.origin} — only the fake Sortd is allowed`);
  }
  fetchCalls.push({ method: init?.method ?? 'GET', path: url.pathname });

  if (sortdStatus >= 400) return Promise.resolve(new Response(null, { status: sortdStatus }));

  return Promise.resolve(
    Response.json(
      { sessionId: 'ess_fixture', expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      { status: sortdStatus },
    ),
  );
});

beforeEach(() => {
  store.sessions.clear();
  store.claimed.clear();
  store.released = [];
  store.claimFails = false;
  fetchCalls = [];
  sortdStatus = 201;
  spies.notifyOffice.mockReset();
  spies.notifyOffice.mockResolvedValue([
    { id: 'u-admin-1', name: 'Matt', email: 'matt@plastago.com.au', roles: ['super-admin'] },
    { id: 'u-admin-2', name: 'No Email', email: null, roles: ['super-admin'] },
  ]);
  spies.send.mockReset();
  spies.send.mockResolvedValue({ outcome: 'sent', channel: 'email', toMasked: 'm***', detail: null });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ── Webhook helpers ──────────────────────────────────────────────────────── */

const TICKET = {
  event: 'ticket.created',
  timestamp: '2026-10-16T02:00:00Z',
  ticket: {
    id: '6650aaaa',
    displayId: 'PLA-0042',
    reason: 'user_requested',
    summary: 'Driver cannot find the <script>tip-off</script> button',
    reportedFrom: { url: '/driver/tip-off', label: 'Tip-off' },
  },
  conversation: { id: '6651bbbb', summary: 'Asked where tip-off is.' },
};

function signed(surface: string, body: string, secret: string, timestamp = nowSeconds()) {
  return request(app)
    .post(`/api/v1/webhooks/sortd/${surface}`)
    .set('content-type', 'application/json')
    .set('x-sortd-timestamp', timestamp)
    .set('x-sortd-signature', createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'))
    .send(body);
}

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

/* ── Webhook ──────────────────────────────────────────────────────────────── */

describe('POST /api/v1/webhooks/sortd/:surface', () => {
  it('announces a new ticket to the super-admins — bell and email', async () => {
    const body = JSON.stringify(TICKET);
    const response = await signed('driver', body, SECRETS.driver).expect(200);

    expect(response.body).toEqual({ ok: true });
    expect(spies.notifyOffice).toHaveBeenCalledTimes(1);
    expect(spies.notifyOffice.mock.calls[0]?.[0]).toMatchObject({
      audience: 'support',
      category: 'system',
      severity: 'action',
      title: 'Support ticket PLA-0042 from the driver app',
      subjectKey: 'sortd-ticket:driver:6650aaaa',
      href: '/admin/notifications',
    });

    // One email, to the one super-admin with an address.
    expect(spies.send).toHaveBeenCalledTimes(1);
    const sent = spies.send.mock.calls[0]?.[0] as {
      subjectKey: string;
      recipient: { email: string };
      email: (to: string) => { subject: string; html: string; text: string };
    };
    expect(sent.subjectKey).toBe('sortd-ticket:driver:6650aaaa:u-admin-1');
    expect(sent.recipient.email).toBe('matt@plastago.com.au');

    const email = sent.email('matt@plastago.com.au');
    expect(email.subject).toBe('Support ticket PLA-0042 — the driver app');
    expect(email.text).toContain('the person asked for a human');
    expect(email.text).toContain(`Answer it in Sortd: ${FAKE_BASE}`);
    // What the person typed is escaped, never rendered.
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
  });

  it('acknowledges a retry of the same delivery without announcing it twice', async () => {
    const body = JSON.stringify(TICKET);
    await signed('driver', body, SECRETS.driver).expect(200);
    const retry = await signed('driver', body, SECRETS.driver).expect(200);

    expect(retry.body).toEqual({ ok: true, duplicate: true });
    expect(spies.notifyOffice).toHaveBeenCalledTimes(1);
  });

  it('treats the same ticket id on two surfaces as two tickets', async () => {
    const body = JSON.stringify(TICKET);
    await signed('driver', body, SECRETS.driver).expect(200);
    await signed('portal', body, SECRETS.portal).expect(200);

    expect(spies.notifyOffice).toHaveBeenCalledTimes(2);
    expect(spies.notifyOffice.mock.calls[1]?.[0]).toMatchObject({
      title: 'Support ticket PLA-0042 from the customer portal',
    });
  });

  it('refuses a delivery signed with another surface’s secret', async () => {
    const response = await signed('driver', JSON.stringify(TICKET), SECRETS.portal).expect(401);

    // The reason stays in the log; the caller learns nothing.
    expect(response.body).toEqual({ error: 'unauthorized' });
    expect(spies.notifyOffice).not.toHaveBeenCalled();
  });

  it('refuses every delivery to a surface with no secret', async () => {
    await signed('admin', JSON.stringify(TICKET), '').expect(401);
    await signed('admin', JSON.stringify(TICKET), SECRETS.driver).expect(401);
    expect(spies.notifyOffice).not.toHaveBeenCalled();
  });

  it('refuses an unsigned delivery', async () => {
    await request(app)
      .post('/api/v1/webhooks/sortd/driver')
      .set('content-type', 'application/json')
      .send(JSON.stringify(TICKET))
      .expect(401);
  });

  it('refuses a stale timestamp', async () => {
    const old = String(Math.floor(Date.now() / 1000) - 600);
    await signed('driver', JSON.stringify(TICKET), SECRETS.driver, old).expect(401);
  });

  it('404s an unknown surface rather than guessing a secret', async () => {
    await signed('console', JSON.stringify(TICKET), SECRETS.driver).expect(404);
  });

  it('verifies the raw bytes whatever the content type', async () => {
    const body = JSON.stringify(TICKET);
    const timestamp = nowSeconds();
    await request(app)
      .post('/api/v1/webhooks/sortd/driver')
      .set('content-type', 'text/plain')
      .set('x-sortd-timestamp', timestamp)
      .set(
        'x-sortd-signature',
        createHmac('sha256', SECRETS.driver).update(`${timestamp}.${body}`).digest('hex'),
      )
      .send(body)
      .expect(200);
  });

  it('preserves whitespace — a body the JSON parser would rewrite still verifies', async () => {
    const body = JSON.stringify(TICKET, null, 2);
    await signed('driver', body, SECRETS.driver).expect(200);
    expect(spies.notifyOffice).toHaveBeenCalledTimes(1);
  });

  it('400s a signed body that is not JSON', async () => {
    const response = await signed('driver', 'not json', SECRETS.driver).expect(400);
    expect(response.body).toEqual({ error: 'invalid_json' });
  });

  it('acknowledges other events without acting or recording them', async () => {
    for (const event of ['ticket.updated', 'ticket.resolved', 'conversation.resolved', 'backlog_item.released']) {
      await signed('driver', JSON.stringify({ ...TICKET, event }), SECRETS.driver).expect(200);
    }
    expect(spies.notifyOffice).not.toHaveBeenCalled();
    expect(store.claimed.size).toBe(0);
  });

  it('answers 5xx when the delivery cannot be recorded, so Sortd retries', async () => {
    store.claimFails = true;
    await signed('driver', JSON.stringify(TICKET), SECRETS.driver).expect(500);
    expect(spies.notifyOffice).not.toHaveBeenCalled();
  });

  it('gives the claim back when announcing fails, so the retry is not a "duplicate"', async () => {
    spies.notifyOffice.mockRejectedValueOnce(new Error('boom'));
    const body = JSON.stringify(TICKET);

    await signed('driver', body, SECRETS.driver).expect(500);
    expect(store.released).toEqual(['driver:ticket.created:6650aaaa']);

    await signed('driver', body, SECRETS.driver).expect(200);
    expect(spies.notifyOffice).toHaveBeenCalledTimes(2);
  });

  it('dedupes a ticket with no id on its body', async () => {
    const body = JSON.stringify({ event: 'ticket.created', ticket: { summary: 'No id here' } });
    await signed('driver', body, SECRETS.driver).expect(200);
    const retry = await signed('driver', body, SECRETS.driver).expect(200);

    expect(retry.body).toEqual({ ok: true, duplicate: true });
    expect(spies.notifyOffice.mock.calls[0]?.[0]).toMatchObject({
      title: 'New support ticket from the driver app',
      body: 'No id here',
    });
  });
});

/* ── Session ──────────────────────────────────────────────────────────────── */

describe('GET /api/v1/sortd/session', () => {
  const USER = '64b000000000000000000001';

  it('requires a session', async () => {
    await request(app).get('/api/v1/sortd/session').expect(401);
    expect(fetchCalls).toHaveLength(0);
  });

  it('hands the browser a session id and nothing secret', async () => {
    const response = await request(app)
      .get('/api/v1/sortd/session')
      .set('x-test-user', USER)
      .set('x-test-role', 'driver')
      .expect(200);

    expect(response.body).toEqual({
      enabled: true,
      baseUrl: FAKE_BASE,
      sessionId: 'ess_fixture',
      expiresAt: expect.any(String) as string,
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(response.body)).not.toContain('sk_app_');
  });

  it('says disabled — and calls nobody — for a surface with no key', async () => {
    const response = await request(app)
      .get('/api/v1/sortd/session')
      .set('x-test-user', USER)
      .set('x-test-role', 'office-staff')
      .expect(200);

    expect(response.body).toEqual({ enabled: false });
    expect(fetchCalls).toHaveLength(0);
  });

  it('degrades a Sortd failure to "no bubble", never an error', async () => {
    sortdStatus = 503;
    const response = await request(app)
      .get('/api/v1/sortd/session')
      .set('x-test-user', USER)
      .set('x-test-role', 'driver')
      .expect(200);

    expect(response.body).toEqual({ enabled: false });
  });

  it('shows no bubble to a customer administrator with no account', async () => {
    const response = await request(app)
      .get('/api/v1/sortd/session')
      .set('x-test-user', USER)
      .set('x-test-role', 'customer-administrator')
      .expect(200);

    expect(response.body).toEqual({ enabled: false });
    expect(fetchCalls).toHaveLength(0);
  });

  it('ignores any identity in the query string', async () => {
    await request(app)
      .get('/api/v1/sortd/session?userId=64b0000000000000000000ff&role=super-admin')
      .set('x-test-user', USER)
      .set('x-test-role', 'driver')
      .expect(200);

    expect([...store.sessions.keys()]).toEqual([`${USER}:driver`]);
  });
});

describe('DELETE /api/v1/sortd/session', () => {
  const USER = '64b000000000000000000001';

  it('revokes the caller’s session, here and at Sortd', async () => {
    await request(app)
      .get('/api/v1/sortd/session')
      .set('x-test-user', USER)
      .set('x-test-role', 'driver')
      .expect(200);
    fetchCalls = [];

    await request(app)
      .delete('/api/v1/sortd/session')
      .set('x-test-user', USER)
      .set('x-test-role', 'driver')
      .expect(204);

    expect(store.sessions.size).toBe(0);
    expect(fetchCalls).toEqual([{ method: 'DELETE', path: '/api/embed/sessions/ess_fixture' }]);
  });

  it('requires a session', async () => {
    await request(app).delete('/api/v1/sortd/session').expect(401);
  });
});
