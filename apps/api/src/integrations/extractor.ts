import { env } from '../config/env.js';
import { AppError } from '../lib/app-error.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'extractor' });

/**
 * 3PM Extractor (I6 · M2.12) — the purchase-order reader.
 *
 * ── What this vendor does, and what it deliberately does not ───────────────
 * It owns the mailbox connection and the model: a builder's PO arrives at the
 * monitored address, the extractor reads the PDF against a template, and it
 * tells us a document is ready. That is the whole of its remit.
 *
 * It does NOT know PlastaGo's accounts, its zones, or its rate cards, and it is
 * not asked to. Matching a document to a customer decides what gets invoiced,
 * and that judgement stays on this side of the boundary — see
 * `po-ingest.adapter.ts`.
 *
 * ── Why the API is wrapped rather than called inline ──────────────────────
 * Three reasons, in order of how much they cost when ignored:
 *
 *  1. **Sessions expire.** The vendor's auth is a one-day session minted from an
 *     app secret. A caller that has to remember to refresh it will forget, and
 *     the failure lands in a background handler at 6am. The cache below makes
 *     that impossible to get wrong.
 *  2. **The secret must stay in one file.** `EXTRACTOR_APP_SECRET` is a live
 *     credential; the fewer places it is read, the fewer places it can be logged.
 *  3. **`off` has to be a working state.** The whole PO pipeline had to be
 *     buildable and testable before this account existed, so every method here
 *     refuses cleanly when the provider is off rather than throwing something
 *     the caller has to interpret.
 */

/** One document, as the extractor reports it. Every field is a CLAIM. */
export interface ExtractorExtraction {
  id: string;
  fileName: string;
  fileType: string;
  status: string;
  /** Present only once `status === 'completed'`. Keys come from our template. */
  extractedData: Record<string, unknown> | null;
  error: string | null;
  documentId: string | null;
  documentName: string | null;
  /**
   * The stored original, at the vendor. Fetched once and copied into our own
   * storage — see `downloadFile`. A reviewer must not depend on a vendor URL
   * that may expire, and the PDF is the evidence the confirmation rests on.
   */
  fileUrl: string | null;
  /** The mailbox the PO arrived from, when the extraction came from email. */
  email: string | null;
  createdAt: string | null;
}

/** `status` values that mean the extractor is finished and will not retry. */
export const TERMINAL_FAILURES = new Set([
  'failed',
  'analysis failed',
  'extraction failed',
]);

interface ExtractorEnvelope<T> {
  data: T | null;
  error: string | null;
}

/**
 * A vendor call whose failure the caller has to ACT on rather than propagate.
 *
 * Used only by the embedding calls. Everything else throws, because everything
 * else has exactly one sensible response to a failure: give up and say so.
 */
export type ExtractorResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; detail: string };

/**
 * Whether a failed session call means "this user is not in the tenant".
 *
 * The vendor answers with prose, so this reads prose. That is unpleasant and
 * deliberate: the alternative is to treat every 403/404 as a missing member and
 * provision users in response to unrelated faults.
 */
export function meansNotAMember(result: { status: number; detail: string }): boolean {
  if (result.status !== 403 && result.status !== 404) return false;

  const detail = result.detail.toLowerCase();

  /*
   * ⚠️ "user" and "not found" are tested SEPARATELY, not as one phrase.
   *
   * The vendor interpolates the address into the middle of the sentence —
   * `User with email 'matt@plastago.com.au' not found` — so a substring check
   * for "user not found" never matches the message it was written for. That
   * cost a working provisioning branch and a 503 on every first visit.
   */
  return (
    detail.includes('not a member') || (detail.includes('user') && detail.includes('not found'))
  );
}

/** Whether a failed call means the embed token we hold is no longer good. */
export function meansStaleToken(result: { status: number; detail: string }): boolean {
  if (result.status !== 401 && result.status !== 404) return false;
  const detail = result.detail.toLowerCase();
  return (
    detail.includes('embed token not found') ||
    detail.includes('no active embed token') ||
    detail.includes('invalid embed token')
  );
}

/**
 * A cached session.
 *
 * Refreshed a minute EARLY rather than on expiry: a request that starts with
 * fifty seconds left can still arrive after the session has gone, and the
 * resulting 401 would be indistinguishable from a revoked token.
 */
interface CachedSession {
  sessionId: string;
  expiresAt: number;
}

