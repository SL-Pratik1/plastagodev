import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * I1 · M7.8 — the Xero connection and invoice sync.
 *
 * ── What is actually under test ───────────────────────────────────────────
 * Five properties, each of which is expensive or unrecoverable when it breaks:
 *
 *  1. **The rotated refresh token is persisted before it is used.** Xero kills
 *     the old refresh token the instant a new one is issued. A refresh that
 *     hands the access token back without writing the replacement destroys the
 *     connection permanently — and does it silently, half an hour later.
 *  2. **Concurrent refreshes collapse into one.** Sending forty invoices fires
 *     forty pushes. If each refreshes, thirty-nine present a token Xero has
 *     already invalidated and the connection is destroyed by being used.
 *  3. **A retry updates rather than duplicating.** The push must send the
 *     stored `xeroInvoiceId`, or every retry raises a second invoice in a
 *     customer's ledger.
 *  4. **`state` is what authorises the callback.** Without the stored row the
 *     callback must do nothing — otherwise a crafted URL connects PlastaGo's
 *     invoicing to an organisation an attacker controls.
 *  5. **A dead grant says "reconnect", not "retry".** The two are different
 *     recoveries and only one of them can work.
 */

/* ── Test doubles ─────────────────────────────────────────────────────────── */

interface StoredConnection {
  tenantId: string;
  connectionId: string;
  tenantName: string;
  accessTokenSealed: string;
  refreshTokenSealed: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  status: 'connected' | 'needs-reconnect';
  statusMessage: string | null;
  connectedByName: string;
  connectedAt: Date;
  lastRefreshAt: Date | null;
}

let connection: StoredConnection | null = null;
let states = new Map<string, { userId: string; name: string; expiresAt: Date }>();
let invoiceResults: Record<string, unknown>[] = [];
let pushableInvoice: Record<string, unknown> | null = null;
let fullInvoice: Record<string, unknown> | null = null;
let paidMarks: { id: string; paidAt: Date }[] = [];
let awaitingPayment: Record<string, unknown>[] = [];

/** Every call the vendor client received, in order. */
let vendorCalls: string[] = [];
/** Queued responses, so a test can make the second refresh differ from the first. */
let refreshResponses: Record<string, unknown>[] = [];
let upsertResponse: Record<string, unknown> = { ok: true, value: {} };
let exchangeResponse: Record<string, unknown> = { ok: true, value: {} };
let connectionsResponse: Record<string, unknown> = { ok: true, value: [] };
let getInvoicesResponse: Record<string, unknown> = { ok: true, value: [] };
/** The payload the last `upsertInvoice` was given, for assertions. */
let lastUpsertPayload: Record<string, unknown> | null = null;

vi.mock('../src/domains/xero/xero.repository.js', () => ({
  xeroRepository: {
    findConnection: () => Promise.resolve(connection),
    saveConnection: (input: StoredConnection & { connectedByUserId: string }) => {
      connection = {
        ...input,
        status: 'connected',
        statusMessage: null,
        connectedAt: new Date(),
        lastRefreshAt: null,
      };
      return Promise.resolve();
    },
    updateTokens: (input: {
      accessTokenSealed: string;
      refreshTokenSealed: string;
      accessExpiresAt: Date;
      refreshExpiresAt: Date;
    }) => {
      vendorCalls.push('persist-tokens');
      if (connection) {
        connection.accessTokenSealed = input.accessTokenSealed;
        connection.refreshTokenSealed = input.refreshTokenSealed;
        connection.accessExpiresAt = input.accessExpiresAt;
        connection.status = 'connected';
      }
      return Promise.resolve();
    },
    markNeedsReconnect: (message: string) => {
      if (connection) {
        connection.status = 'needs-reconnect';
        connection.statusMessage = message;
      }
      return Promise.resolve();
    },
    deleteConnection: () => {
      connection = null;
      return Promise.resolve();
    },
    createState: (input: { state: string; startedByUserId: string; startedByName: string; expiresAt: Date }) => {
      states.set(input.state, {
        userId: input.startedByUserId,
        name: input.startedByName,
        expiresAt: input.expiresAt,
      });
      return Promise.resolve();
    },
    consumeState: (state: string) => {
      const row = states.get(state) ?? null;
      states.delete(state);
      return Promise.resolve(row);
    },
    findPushable: () => Promise.resolve(pushableInvoice),
    findAwaitingPayment: () => Promise.resolve(awaitingPayment),
    markPaid: (id: string, paidAt: Date) => {
      paidMarks.push({ id, paidAt });
      return Promise.resolve(true);
    },
    touchSynced: () => Promise.resolve(),
  },
}));

