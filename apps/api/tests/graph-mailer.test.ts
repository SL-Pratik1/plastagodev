import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which mailbox an email goes out from (Matthew, 30/09/2026).
 *
 *   builderdocprocessing@ — receives POs and call-ups (the extractor's, not ours)
 *   accounts@             — invoices and PO requests
 *   noreply@              — everything else
 *
 * ⚠️ The accounts mailbox is opt-in. Until the client's IT grants send rights
 * on it, sending from it would fail every invoice email — so with
 * `MS_GRAPH_ACCOUNTS_SENDER` unset, invoices must keep going from noreply@.
 */

const overrides = vi.hoisted(() => ({
  LOG_LEVEL: 'silent',
  MAIL_PROVIDER: 'graph',
  MS_GRAPH_TENANT_ID: 'tenant',
  MS_GRAPH_CLIENT_ID: 'client',
  MS_GRAPH_CLIENT_SECRET: 'secret',
  MS_GRAPH_MAIL_SENDER: 'noreply@plastago.com.au',
  MS_GRAPH_ACCOUNTS_SENDER: 'accounts@plastago.com.au',
}));

vi.mock('../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/env.js')>();
  return { ...actual, env: { ...actual.env, ...overrides } };
});

// The mocked module's own object — what the mailer reads at send time.
const { env } = await import('../src/config/env.js');

vi.mock('@azure/identity', () => ({
  ClientSecretCredential: class {
    getToken() {
      return Promise.resolve({ token: 'graph-token', expiresOnTimestamp: Date.now() + 60_000 });
    }
  },
}));

const { createGraphMailer } = await import('../src/integrations/graph-mailer.js');

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
  env.MS_GRAPH_ACCOUNTS_SENDER = 'accounts@plastago.com.au';
});

const email = {
  to: 'ap@clarendon.com.au',
  subject: 'Invoice PGA-104312',
  text: 'Hello',
  html: '<p>Hello</p>',
};

/** The mailbox in the sendMail URL, and whether Sent Items keeps a copy. */
function lastSend(): { mailbox: string; saveToSentItems: boolean } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, { body: string }];
  const mailbox = decodeURIComponent(/\/users\/([^/]+)\/sendMail$/.exec(url)?.[1] ?? '');
  const body = JSON.parse(init.body) as { saveToSentItems: boolean };
  return { mailbox, saveToSentItems: body.saveToSentItems };
}

describe('which mailbox Graph sends as', () => {
  it('sends ordinary email from noreply@ and keeps no copy', async () => {
    await createGraphMailer().send(email);

    expect(lastSend()).toEqual({ mailbox: 'noreply@plastago.com.au', saveToSentItems: false });
  });

  it('sends accounts email from accounts@ and keeps a copy in Sent Items', async () => {
    await createGraphMailer().send({ ...email, mailbox: 'accounts' });

    expect(lastSend()).toEqual({ mailbox: 'accounts@plastago.com.au', saveToSentItems: true });
  });

  it('falls back to noreply@ while the accounts mailbox is not configured', async () => {
    env.MS_GRAPH_ACCOUNTS_SENDER = undefined;

    await createGraphMailer().send({ ...email, mailbox: 'accounts' });

    expect(lastSend()).toEqual({ mailbox: 'noreply@plastago.com.au', saveToSentItems: false });
  });

  /* A 403 here means IT has not granted send rights on accounts@ yet. */
  it('reports a refused send as a failure, not a success', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":{"code":"ErrorAccessDenied"}}', { status: 403 }));

    await expect(createGraphMailer().send({ ...email, mailbox: 'accounts' })).rejects.toThrow(
      'Could not send the email',
    );
  });
});