const EXPIRY_SKEW_MS = 60_000;

let cached: CachedSession | null = null;
/** In-flight mint, so ten concurrent callers create one session and not ten. */
let minting: Promise<CachedSession> | null = null;

export const extractorClient = {
  /** Whether the pipeline is switched on. Callers branch on this, never on env. */
  get enabled(): boolean {
    return env.EXTRACTOR_PROVIDER === 'threepm';
  },

  /**
   * One extraction, fetched with OUR credentials.
   *
   * ⚠️ This is the authoritative read, and the reason the webhook body is
   * ignored. A forged callback can name any id it likes; all it achieves is
   * making us re-read a document that genuinely exists in our own tenant.
   */
  async getExtraction(id: string): Promise<ExtractorExtraction> {
    const raw = await request<Record<string, unknown>>(`/extractions/${encodeURIComponent(id)}`);

    return {
      id: str(raw.id) ?? id,
      fileName: str(raw.fileName) ?? 'purchase-order.pdf',
      fileType: str(raw.fileType) ?? 'application/pdf',
      status: str(raw.status) ?? 'unknown',
      extractedData: isRecord(raw.extractedData) ? raw.extractedData : null,
      error: str(raw.error),
      documentId: str(raw.documentId) ?? documentIdOf(raw.document),
      documentName: documentNameOf(raw.document),
      fileUrl: str(raw.fileUrl),
      email: str(raw.email),
      createdAt: str(raw.createdAt),
    };
  },

  /**
   * The original PDF's bytes.
   *
   * Streamed straight into our own object storage by the adapter. The vendor URL
   * is not stored: the review screen shows the document beside the extracted
   * fields, and that has to keep working long after any vendor link has expired.
   */
  async downloadFile(fileUrl: string): Promise<{ body: Buffer; contentType: string }> {
    const response = await fetch(fileUrl);

    if (!response.ok) {
      throw AppError.dependencyUnavailable(
        `Could not download the extracted document (${String(response.status)})`,
      );
    }

    return {
      body: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'application/pdf',
    };
  },

  /* ── Embedding: sessions minted FOR A BROWSER ─────────────────────────── */

  /**
   * A session for one signed-in PlastaGo user, to be handed to an iframe.
   *
   * ── Why this does not use the cache above ─────────────────────────────────
   * That cache holds ONE session, minted as `EXTRACTOR_USER_EMAIL`, and it is
   * the credential every authoritative read in this file uses. Handing it to a
   * browser would mean a leaked or revoked tab session takes purchase-order
   * ingestion down with it. So a browser gets its own session, per user, and the
   * two lifetimes never touch.
   *
   * ── Why failures are RETURNED rather than thrown ──────────────────────────
   * Two of them are recoverable and the broker has to tell them apart: a user
   * who is not yet a member of the tenant must be provisioned, and a stale
   * embed token must be re-onboarded. An `AppError` carrying a prose message
   * would force the broker to pattern-match on English.
   */
  async createSessionFor(userEmail: string): Promise<ExtractorResult<CachedSession>> {
    return attemptPost<CachedSession>('/sessions', {
      appId: required(env.EXTRACTOR_APP_ID, 'EXTRACTOR_APP_ID'),
      appSecret: required(env.EXTRACTOR_APP_SECRET, 'EXTRACTOR_APP_SECRET'),
      embedToken: required(env.EXTRACTOR_EMBED_TOKEN, 'EXTRACTOR_EMBED_TOKEN'),
      userEmail,
    }, (data) => {
      const sessionId = str(data.sessionId);
      if (!sessionId) return null;
      const parsed = Date.parse(str(data.expiresAt) ?? '');
      return {
        sessionId,
        expiresAt: Number.isNaN(parsed) ? Date.now() + 86_400_000 : parsed,
      };
    });
  },

  /**
   * A session minted with an EXPLICIT embed token, bypassing env.
   *
   * Used only when the broker has just re-onboarded and holds a token that
   * `env` does not know about yet. Everything else should use
   * `createSessionFor`.
   */
  async createSessionWithToken(
    userEmail: string,
    embedToken: string,
  ): Promise<ExtractorResult<CachedSession>> {
    return attemptPost<CachedSession>('/sessions', {
      appId: required(env.EXTRACTOR_APP_ID, 'EXTRACTOR_APP_ID'),
      appSecret: required(env.EXTRACTOR_APP_SECRET, 'EXTRACTOR_APP_SECRET'),
      embedToken,
      userEmail,
    }, (data) => {
      const sessionId = str(data.sessionId);
      if (!sessionId) return null;
      const parsed = Date.parse(str(data.expiresAt) ?? '');
      return {
        sessionId,
        expiresAt: Number.isNaN(parsed) ? Date.now() + 86_400_000 : parsed,
      };
    });
  },

  /**
   * The owner's session id — our own cached one.
   *
   * ⚠️ This is the whole reason the integration needs no legacy header auth.
   * Adding a member to the tenant requires a session, but the caller has no
   * session precisely because they are not a member yet. Onboarding made
   * `EXTRACTOR_USER_EMAIL` the tenant OWNER, so that identity is guaranteed to
   * be a member and its session can do the provisioning. Never handed to a
   * browser.
   */
  async ownerSessionId(): Promise<string> {
    const session = await currentSession();
    return session.sessionId;
  },

  /**
   * Adds a user to the tenant, session-authenticated.
   *
   * ── Why `admin` and not `member` ──────────────────────────────────────────
   * The vendor gates its own Settings tab — the mailbox connection, webhooks and
   * API keys — on being an owner or an admin over there, and it reads ONLY its
   * own membership record: a PlastaGo super-admin is a stranger to it. Everyone
   * provisioned here arrived through a route locked to `super-admin`
   * (`extractor.router.ts`), so the mapping has already been made by the time
   * this runs; sending `member` just meant the one person allowed through the
   * door could not use what is behind it.
   *
   * Not `owner`: `EXTRACTOR_USER_EMAIL` holds that, and its session is what
   * every authoritative read and the whole PO ingestion pipeline runs on. A
   * second owner able to rotate the embed token underneath it buys nothing the
   * Settings tab needs.
   *
   * ⚠️ This is a CREATE, so it cannot repair anyone who already exists. A user
   * provisioned before this line said `admin` stays a member until the vendor
   * changes their role — 409 below reports "already there", not "now correct".
   */
  async addMember(
    sessionId: string,
    input: { firstName: string; lastName: string; email: string },
  ): Promise<ExtractorResult<true>> {
    const response = await fetch(`${env.EXTRACTOR_BASE_URL}/api/embed/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-id': sessionId },
      body: JSON.stringify({ ...input, role: 'admin' }),
    });

    if (response.status === 409) return { ok: true, value: true };

    const outcome = await readResult<Record<string, unknown>>(response, '/users');
    return outcome.ok ? { ok: true, value: true } : outcome;
  },

  /* ── Setup, used by `seed-extractor` only ─────────────────────────────── */

  /** Creates the tenant, owner and embed token. Run once; the token is shown once. */
  async onboard(input: {
    organizationName: string;
    firstName: string;
    lastName: string;
    email: string;
  }): Promise<{ tenantId: string; embedToken: string; tokenId: string | null }> {
    const appId = required(env.EXTRACTOR_APP_ID, 'EXTRACTOR_APP_ID');
    const appSecret = required(env.EXTRACTOR_APP_SECRET, 'EXTRACTOR_APP_SECRET');

    const data = await post<Record<string, unknown>>('/onboard', {
      ...input,
      appId,
      appSecret,
      apiKeyName: 'PlastaGo API',
    });

    const tenant = isRecord(data.tenant) ? data.tenant : {};
    const token = isRecord(data.embedToken) ? data.embedToken : {};

    const key = str(token.key);
    if (!key) {
      throw AppError.dependencyUnavailable('Onboarding returned no embed token');
    }

    return {
      tenantId: str(tenant.id) ?? '',
      embedToken: key,
      // Kept so a later rotation can target the row it created rather than
      // guessing which of several tokens on the tenant is ours.
      tokenId: str(token.id) ?? str(token._id),
    };
  },

  /** Creates or replaces the purchase-order template. Returns its id. */
  async upsertDocument(input: {
    id: string | null;
    name: string;
    description: string;
    fields: readonly unknown[];
  }): Promise<string> {
    const body = { name: input.name, description: input.description, fields: input.fields };

    const data = input.id
      ? await request<Record<string, unknown>>(`/documents/${encodeURIComponent(input.id)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      : await request<Record<string, unknown>>('/documents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

    // The vendor returns Mongo-shaped documents here, so `_id` rather than `id`.
    const id = str(data._id) ?? str(data.id);
    if (!id) throw AppError.dependencyUnavailable('The template was saved but returned no id');

    return id;
  },

  /** Every template in the tenant, so setup can find one it made earlier. */
  async listDocuments(): Promise<Array<{ id: string; name: string }>> {
    const data = await request<Record<string, unknown>>('/documents?page=1&limit=100');
    const items = Array.isArray(data.items) ? data.items : [];

    return items.filter(isRecord).flatMap((item) => {
      const id = str(item._id) ?? str(item.id);
      const name = str(item.name);
      return id && name ? [{ id, name }] : [];
    });
  },

  /** Points the extractor's callback at us. Idempotent by URL. */
  async ensureWebhook(input: { name: string; url: string; documentId: string | null }): Promise<void> {
    const existing = await request<unknown>('/webhooks');
    const rows = webhookRows(existing);

    // Compared without the query string: the secret lives in `?token=`, and a
    // rotated secret must update the row rather than add a second one.
    const match = rows.find((row) => stripQuery(row.url) === stripQuery(input.url));

    const body = {
      name: input.name,
      url: input.url,
      scope: input.documentId ? 'specific' : 'all',
      documentIds: input.documentId ? [input.documentId] : [],
    };

    if (match) {
      await request(`/webhooks/${encodeURIComponent(match.id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      log.info({ webhookId: match.id }, 'extractor webhook updated');
      return;
    }

    await request('/webhooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    log.info({ url: stripQuery(input.url) }, 'extractor webhook created');
  },

  /** Test seam, and the way `seed-extractor` starts from a clean session. */
  resetSessionForTesting(): void {
    cached = null;
    minting = null;
  },
};

/* ── Transport ───────────────────────────────────────────────────────────── */

/**
 * A session-authenticated call.
 *
 * Retries ONCE on a 401, having thrown the cached session away first. That is
 * not a generic retry policy: a 401 here means the session died early — revoked,
 * or the vendor restarted — and it is the one failure a second attempt reliably
 * fixes. Anything else is returned to the caller as it stands.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  assertEnabled();

  const attempt = async (sessionId: string): Promise<Response> =>
    fetch(`${env.EXTRACTOR_BASE_URL}/api/embed${path}`, {
      ...init,
      headers: { ...init?.headers, 'x-session-id': sessionId },
    });

  let session = await currentSession();
  let response = await attempt(session.sessionId);

  if (response.status === 401) {
    log.warn({ path }, 'extractor session rejected — minting a new one');
    cached = null;
    session = await currentSession();
    response = await attempt(session.sessionId);
  }

  return unwrap<T>(response, path);
}

/** An app-secret call. Only onboarding and session creation use this. */
async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${env.EXTRACTOR_BASE_URL}/api/embed${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  return unwrap<T>(response, path);
}

/**
 * An app-secret call whose failure is returned rather than thrown.
 *
 * `read` narrows the vendor's payload; returning null from it means the call
 * succeeded but the body was not what the contract promises, which is a
 * dependency failure and not a caller error.
 */
async function attemptPost<T>(
  path: string,
  body: unknown,
  read: (data: Record<string, unknown>) => T | null,
): Promise<ExtractorResult<T>> {
  assertEnabled();

  const response = await fetch(`${env.EXTRACTOR_BASE_URL}/api/embed${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const outcome = await readResult<Record<string, unknown>>(response, path);
  if (!outcome.ok) return outcome;

  const value = read(outcome.value);
  if (value === null) {
    return { ok: false, status: 502, detail: 'the response was missing required fields' };
  }

  return { ok: true, value };
}

/**
 * `unwrap`'s non-throwing twin.
 *
 * ⚠️ The vendor's message is carried in `detail` so the broker can classify it,
 * and it must not be forwarded to a browser unfiltered — see the controller.
 */
async function readResult<T>(response: Response, path: string): Promise<ExtractorResult<T>> {
  let envelope: ExtractorEnvelope<T>;

  try {
    envelope = (await response.json()) as ExtractorEnvelope<T>;
  } catch {
    return {
      ok: false,
      status: response.status,
      detail: `unreadable response (${String(response.status)})`,
    };
  }

  if (!response.ok || envelope.data === null || envelope.data === undefined) {
    const detail = envelope.error ?? `HTTP ${String(response.status)}`;
    log.warn({ path, status: response.status, detail }, 'extractor call failed');
    return { ok: false, status: response.status, detail };
  }

  return { ok: true, value: envelope.data };
}

/**
 * Reads the vendor's `{ data, error }` envelope.
 *
 * ⚠️ The vendor's message is surfaced but never the response body wholesale: a
 * failed extraction call can echo document text, and that text is a customer's
 * purchase order.
 */
async function unwrap<T>(response: Response, path: string): Promise<T> {
  let envelope: ExtractorEnvelope<T>;

  try {
    envelope = (await response.json()) as ExtractorEnvelope<T>;
  } catch {
    // A non-JSON body means something in front of the API answered — a proxy, a
    // maintenance page. Either way the vendor is not reachable right now.
    throw AppError.dependencyUnavailable(
      `The document extractor returned an unreadable response (${String(response.status)})`,
    );
  }

  if (!response.ok || envelope.data === null) {
    const detail = envelope.error ?? `HTTP ${String(response.status)}`;
    log.error({ path, status: response.status, detail }, 'extractor call failed');

    // 404 is the one status worth distinguishing: it means the id does not exist
    // in our tenant, which is what a forged webhook produces.
    if (response.status === 404) {
      throw AppError.notFound('That extraction does not exist in the document extractor');
    }

    throw AppError.dependencyUnavailable(`The document extractor rejected the request: ${detail}`);
  }

  return envelope.data;
}

/* ── Sessions ────────────────────────────────────────────────────────────── */

async function currentSession(): Promise<CachedSession> {
  if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) return cached;

  // Coalesce. Without this, a webhook burst mints a session per callback and the
  // vendor sees us as a login loop.
  minting ??= mintSession()
    .then((session) => {
      cached = session;
      return session;
    })
    .finally(() => {
      minting = null;
    });

  return minting;
}

async function mintSession(): Promise<CachedSession> {
  const data = await post<Record<string, unknown>>('/sessions', {
    appId: required(env.EXTRACTOR_APP_ID, 'EXTRACTOR_APP_ID'),
    appSecret: required(env.EXTRACTOR_APP_SECRET, 'EXTRACTOR_APP_SECRET'),
    embedToken: required(env.EXTRACTOR_EMBED_TOKEN, 'EXTRACTOR_EMBED_TOKEN'),
    userEmail: required(env.EXTRACTOR_USER_EMAIL, 'EXTRACTOR_USER_EMAIL'),
  });

  const sessionId = str(data.sessionId);
  if (!sessionId) {
    throw AppError.dependencyUnavailable('The document extractor issued no session id');
  }

  const expiresAt = str(data.expiresAt);
  const parsed = expiresAt ? Date.parse(expiresAt) : Number.NaN;

  log.info({ expiresAt }, 'extractor session created');

  return {
    sessionId,
    // An hour is the conservative floor when the vendor does not say. Being
    // early costs one extra call; being late costs a dropped purchase order.
    expiresAt: Number.isNaN(parsed) ? Date.now() + 3_600_000 : parsed,
  };
}

/* ── Guards and narrowing ────────────────────────────────────────────────── */

function assertEnabled(): void {
  if (env.EXTRACTOR_PROVIDER !== 'threepm') {
    throw AppError.dependencyUnavailable(
      'The document extractor is not configured. Set EXTRACTOR_PROVIDER=threepm and its credentials.',
    );
  }
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw AppError.dependencyUnavailable(`${name} is required when EXTRACTOR_PROVIDER=threepm`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A trimmed string, or null. Empty is null — the vendor sends both for absence. */
function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function documentIdOf(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return str(value.id) ?? str(value._id);
}

function documentNameOf(value: unknown): string | null {
  return isRecord(value) ? str(value.name) : null;
}

/**
 * The webhook list, which the vendor documents loosely.
 *
 * Accepts a bare array or an `{ items: [...] }` page, because both shapes appear
 * across the guide and neither is worth a failed setup run.
 */
function webhookRows(value: unknown): Array<{ id: string; url: string }> {
  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.items)
      ? value.items
      : [];

  return rows.filter(isRecord).flatMap((row) => {
    const id = str(row.id) ?? str(row._id);
    const url = str(row.url);
    return id && url ? [{ id, url }] : [];
  });
}

function stripQuery(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}
