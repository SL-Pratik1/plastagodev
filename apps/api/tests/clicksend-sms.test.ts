import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The ClickSend SMS provider (I2).
 *
 * ── Why this is tested against a stubbed `fetch` and never the real API ────
 * Every message is BILLED, and the numbers in a test fixture belong to real
 * handsets somewhere. A suite that reached ClickSend would spend the client's
 * credit on every commit and text strangers a sign-in code, so `fetch` is
 * replaced wholesale.
 *
 * ── What is actually worth testing here ───────────────────────────────────
 * Not "does ClickSend work". Two things that are ours to get wrong, and one
 * of them is the reason this file exists:
 *
 *   1. ⚠️ **A 200 does not mean sent.** ClickSend accepts the batch, answers
 *      200, and reports each message's fate inside `data.messages[]`. Twilio,
 *      which this replaced, signalled a bad recipient with an HTTP error — so
 *      the obvious `response.ok` check is correct for the old vendor and
 *      quietly wrong for this one. Getting it wrong makes `outbound.service`
 *      record `sent` for a message nobody received, and "we definitely texted
 *      them" is the worst answer support can be holding.
 *
 *   2. The number is converted to E.164 at the boundary. PlastaGo stores
 *      `0412345678`; ClickSend rejects anything that is not `+61…`. Missing
 *      this fails EVERY driver sign-in, which is a driver's only way in (§9 A2).
 */

const USERNAME = 'test-user-not-a-real-credential';
const API_KEY = 'test-key-not-a-real-credential';
const FROM = 'PlastaGo';

/*
 * Credentials are overridden rather than read from the environment, so this
 * file cannot hold — or spend — the client's real account. Partial, because
 * `env.ts` exports more than `env` and the logger reads one of them.
 */
vi.mock('../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/env.js')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      SMS_PROVIDER: 'clicksend',
      CLICKSEND_USERNAME: USERNAME,
      CLICKSEND_API_KEY: API_KEY,
      CLICKSEND_FROM: FROM,
    },
  };
});

const { createClickSendSmsSender } = await import('../src/integrations/clicksend-sms.js');

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

/** What ClickSend returns when it has taken the message. */
function accepted(status = 'SUCCESS') {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        http_code: 200,
        response_code: 'SUCCESS',
        data: { messages: [{ message_id: 'msg-1', status }] },
      }),
  };
}

interface SentRequest {
  url: string;
  headers: { authorization: string };
  body: string;
}

/**
 * The one request the provider made.
 *
 * The "did it call fetch at all?" assertion is folded in, so a test that
 * asserts on a request that was never sent fails saying exactly that, rather
 * than on an undefined property three lines further down.
 */
function sent(): SentRequest {
  const call = fetchMock.mock.calls[0] as
    | [string, { headers: { authorization: string }; body: string }]
    | undefined;

  expect(call, 'expected the provider to call fetch').toBeDefined();
  const [url, init] = call!;

  return { url, headers: init.headers, body: init.body };
}

/** The single message inside the batch the provider posted. */
function sentMessage(): { to: string; from: string; body: string } {
  const payload = JSON.parse(sent().body) as {
    messages: { to: string; from: string; body: string }[];
  };

  // One recipient per call — the batch form is the vendor's, not ours.
  expect(payload.messages).toHaveLength(1);
  return payload.messages[0]!;
}

