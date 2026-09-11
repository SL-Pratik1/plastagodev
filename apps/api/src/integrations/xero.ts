import { env, xeroRedirectUri } from '../config/env.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'xero' });

/**
 * Xero (I1 · M7.8) — the accounting boundary.
 *
 * ── What is different about this vendor ───────────────────────────────────
 * Every other integration in this folder authenticates with a credential
 * PlastaGo owns. Xero does not work that way and deliberately offers no static
 * key to a company's ledger: the organisation's owner authorises us from a
 * browser, once, and we are handed a token that belongs to THEM. So this file
 * has two halves no other integration needs — an OAuth dance, and a refresh
 * cycle that must never lose the rotating token it is given.
 *
 * ── Why the API is wrapped rather than called inline ──────────────────────
 *  1. **Refresh tokens rotate.** Xero issues a NEW refresh token on every
 *     refresh and invalidates the old one. A caller that refreshes and then
 *     fails to persist the replacement has silently destroyed the connection —
 *     and will not find out until the next call, by which time the token that
 *     could have saved it is gone. Refresh lives in one place for that reason.
 *  2. **The client secret stays in one file.** The fewer places it is read,
 *     the fewer places it can be logged.
 *  3. **`off` has to be a working state.** The invoicing domain shipped before
 *     this account existed, so every method here refuses cleanly when the
 *     provider is off rather than throwing something the caller must interpret.
 *
 * ── Why no `xero-node` SDK ────────────────────────────────────────────────
 * The same argument as `graph-mailer.ts`. PlastaGo makes six Xero calls in its
 * entire lifetime — token, refresh, connections, contact lookup, invoice
 * upsert, invoice read. The official SDK brings a generated client for the
 * whole accounting API, its own token store that would compete with ours for
 * ownership of the refresh cycle, and a major-version treadmill. Six `fetch`
 * calls are smaller than the adapter that would hide them.
 */

/* ── Endpoints ───────────────────────────────────────────────────────────── */

const AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONNECTIONS_URL = 'https://api.xero.com/connections';
const API_BASE = 'https://api.xero.com/api.xro/2.0';

/**
 * What PlastaGo asks permission for, and nothing beyond it.
 *
 * ── ⚠️ These MUST be Xero's granular scopes, not the broad ones ──────────
 * Xero split the broad `accounting.transactions` scope into per-resource
 * scopes, and an app created on or after 2 March 2026 cannot request the broad
 * ones AT ALL — the authorize URL is rejected outright with `invalid_scope`
 * before the user ever sees a login page. PlastaGo's app registration is newer
 * than that, so `accounting.transactions` is not a legacy nicety here; it is a
 * value that cannot work. Verified against the live authorize endpoint:
 * `accounting.transactions`, `accounting.reports.read` and
 * `accounting.journals.read` are all refused for this client id, while the
 * granular names below are accepted.
 *
 * `accounting.invoices` covers both directions of the only thing we do —
 * pushing an invoice and reading it back to see whether it was paid. The
 * payment sweep needs no `accounting.payments` scope of its own, because
 * `AmountDue` and `Status` arrive on the invoice itself.
 *
 * `offline_access` is not optional decoration — without it Xero issues no
 * refresh token at all, the connection dies after thirty minutes, and Matthew
 * is asked to reconnect several times a day until somebody works out why.
 *
 * `accounting.settings` is deliberately absent. It would let us read the chart
 * of accounts and branding themes, which we do not use, and every extra scope
 * is one more line on a consent screen a client can reasonably object to.
 */
const SCOPES = [
  'openid',
  'profile',
  'email',
  'accounting.invoices',
  'accounting.contacts',
  'offline_access',
] as const;

/**
 * How long before true expiry a token is treated as expired.
 *
 * Xero access tokens last thirty minutes. Refreshing at the last second means
 * a token that was valid when we checked and expired in flight — a 401 on an
 * invoice push that looks like a rejection and is not. Two minutes is longer
 * than any single call here takes.
 */