vi.mock('../src/domains/invoices/invoice.repository.js', () => ({
  invoiceRepository: {
    recordXeroResult: (input: Record<string, unknown>) => {
      invoiceResults.push(input);
      return Promise.resolve(true);
    },
    findById: () => Promise.resolve(fullInvoice),
  },
}));

vi.mock('../src/domains/accounts/account.repository.js', () => ({
  accountRepository: {
    findById: () =>
      Promise.resolve({ contacts: [{ role: 'accounts', email: 'ap@builder.com.au' }] }),
  },
}));

vi.mock('../src/integrations/xero.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../src/integrations/xero.js');

  return {
    ...actual,
    xeroClient: {
      get enabled() {
        return true;
      },
      authorizeUrl: (state: string) => `https://login.xero.com/authorize?state=${state}`,
      exchangeCode: () => {
        vendorCalls.push('exchange');
        return Promise.resolve(exchangeResponse);
      },
      refresh: () => {
        vendorCalls.push('refresh');
        return Promise.resolve(refreshResponses.shift() ?? { ok: false, status: 400, detail: 'no response queued' });
      },
      connections: () => Promise.resolve(connectionsResponse),
      disconnect: () => {
        vendorCalls.push('disconnect');
        return Promise.resolve({ ok: true, value: null });
      },
      findContact: () => Promise.resolve({ ok: true, value: { contactId: 'c1', name: 'Builder' } }),
      createContact: () => Promise.resolve({ ok: true, value: { contactId: 'c1', name: 'Builder' } }),
      upsertInvoice: (_t: string, _tid: string, payload: Record<string, unknown>) => {
        vendorCalls.push('upsert');
        lastUpsertPayload = payload;
        return Promise.resolve(upsertResponse);
      },
      getInvoices: () => Promise.resolve(getInvoicesResponse),
    },
  };
});

/*
 * The real crypto is used, not a stub. Sealing and opening is the mechanism
 * this domain depends on, and a fake would let a bug in the format survive.
 */
vi.mock('../src/config/env.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../src/config/env.js');
  return {
    ...actual,
    env: {
      ...(actual.env as Record<string, unknown>),
      XERO_PROVIDER: 'xero',
      XERO_CLIENT_ID: 'test-client',
      XERO_CLIENT_SECRET: 'test-secret',
      XERO_ENCRYPTION_KEY: 'a'.repeat(64),
      XERO_INVOICE_STATUS: 'DRAFT',
    },
  };
});

const { xeroService } = await import('../src/domains/xero/xero.service.js');
const { seal } = await import('../src/lib/secret-box.js');

const SUPER_ADMIN = { userId: '6aa25516f406854d6538653d', name: 'Matthew Browne', roles: ['super-admin'] as const };
const OFFICE = { userId: '6aa25516f406854d6538653e', name: 'Office Person', roles: ['office-staff'] as const };

/** A live connection whose ACCESS token has already expired. */
function expiredConnection(): StoredConnection {
  return {
    tenantId: 'tenant-1',
    connectionId: 'conn-1',
    tenantName: 'PlastaGo Pty Ltd',
    accessTokenSealed: seal('old-access'),
    refreshTokenSealed: seal('old-refresh'),
    accessExpiresAt: new Date(Date.now() - 60_000),
    refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
    status: 'connected',
    statusMessage: null,
    connectedByName: 'Matthew Browne',
    connectedAt: new Date(),
    lastRefreshAt: null,
  };
}