describe('ClickSend SMS', () => {
  it('sends a message and reports success', async () => {
    fetchMock.mockResolvedValue(accepted());

    await expect(
      createClickSendSmsSender().send({ to: '0412345678', body: 'PlastaGo: code 483920' }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent().url).toBe('https://rest.clicksend.com/v3/sms/send');
    expect(sentMessage().body).toBe('PlastaGo: code 483920');
  });

  /*
   * The conversion that, missing, breaks every driver sign-in. Asserted on the
   * wire rather than on `toE164Mobile` — that function has its own test, and
   * what matters here is that this provider actually calls it.
   */
  it('converts the stored local number to E.164 on the wire', async () => {
    fetchMock.mockResolvedValue(accepted());

    await createClickSendSmsSender().send({ to: '0412345678', body: 'x' });

    expect(sentMessage().to).toBe('+61412345678');
  });

  it('sends from the configured sender id', async () => {
    fetchMock.mockResolvedValue(accepted());

    await createClickSendSmsSender().send({ to: '0412345678', body: 'x' });

    expect(sentMessage().from).toBe(FROM);
  });

  it('authenticates with HTTP Basic over username and API key', async () => {
    fetchMock.mockResolvedValue(accepted());

    await createClickSendSmsSender().send({ to: '0412345678', body: 'x' });

    const { authorization } = sent().headers;
    const decoded = Buffer.from(authorization.replace('Basic ', ''), 'base64').toString();

    expect(decoded).toBe(`${USERNAME}:${API_KEY}`);
  });

  /* ── The one that matters ──────────────────────────────────────────────── */

  it.each([
    ['INVALID_RECIPIENT', 'a number ClickSend will not deliver to'],
    ['NO_CREDIT', 'an account with an empty balance'],
    ['INVALID_SENDER_ID', 'a sender id that was never registered'],
  ])('fails on a 200 carrying status %s — %s', async (status) => {
    fetchMock.mockResolvedValue(accepted(status));

    await expect(
      createClickSendSmsSender().send({ to: '0412345678', body: 'x' }),
    ).rejects.toThrow(/Could not send the SMS/);
  });

  /*
   * A shape change at the vendor must surface as a failed send, never as a
   * success — and never as a crash inside a notification some service awaits.
   */
  it.each([
    ['an empty body', null],
    ['no data', {}],
    ['no messages array', { data: {} }],
    ['an empty messages array', { data: { messages: [] } }],
    ['a message with no status', { data: { messages: [{ message_id: 'm' }] } }],
  ])('fails rather than assuming success when the response has %s', async (_label, payload) => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(payload) });

    await expect(
      createClickSendSmsSender().send({ to: '0412345678', body: 'x' }),
    ).rejects.toThrow(/Could not send the SMS/);
  });

  /* ── Ordinary failures ─────────────────────────────────────────────────── */

  it.each([
    ['wrong credentials', 401],
    ['no credit at the account level', 403],
    ['rate limiting', 429],
    ['a vendor outage', 503],
  ])('fails on an HTTP error — %s', async (_label, status) => {
    fetchMock.mockResolvedValue({
      ok: false,
      status,
      json: () => Promise.resolve({ response_msg: 'nope' }),
    });

    await expect(
      createClickSendSmsSender().send({ to: '0412345678', body: 'x' }),
    ).rejects.toThrow(/Could not send the SMS/);
  });

  it('fails when the request never completes', async () => {
    fetchMock.mockRejectedValue(new Error('timed out'));

    await expect(
      createClickSendSmsSender().send({ to: '0412345678', body: 'x' }),
    ).rejects.toThrow(/Could not send the SMS/);
  });

  /*
   * A body that is not JSON — a proxy error page, say. `response.json()` throws,
   * and the provider must treat that as a failure rather than letting the
   * rejection escape as something the caller never expected.
   */
  it('fails when the response is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('not json')),
    });

    await expect(
      createClickSendSmsSender().send({ to: '0412345678', body: 'x' }),
    ).rejects.toThrow(/Could not send the SMS/);
  });

  /*
   * ⚠️ The error a caller sees must not carry the vendor's echo of the message
   * body — for an OTP, that body IS the live sign-in code, and this error
   * reaches `outbound.service`, which writes `detail` to the notification log.
   */
  it('keeps the message body out of the error a caller receives', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          data: { messages: [{ status: 'INVALID_RECIPIENT', body: 'PlastaGo: code 483920' }] },
        }),
    });

    await expect(
      createClickSendSmsSender().send({ to: '0412345678', body: 'PlastaGo: code 483920' }),
    ).rejects.toThrow(/^Could not send the SMS$/);
  });

  /* ── Configuration ─────────────────────────────────────────────────────── */

  /*
   * Names the variable that is missing. `env.ts` already refuses to boot
   * without these, so reaching this is a misconfiguration that got past the
   * schema — at which point the one useful thing to say is WHICH key is absent.
   */
  it.each([
    ['CLICKSEND_USERNAME', { CLICKSEND_USERNAME: undefined }],
    ['CLICKSEND_API_KEY', { CLICKSEND_API_KEY: undefined }],
    ['CLICKSEND_FROM', { CLICKSEND_FROM: undefined }],
  ])('refuses to build without %s, and says so', async (missing, override) => {
    vi.resetModules();
    vi.doMock('../src/config/env.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/config/env.js')>();
      return {
        ...actual,
        env: {
          ...actual.env,
          SMS_PROVIDER: 'clicksend',
          CLICKSEND_USERNAME: USERNAME,
          CLICKSEND_API_KEY: API_KEY,
          CLICKSEND_FROM: FROM,
          ...override,
        },
      };
    });

    const { createClickSendSmsSender: build } = await import(
      '../src/integrations/clicksend-sms.js'
    );

    expect(() => build()).toThrow(new RegExp(`${missing} is required`));

    vi.doUnmock('../src/config/env.js');
    vi.resetModules();
  });
});