const EXPIRY_SKEW_MS = 2 * 60_000;

/* ── Result type ─────────────────────────────────────────────────────────── */

/**
 * Vendor calls return a result rather than throwing.
 *
 * The caller has to distinguish "Xero said no to this invoice" — a business
 * fact worth storing on the invoice and showing the office — from "Xero is
 * down", which is a retry. An exception flattens both into one catch block.
 */
export type XeroResult<T> = { ok: true; value: T } | { ok: false; status: number; detail: string };

export interface XeroTokens {
  accessToken: string;
  refreshToken: string;
  /** Absolute, already skew-adjusted. */
  expiresAt: Date;
}

export interface XeroTenant {
  /** The CONNECTION id — what `DELETE /connections/{id}` wants. */
  connectionId: string;
  /** The ORGANISATION id — what the `Xero-tenant-id` header wants. */
  tenantId: string;
  tenantName: string;
}

export interface XeroContactRef {
  contactId: string;
  name: string;
}

/** One invoice as Xero reports it back. Every field is a CLAIM. */
export interface XeroInvoiceResult {
  invoiceId: string;
  invoiceNumber: string | null;
  status: string;
  amountDue: number | null;
  amountPaid: number | null;
  fullyPaidOnDate: string | null;
}

export const xeroClient = {
  /** Whether this deployment has Xero switched on and configured. */
  get enabled(): boolean {
    return env.XERO_PROVIDER === 'xero' && Boolean(env.XERO_CLIENT_ID && env.XERO_CLIENT_SECRET);
  },

  /**
   * The URL to send the organisation owner to.
   *
   * `state` is not decoration: it is the only thing tying the callback we
   * receive back to a request WE started. Without it anyone can hand a
   * signed-in admin a crafted callback URL and connect PlastaGo to an
   * organisation of their choosing — a CSRF against the accounting connection.
   */
  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: required(env.XERO_CLIENT_ID, 'XERO_CLIENT_ID'),
      redirect_uri: xeroRedirectUri(),
      scope: SCOPES.join(' '),
      state,
    });

    return `${AUTHORIZE_URL}?${params.toString()}`;
  },

  /** Trades the one-time code from the callback for a token pair. */
  async exchangeCode(code: string): Promise<XeroResult<XeroTokens>> {
    return tokenCall(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: xeroRedirectUri(),
      }),
    );
  },

  /**
   * Trades a refresh token for a new pair.
   *
   * ⚠️ The response contains a NEW refresh token and the one passed in is dead
   * the moment this returns. The caller MUST persist the replacement before
   * doing anything else with the access token.
   */
  async refresh(refreshToken: string): Promise<XeroResult<XeroTokens>> {
    return tokenCall(
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    );
  },

  /**
   * The organisations this token may act on.
   *
   * Called immediately after the exchange, because the token alone does not
   * say which organisation it is for — and a user may have approved more
   * than one.
   */
  async connections(accessToken: string): Promise<XeroResult<XeroTenant[]>> {
    const result = await call<
      { id: string; tenantId: string; tenantName: string; tenantType: string }[]
    >(CONNECTIONS_URL, { accessToken });

    if (!result.ok) return result;

    return {
      ok: true,
      value: result.value
        // `tenantType` is ORGANISATION or PRACTICE. A practice is the
        // accountant's own workspace and has no ledger to invoice into.
        .filter((row) => row.tenantType === 'ORGANISATION')
        .map((row) => ({
          connectionId: row.id,
          tenantId: row.tenantId,
          tenantName: row.tenantName,
        })),
    };
  },

  /**
   * Revokes one connection at Xero.
   *
   * Called on disconnect so the grant disappears from Matthew's Xero account
   * too. Deleting our row alone would leave PlastaGo listed there as a
   * connected app whose state he can no longer see — the sort of thing that
   * erodes trust in an integration out of all proportion to the bug.
   */
  async disconnect(accessToken: string, connectionId: string): Promise<XeroResult<null>> {
    return call<null>(`${CONNECTIONS_URL}/${encodeURIComponent(connectionId)}`, {
      accessToken,
      method: 'DELETE',
      expectEmpty: true,
    });
  },

  /**
   * Finds a contact by exact name.
   *
   * ── Why name and not email ────────────────────────────────────────────
   * An invoice is addressed to a COMPANY, and Xero's contact identity is its
   * name. Matching on the billing email would split one builder into two
   * contacts the day their accounts-payable address changes, and merge two
   * unrelated builders that share an office manager's address.
   */
  async findContact(
    accessToken: string,
    tenantId: string,
    name: string,
  ): Promise<XeroResult<XeroContactRef | null>> {
    // Xero's `where` is a string expression, so an unescaped double quote in a
    // customer name breaks out of the literal. Escaping is the fix; the
    // alternative is a query-injection footgun on a field customers control.
    const where = `Name=="${name.replace(/"/g, '\\"')}"`;
    const url = `${API_BASE}/Contacts?where=${encodeURIComponent(where)}`;

    const result = await call<{ Contacts?: { ContactID: string; Name: string }[] }>(url, {
      accessToken,
      tenantId,
    });

    if (!result.ok) return result;

    const found = result.value.Contacts?.[0];

    return { ok: true, value: found ? { contactId: found.ContactID, name: found.Name } : null };
  },

  /** Creates a contact. Only called when `findContact` returned null. */
  async createContact(
    accessToken: string,
    tenantId: string,
    input: { name: string; email: string | null },
  ): Promise<XeroResult<XeroContactRef>> {
    const result = await call<{ Contacts?: { ContactID: string; Name: string }[] }>(
      `${API_BASE}/Contacts`,
      {
        accessToken,
        tenantId,
        method: 'POST',
        body: {
          Contacts: [{ Name: input.name, ...(input.email ? { EmailAddress: input.email } : {}) }],
        },
      },
    );

    if (!result.ok) return result;

    const created = result.value.Contacts?.[0];

    if (!created) {
      return { ok: false, status: 502, detail: 'Xero accepted the contact but returned nothing' };
    }

    return { ok: true, value: { contactId: created.ContactID, name: created.Name } };
  },

  /**
   * Creates or updates one invoice.
   *
   * ── Why POST serves both ──────────────────────────────────────────────
   * Xero upserts on `InvoiceID`: supply one and it updates that invoice, omit
   * it and a new one is created. That is what makes a retry safe. The
   * alternative — create, then catch a duplicate — puts a second invoice in a
   * customer's ledger every time a call times out after Xero already committed
   * it, which is the worst failure this integration could have.
   */
  async upsertInvoice(
    accessToken: string,
    tenantId: string,
    payload: XeroInvoicePayload,
  ): Promise<XeroResult<XeroInvoiceResult>> {
    const result = await call<{ Invoices?: RawInvoice[] }>(`${API_BASE}/Invoices`, {
      accessToken,
      tenantId,
      method: 'POST',
      body: { Invoices: [buildInvoiceBody(payload)] },
    });

    if (!result.ok) return result;

    const saved = result.value.Invoices?.[0];

    if (!saved) {
      return { ok: false, status: 502, detail: 'Xero accepted the invoice but returned nothing' };
    }

    return { ok: true, value: toInvoiceResult(saved) };
  },

  /**
   * Reads invoices back, for the payment sweep.
   *
   * Batched by id rather than one call each: Xero's ceiling is per minute and
   * per day, and a sweep over a few hundred invoices would otherwise spend the
   * whole allowance on round trips.
   */
  async getInvoices(
    accessToken: string,
    tenantId: string,
    invoiceIds: readonly string[],
  ): Promise<XeroResult<XeroInvoiceResult[]>> {
    if (invoiceIds.length === 0) return { ok: true, value: [] };

    const url = `${API_BASE}/Invoices?IDs=${encodeURIComponent(invoiceIds.join(','))}`;
    const result = await call<{ Invoices?: RawInvoice[] }>(url, { accessToken, tenantId });

    if (!result.ok) return result;

    return { ok: true, value: (result.value.Invoices ?? []).map(toInvoiceResult) };
  },
};