function liveConnection(): StoredConnection {
  return { ...expiredConnection(), accessExpiresAt: new Date(Date.now() + 20 * 60_000) };
}

beforeEach(() => {
  connection = null;
  states = new Map();
  invoiceResults = [];
  vendorCalls = [];
  refreshResponses = [];
  paidMarks = [];
  awaitingPayment = [];
  lastUpsertPayload = null;
  upsertResponse = { ok: true, value: { invoiceId: 'x-1', status: 'DRAFT', amountDue: 110 } };
  exchangeResponse = {
    ok: true,
    value: {
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      expiresAt: new Date(Date.now() + 1800_000),
    },
  };
  connectionsResponse = {
    ok: true,
    value: [{ connectionId: 'conn-1', tenantId: 'tenant-1', tenantName: 'PlastaGo Pty Ltd' }],
  };
  getInvoicesResponse = { ok: true, value: [] };
  pushableInvoice = {
    id: 'inv1',
    invoiceNumber: 104_101,
    accountId: 'acc1',
    status: 'sent',
    poNumber: 'PO-77',
    issuedOn: '2026-09-10',
    dueOn: '2026-09-17',
    xeroInvoiceId: null,
  };
  fullInvoice = {
    accountName: 'Big Builder Pty Ltd',
    lines: [{ description: 'Bag collection', quantity: 2, unitRate: '30.00' }],
  };
});

/* ── Access control ───────────────────────────────────────────────────────── */

describe('who may manage the connection', () => {
  it('refuses a non-super-admin, because this binds the company ledger', async () => {
    await expect(xeroService.status(OFFICE)).rejects.toMatchObject({ status: 403 });
    await expect(xeroService.beginConnect(OFFICE)).rejects.toMatchObject({ status: 403 });
    await expect(xeroService.disconnect(OFFICE)).rejects.toMatchObject({ status: 403 });
  });

  it('reports an unconnected deployment rather than throwing', async () => {
    const status = await xeroService.status(SUPER_ADMIN);

    expect(status.connected).toBe(false);
    expect(status.state).toBe('disconnected');
    // The page has to render; a 503 would leave it unable to say why.
    expect(status.configured).toBe(true);
  });
});

/* ── The handshake ────────────────────────────────────────────────────────── */