/* ── Invoice payload ─────────────────────────────────────────────────────── */

export interface XeroInvoiceLine {
  description: string;
  quantity: number;
  /** Unit price EXCLUDING GST, as a decimal string. */
  unitAmount: string;
  accountCode?: string | undefined;
}

export interface XeroInvoicePayload {
  /** Present on a retry, absent on a first push. Drives Xero's upsert. */
  xeroInvoiceId?: string | undefined;
  contactId: string;
  invoiceNumber: string;
  /** `YYYY-MM-DD`. */
  date: string;
  dueDate: string;
  reference: string | null;
  lines: readonly XeroInvoiceLine[];
}

function buildInvoiceBody(payload: XeroInvoicePayload): Record<string, unknown> {
  return {
    Type: 'ACCREC',
    ...(payload.xeroInvoiceId ? { InvoiceID: payload.xeroInvoiceId } : {}),
    Contact: { ContactID: payload.contactId },
    InvoiceNumber: payload.invoiceNumber,
    Date: payload.date,
    DueDate: payload.dueDate,
    ...(payload.reference ? { Reference: payload.reference } : {}),
    /*
     * PlastaGo prices and stores everything GST-EXCLUSIVE and computes the tax
     * itself (§6A.10 #1). Telling Xero the same thing means one side does the
     * arithmetic; leaving it to default risks Xero re-deriving a total that
     * disagrees with the invoice the customer was already emailed.
     */
    LineAmountTypes: 'Exclusive',
    Status: env.XERO_INVOICE_STATUS,
    LineItems: payload.lines.map((line) => ({
      Description: line.description,
      Quantity: line.quantity,
      UnitAmount: line.unitAmount,
      ...(line.accountCode ? { AccountCode: line.accountCode } : {}),
    })),
  };
}

interface RawInvoice {
  InvoiceID: string;
  InvoiceNumber?: string;
  Status?: string;
  AmountDue?: number;
  AmountPaid?: number;
  FullyPaidOnDate?: string;
}

function toInvoiceResult(raw: RawInvoice): XeroInvoiceResult {
  return {
    invoiceId: raw.InvoiceID,
    invoiceNumber: raw.InvoiceNumber ?? null,
    status: raw.Status ?? 'UNKNOWN',
    amountDue: raw.AmountDue ?? null,
    amountPaid: raw.AmountPaid ?? null,
    fullyPaidOnDate: raw.FullyPaidOnDate ?? null,
  };
}

/* ── Transport ───────────────────────────────────────────────────────────── */

/**
 * The token endpoint, which is shaped unlike the rest of the API.
 *
 * Form-encoded, HTTP Basic with the client credentials, and its errors are
 * `{error: "invalid_grant"}` rather than the accounting API's envelope.
 */
async function tokenCall(body: URLSearchParams): Promise<XeroResult<XeroTokens>> {
  const clientId = required(env.XERO_CLIENT_ID, 'XERO_CLIENT_ID');
  const clientSecret = required(env.XERO_CLIENT_SECRET, 'XERO_CLIENT_SECRET');
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  let response: Response;

  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    log.error({ err: error }, 'the Xero token endpoint could not be reached');
    return { ok: false, status: 503, detail: 'Could not reach Xero' };
  }

  const text = await response.text();

  if (!response.ok) {
    // ⚠️ Logged, never returned — the body can echo the grant we sent.
    log.error({ status: response.status, body: text.slice(0, 500) }, 'Xero token call failed');
    return { ok: false, status: response.status, detail: describeTokenError(text) };
  }

  let parsed: { access_token?: string; refresh_token?: string; expires_in?: number };

  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return { ok: false, status: 502, detail: 'Xero returned a token response we could not read' };
  }

  if (!parsed.access_token || !parsed.refresh_token) {
    /*
     * The realistic cause is a missing `offline_access` scope: Xero happily
     * issues an access token without it and simply omits the refresh token,
     * which then fails thirty minutes later somewhere else entirely.
     */
    return {
      ok: false,
      status: 502,
      detail:
        'Xero did not return a refresh token — the app may be missing the offline_access scope',
    };
  }

  return {
    ok: true,
    value: {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      expiresAt: new Date(Date.now() + (parsed.expires_in ?? 1800) * 1000 - EXPIRY_SKEW_MS),
    },
  };
}