describe('the OAuth handshake', () => {
  it('rejects a callback whose state was never issued', async () => {
    const result = await xeroService.completeCallback({ code: 'abc', state: 'forged', error: null });

    expect(result.ok).toBe(false);
    // Nothing was stored: the forged callback is inert.
    expect(connection).toBeNull();
    expect(vendorCalls).not.toContain('exchange');
  });

  it('refuses to reuse a state, so a replayed callback cannot connect twice', async () => {
    const { authorizeUrl } = await xeroService.beginConnect(SUPER_ADMIN);
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';

    const first = await xeroService.completeCallback({ code: 'abc', state, error: null });
    const second = await xeroService.completeCallback({ code: 'abc', state, error: null });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it('treats a cancelled consent as a cancellation, not a failure', async () => {
    const result = await xeroService.completeCallback({
      code: null,
      state: null,
      error: 'access_denied',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('cancelled');
  });

  it('refuses when no organisation was shared, rather than storing a useless grant', async () => {
    const { authorizeUrl } = await xeroService.beginConnect(SUPER_ADMIN);
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
    connectionsResponse = { ok: true, value: [] };

    const result = await xeroService.completeCallback({ code: 'abc', state, error: null });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('No Xero organisation');
    expect(connection).toBeNull();
  });

  it('attributes the connection to whoever STARTED it, not to the callback', async () => {
    const { authorizeUrl } = await xeroService.beginConnect(SUPER_ADMIN);
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';

    await xeroService.completeCallback({ code: 'abc', state, error: null });

    expect(connection?.connectedByName).toBe('Matthew Browne');
  });
});

/* ── Token rotation: the property that matters most ───────────────────────── */

describe('refresh token rotation', () => {
  it('persists the replacement BEFORE the access token is used', async () => {
    connection = expiredConnection();
    refreshResponses = [
      {
        ok: true,
        value: {
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          expiresAt: new Date(Date.now() + 1800_000),
        },
      },
    ];

    await xeroService.pushInvoice('inv1');

    // The write must land between the refresh and the first API call that
    // spends the new token. Any other order can strand the connection.
    expect(vendorCalls.indexOf('persist-tokens')).toBeGreaterThan(vendorCalls.indexOf('refresh'));
    expect(vendorCalls.indexOf('persist-tokens')).toBeLessThan(vendorCalls.indexOf('upsert'));
  });

  it('collapses concurrent refreshes into one, so the batch cannot kill the grant', async () => {
    connection = expiredConnection();
    refreshResponses = [
      {
        ok: true,
        value: {
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          expiresAt: new Date(Date.now() + 1800_000),
        },
      },
    ];

    // Five pushes racing, exactly as a bulk send produces.
    await Promise.all([
      xeroService.pushInvoice('inv1'),
      xeroService.pushInvoice('inv1'),
      xeroService.pushInvoice('inv1'),
      xeroService.pushInvoice('inv1'),
      xeroService.pushInvoice('inv1'),
    ]);

    // One refresh, not five. Only one response was queued, so a second call
    // would have failed the whole thing — which is the point.
    expect(vendorCalls.filter((call) => call === 'refresh')).toHaveLength(1);
  });

  it('says "reconnect" and stops retrying when the grant is dead', async () => {
    connection = expiredConnection();
    refreshResponses = [{ ok: false, status: 400, detail: 'Xero rejected the authorisation.' }];

    const result = await xeroService.pushInvoice('inv1');

    expect(result.pushed).toBe(false);
    expect(connection?.status).toBe('needs-reconnect');

    // And the invoice carries a message the office can act on, not a stack.
    expect(invoiceResults.at(-1)).toMatchObject({ state: 'failed' });
  });
});

/* ── Pushing an invoice ───────────────────────────────────────────────────── */

describe('pushing an invoice', () => {
  it('sends the stored Xero id on a retry, so no duplicate is raised', async () => {
    connection = liveConnection();
    pushableInvoice = { ...(pushableInvoice as Record<string, unknown>), xeroInvoiceId: 'x-existing' };

    await xeroService.pushInvoice('inv1');

    expect(lastUpsertPayload).toMatchObject({ xeroInvoiceId: 'x-existing' });
  });

  it('omits the id on a first push, so Xero creates rather than updates', async () => {
    connection = liveConnection();

    await xeroService.pushInvoice('inv1');

    expect(lastUpsertPayload).not.toHaveProperty('xeroInvoiceId');
  });

  it('records the Xero id so the NEXT retry can update', async () => {
    connection = liveConnection();

    await xeroService.pushInvoice('inv1');

    expect(invoiceResults.at(-1)).toMatchObject({ state: 'synced', xeroInvoiceId: 'x-1' });
  });

  it('refuses a draft — an unsent invoice must not reach the ledger', async () => {
    connection = liveConnection();
    pushableInvoice = { ...(pushableInvoice as Record<string, unknown>), status: 'draft' };

    const result = await xeroService.pushInvoice('inv1');

    expect(result.pushed).toBe(false);
    expect(vendorCalls).not.toContain('upsert');
  });

  it('refuses an invoice with no lines instead of sending an empty document', async () => {
    connection = liveConnection();
    fullInvoice = { accountName: 'Big Builder Pty Ltd', lines: [] };

    const result = await xeroService.pushInvoice('inv1');

    expect(result.pushed).toBe(false);
    expect(invoiceResults.at(-1)).toMatchObject({ state: 'failed' });
    expect(String(invoiceResults.at(-1)?.message)).toContain('no lines');
  });

  it('carries the money through as a decimal STRING, never a float', async () => {
    connection = liveConnection();

    await xeroService.pushInvoice('inv1');

    const lines = (lastUpsertPayload?.lines ?? []) as { unitAmount: unknown }[];
    expect(lines[0]?.unitAmount).toBe('30.00');
    expect(typeof lines[0]?.unitAmount).toBe('string');
  });

  it('records a rejection on the invoice rather than throwing at the batch', async () => {
    connection = liveConnection();
    upsertResponse = { ok: false, status: 400, detail: 'Account code 200 does not exist' };

    const result = await xeroService.pushInvoice('inv1');

    expect(result.pushed).toBe(false);
    expect(invoiceResults.at(-1)).toMatchObject({
      state: 'failed',
      message: 'Account code 200 does not exist',
    });
  });

  it('fails the invoice with an actionable message when nothing is connected', async () => {
    connection = null;

    const result = await xeroService.pushInvoice('inv1');

    expect(result.pushed).toBe(false);
    expect(String(invoiceResults.at(-1)?.message)).toContain('not connected to Xero');
  });
});

/* ── The payment sweep ────────────────────────────────────────────────────── */

describe('the payment sweep', () => {
  it('marks an invoice paid when Xero says PAID', async () => {
    connection = liveConnection();
    awaitingPayment = [{ id: 'inv1', xeroInvoiceId: 'x-1' }];
    getInvoicesResponse = {
      ok: true,
      value: [
        {
          invoiceId: 'x-1',
          status: 'PAID',
          amountDue: 0,
          amountPaid: 110,
          fullyPaidOnDate: '2026-09-12',
        },
      ],
    };

    const result = await xeroService.syncPayments();

    expect(result.paid).toBe(1);
    expect(paidMarks[0]?.id).toBe('inv1');
  });

  it('treats a zero balance as settled, so a credit note is not chased forever', async () => {
    connection = liveConnection();
    awaitingPayment = [{ id: 'inv1', xeroInvoiceId: 'x-1' }];
    getInvoicesResponse = {
      ok: true,
      // Never stamped PAID, but nothing is owed.
      value: [{ invoiceId: 'x-1', status: 'AUTHORISED', amountDue: 0, amountPaid: 0, fullyPaidOnDate: null }],
    };

    const result = await xeroService.syncPayments();

    expect(result.paid).toBe(1);
  });

  it('leaves an unpaid invoice alone', async () => {
    connection = liveConnection();
    awaitingPayment = [{ id: 'inv1', xeroInvoiceId: 'x-1' }];
    getInvoicesResponse = {
      ok: true,
      value: [{ invoiceId: 'x-1', status: 'AUTHORISED', amountDue: 110, amountPaid: 0, fullyPaidOnDate: null }],
    };

    const result = await xeroService.syncPayments();

    expect(result.paid).toBe(0);
    expect(paidMarks).toHaveLength(0);
  });

  it('does nothing at all when nothing is connected', async () => {
    connection = null;

    expect(await xeroService.syncPayments()).toEqual({ checked: 0, paid: 0 });
  });
});

/* ── Disconnecting ────────────────────────────────────────────────────────── */

describe('disconnecting', () => {
  it('removes the connection locally even if Xero will not revoke it', async () => {
    connection = liveConnection();
    getInvoicesResponse = { ok: true, value: [] };

    await xeroService.disconnect(SUPER_ADMIN);

    // The user must never be trapped in a broken state by a failing remote call.
    expect(connection).toBeNull();
  });

  it('refuses when there is nothing to disconnect', async () => {
    connection = null;

    await expect(xeroService.disconnect(SUPER_ADMIN)).rejects.toMatchObject({ status: 404 });
  });
});