interface CallOptions {
  accessToken: string;
  tenantId?: string | undefined;
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  expectEmpty?: boolean;
}

async function call<T>(url: string, options: CallOptions): Promise<XeroResult<T>> {
  const method = options.method ?? 'GET';

  let response: Response;

  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        Accept: 'application/json',
        ...(options.tenantId ? { 'Xero-tenant-id': options.tenantId } : {}),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    log.error({ err: error, url }, 'a Xero API call could not be reached');
    return { ok: false, status: 503, detail: 'Could not reach Xero' };
  }

  const text = await response.text();

  if (!response.ok) {
    log.error({ status: response.status, url, body: text.slice(0, 1000) }, 'a Xero API call failed');
    return { ok: false, status: response.status, detail: describeApiError(response.status, text) };
  }

  if (options.expectEmpty || text.length === 0) return { ok: true, value: null as T };

  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return { ok: false, status: 502, detail: 'Xero returned a response we could not read' };
  }
}

/* ── Error shaping ───────────────────────────────────────────────────────── */

/**
 * Turns Xero's validation envelope into one line an office user can act on.
 *
 * Xero reports per-line problems in a nested `Elements[].ValidationErrors[]`
 * and the useful sentence is three levels down. Storing the raw JSON on the
 * invoice — which is what the naive version does — puts a wall of braces in
 * front of somebody whose actual problem is "account code 200 doesn't exist".
 */
function describeApiError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      Message?: string;
      Detail?: string;
      Elements?: { ValidationErrors?: { Message?: string }[] }[];
    };

    const validation = parsed.Elements?.flatMap((element) =>
      (element.ValidationErrors ?? []).map((issue) => issue.Message).filter(Boolean),
    );

    if (validation && validation.length > 0) return validation.join('; ');
    if (parsed.Detail) return parsed.Detail;
    if (parsed.Message) return parsed.Message;
  } catch {
    // Not JSON. Xero's rate limiter and its gateway both answer in plain text.
  }

  if (status === 429) return 'Xero is rate limiting us. It will be retried shortly.';
  if (status === 401) return 'Xero rejected the connection. Reconnect to Xero.';
  if (status === 403) return 'The connected Xero user does not have permission to do that.';

  return `Xero returned ${String(status)}`;
}

function describeTokenError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string; error_description?: string };

    if (parsed.error === 'invalid_grant') {
      /*
       * Two very different causes, one Xero error code. On the exchange it
       * usually means the redirect URI did not match the registration; on a
       * refresh it means the refresh token is spent or the grant was revoked.
       */
      return 'Xero rejected the authorisation. It may have expired, been revoked, or the redirect URI may not match the app registration.';
    }

    if (parsed.error_description) return parsed.error_description;
    if (parsed.error) return parsed.error;
  } catch {
    // Fall through to the generic line.
  }

  return 'Xero rejected the authorisation request';
}

/** True when a stored token is past its (skewed) expiry. */
export function isExpired(expiresAt: Date): boolean {
  return expiresAt.getTime() <= Date.now();
}

/**
 * Whether a failure means the CONNECTION is dead rather than this one call
 * having gone wrong.
 *
 * The distinction decides whether the page says "retry" or "reconnect", and
 * getting it wrong sends somebody round a retry loop that cannot succeed.
 */
export function meansConnectionDead(result: { ok: false; status: number }): boolean {
  return result.status === 401;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required when XERO_PROVIDER=xero`);
  return value;
}
