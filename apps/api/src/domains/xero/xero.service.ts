import { randomBytes } from 'node:crypto';
import type { Role } from '@plastago/shared';
import { env } from '../../config/env.js';
import {
  isExpired,
  meansConnectionDead,
  xeroClient,
  type XeroInvoiceLine,
  type XeroResult,
} from '../../integrations/xero.js';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { open, seal } from '../../lib/secret-box.js';
import { accountRepository } from '../accounts/account.repository.js';
import { invoiceRepository } from '../invoices/invoice.repository.js';
import { xeroRepository, type XeroConnectionRow } from './xero.repository.js';

const log = logger.child({ module: 'xero-service' });

/**
 * The Xero connection and the invoice sync (I1 · M7.8).
 *
 * ── The one rule this file exists to enforce ──────────────────────────────
 * Xero rotates the refresh token on EVERY refresh and kills the one it
 * replaced. So the token in the database is not a credential that happens to
 * be stored — it is the only copy of a thing that is destroyed each time it is
 * used. Every path that refreshes goes through `withAccessToken` for that
 * reason, and that function persists the replacement before it does anything
 * else with the token it just received.
 *
 * Get this wrong and the failure is silent, delayed and total: the connection
 * works until the access token expires half an hour later, then never again,
 * and the token that could have repaired it is gone.
 */

/** Who may manage the accounting connection. */
const XERO_ADMIN_ROLES = new Set<Role>(['super-admin']);

/** How long somebody has to complete the Xero login. */
const STATE_TTL_MS = 10 * 60_000;

/**
 * Xero's refresh-token window. Sixty days without a refresh and the grant is
 * gone — the connection lapses and only a human can restore it.
 */
const REFRESH_TTL_MS = 60 * 24 * 60 * 60_000;

/**
 * How close to that ceiling the page starts warning.
 *
 * Seven days, because the failure it prevents is discovered at month-end
 * otherwise — the worst possible moment to find that a fortnight of invoices
 * never reached the books.
 */
const REFRESH_WARN_MS = 7 * 24 * 60 * 60_000;

/** Invoices read back per payment sweep. Bounded — Xero rate-limits per minute. */
const SWEEP_BATCH = 50;

export interface Caller {
  userId: string;
  name: string;
  roles: readonly Role[];
}

export interface XeroStatus {
  /** False when `XERO_PROVIDER=off` — the page explains rather than offering a dead button. */
  configured: boolean;
  connected: boolean;
  organisationName: string | null;
  connectedByName: string | null;
  connectedAt: string | null;
  lastRefreshAt: string | null;
  /** `connected` · `needs-reconnect` · `expiring` · `disconnected`. */
  state: 'connected' | 'needs-reconnect' | 'expiring' | 'disconnected';
  message: string | null;
  /** ISO. When the grant lapses if nothing refreshes it. */
  refreshExpiresAt: string | null;
  /** What an invoice becomes in Xero, so the page can state it plainly. */
  invoiceStatus: 'DRAFT' | 'AUTHORISED';
}

export const xeroService = {
  /**
   * What the Xero page renders.
   *
   * Never throws for an unconfigured or disconnected deployment: both are
   * ordinary states this screen exists to display, and a 503 would leave the
   * page unable to say why.
   */
  async status(caller: Caller): Promise<XeroStatus> {
    assertXeroAdmin(caller);

    const base = {
      configured: xeroClient.enabled,
      invoiceStatus: env.XERO_INVOICE_STATUS,
    };

    if (!xeroClient.enabled) {
      return {
        ...base,
        connected: false,
        organisationName: null,
        connectedByName: null,
        connectedAt: null,
        lastRefreshAt: null,
        state: 'disconnected',
        message:
          'Xero is not configured on this environment. Set XERO_PROVIDER=xero and the client credentials.',
        refreshExpiresAt: null,
      };
    }

    const connection = await xeroRepository.findConnection();

    if (!connection) {
      return {
        ...base,
        connected: false,
        organisationName: null,
        connectedByName: null,
        connectedAt: null,
        lastRefreshAt: null,
        state: 'disconnected',
        message: null,
        refreshExpiresAt: null,
      };
    }

    const expiring =
      connection.status === 'connected' &&
      connection.refreshExpiresAt.getTime() - Date.now() < REFRESH_WARN_MS;

    return {
      ...base,
      connected: connection.status === 'connected',
      organisationName: connection.tenantName,
      connectedByName: connection.connectedByName,
      connectedAt: connection.connectedAt.toISOString(),
      lastRefreshAt: connection.lastRefreshAt?.toISOString() ?? null,
      state:
        connection.status === 'needs-reconnect' ? 'needs-reconnect' : expiring ? 'expiring' : 'connected',
      message:
        connection.statusMessage ??
        (expiring
          ? 'This connection lapses soon. Reconnect to Xero to keep invoices syncing.'
          : null),
      refreshExpiresAt: connection.refreshExpiresAt.toISOString(),
    };
  },

  /**
   * Starts the handshake and returns where to send the browser.
   *
   * ── Why the server generates `state` and stores it ────────────────────
   * It is the only thing that proves the callback answers a request this
   * server started. Without it `GET /xero/callback` will accept any code any
   * caller presents — and an attacker who gets one signed-in admin to load a
   * crafted URL connects PlastaGo's invoicing to an organisation they control.
   * Every invoice the business raises then flows into a stranger's books.
   */
  async beginConnect(caller: Caller): Promise<{ authorizeUrl: string }> {
    assertXeroAdmin(caller);
    assertConfigured();

    // 256 bits. It only has to be unguessable for ten minutes, but there is no
    // reason to be clever about the size of a random string.
    const state = randomBytes(32).toString('base64url');

    await xeroRepository.createState({
      state,
      startedByUserId: caller.userId,
      startedByName: caller.name,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    });

    log.info({ by: caller.name }, 'xero authorisation started');

    return { authorizeUrl: xeroClient.authorizeUrl(state) };
  },

  /**
   * Handles Xero's redirect back.
   *
   * ── Why this returns a message instead of throwing ────────────────────
   * The caller is a browser mid-navigation, not an API client. Throwing would
   * render the API's JSON error envelope in the address bar — a dead end with
   * no way back to PlastaGo. Every outcome here is instead turned into a
   * redirect to the Xero page carrying a result the page can explain.
   */
  async completeCallback(input: {
    code: string | null;
    state: string | null;
    error: string | null;
  }): Promise<{ ok: boolean; message: string }> {
    if (input.error) {
      // The commonest value by far is `access_denied` — somebody pressed
      // Cancel on the consent screen, which is not a failure worth alarming
      // them about.
      const message =
        input.error === 'access_denied'
          ? 'Connection cancelled — nothing was changed.'
          : `Xero refused the authorisation (${input.error}).`;
      return { ok: false, message };
    }

    if (!input.code || !input.state) {
      return { ok: false, message: 'Xero sent an incomplete response. Try connecting again.' };
    }

    /*
     * Consumed atomically, so a replayed or double-submitted callback finds
     * nothing. This is also the CSRF check: a `state` we never issued has no
     * row, and the request dies here.
     */
    const pending = await xeroRepository.consumeState(input.state);

    if (!pending) {
      return {
        ok: false,
        message: 'That connection attempt has expired or was already used. Try connecting again.',
      };
    }

    // Belt and braces over the TTL index: Mongo's expiry monitor runs about
    // once a minute, so a row can briefly outlive its own stamp.
    if (pending.expiresAt.getTime() <= Date.now()) {
      return { ok: false, message: 'That connection attempt expired. Try connecting again.' };
    }

    const tokens = await xeroClient.exchangeCode(input.code);

    if (!tokens.ok) {
      log.error({ status: tokens.status, detail: tokens.detail }, 'xero code exchange failed');
      return { ok: false, message: tokens.detail };
    }

    const tenants = await xeroClient.connections(tokens.value.accessToken);

    if (!tenants.ok) {
      log.error({ status: tenants.status }, 'could not read the Xero connections');
      return { ok: false, message: tenants.detail };
    }

    const chosen = tenants.value[0];

    if (!chosen) {
      /*
       * Xero authorised us against no organisation at all. The realistic cause
       * is an account that only holds a PRACTICE — an accountant's own
       * workspace, which has no ledger to invoice into and is filtered out by
       * the client.
       */
      return {
        ok: false,
        message:
          'No Xero organisation was shared with PlastaGo. Choose an organisation on the Xero screen and try again.',
      };
    }

    if (tenants.value.length > 1) {
      /*
       * More than one organisation was approved and PlastaGo invoices from
       * exactly one set of books. Taking the first is a guess with a bad
       * failure mode — invoices silently landing in the wrong company — so the
       * first is used but the fact is logged loudly and named on the page.
       */
      log.warn(
        { count: tenants.value.length, chosen: chosen.tenantName },
        'more than one Xero organisation was authorised — using the first',
      );
    }

    await xeroRepository.saveConnection({
      tenantId: chosen.tenantId,
      connectionId: chosen.connectionId,
      tenantName: chosen.tenantName,
      accessTokenSealed: seal(tokens.value.accessToken),
      refreshTokenSealed: seal(tokens.value.refreshToken),
      accessExpiresAt: tokens.value.expiresAt,
      refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      connectedByUserId: pending.userId,
      connectedByName: pending.name,
    });

    log.info(
      { organisation: chosen.tenantName, by: pending.name },
      'xero connected',
    );

    return { ok: true, message: `Connected to ${chosen.tenantName}.` };
  },

  /**
   * Drops the connection, at Xero as well as here.
   *
   * The revoke is attempted but never allowed to block: a connection Xero has
   * already invalidated cannot be revoked again, and refusing to disconnect
   * locally because the remote call failed would trap the user in exactly the
   * broken state they are trying to clear.
   */
  async disconnect(caller: Caller): Promise<void> {
    assertXeroAdmin(caller);

    const connection = await xeroRepository.findConnection();

    if (!connection) {
      throw AppError.notFound('There is no Xero connection to disconnect');
    }

    try {
      const token = await withAccessToken(connection);
      const revoked = await xeroClient.disconnect(token, connection.connectionId);

      if (!revoked.ok) {
        log.warn(
          { status: revoked.status, detail: revoked.detail },
          'Xero would not revoke the connection — removing it locally anyway',
        );
      }
    } catch (error) {
      log.warn({ err: error }, 'could not reach Xero to revoke — removing it locally anyway');
    }

    await xeroRepository.deleteConnection();
    log.info({ by: caller.name }, 'xero disconnected');
  },

  /**
   * Pushes one invoice to Xero and records the outcome on it.
   *
   * ── Why this never throws ─────────────────────────────────────────────
   * Its callers are "send these forty invoices" and a background sweep.
   * Throwing would abandon the remaining thirty-nine because the fourth had a
   * bad account code. The outcome is written to the invoice instead, which is
   * where the office looks for it, and the badge on the row says what happened.
   */
  async pushInvoice(invoiceId: string): Promise<{ pushed: boolean; message: string | null }> {
    if (!xeroClient.enabled) return { pushed: false, message: null };

    const connection = await xeroRepository.findConnection();

    if (!connection || connection.status !== 'connected') {
      await invoiceRepository.recordXeroResult({
        id: invoiceId,
        state: 'failed',
        message: 'PlastaGo is not connected to Xero. Connect it on the Xero page.',
      });
      return { pushed: false, message: 'Not connected to Xero' };
    }

    const invoice = await xeroRepository.findPushable(invoiceId);

    if (!invoice) return { pushed: false, message: 'No such invoice' };

    /*
     * Only invoices that have actually been issued. A draft has no invoice
     * date, no due date and may still change — pushing it would put a document
     * in the accountant's ledger that PlastaGo still considers editable.
     */
    if (invoice.status === 'draft' || invoice.status === 'awaiting-po') {
      return { pushed: false, message: 'Not sent yet' };
    }

    let token: string;

    try {
      token = await withAccessToken(connection);
    } catch (error) {
      const message = error instanceof AppError ? error.message : 'Could not authenticate with Xero';
      await invoiceRepository.recordXeroResult({ id: invoiceId, state: 'failed', message });
      return { pushed: false, message };
    }

    const full = await invoiceRepository.findById(invoiceId, { accountId: null });

    if (!full) return { pushed: false, message: 'No such invoice' };

    /* ── The contact ──────────────────────────────────────────────────── */

    const contact = await resolveContact(token, connection.tenantId, {
      accountId: invoice.accountId,
      accountName: full.accountName,
    });

    if (!contact.ok) {
      await recordFailure(invoiceId, contact, connection);
      return { pushed: false, message: contact.detail };
    }

    /* ── The invoice ──────────────────────────────────────────────────── */

    const lines: XeroInvoiceLine[] = full.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      // Already a decimal STRING (§6A.10 #1). Never converted to a float —
      // that is how a cent goes missing on a hundred-line invoice.
      unitAmount: line.unitRate,
    }));

    if (lines.length === 0) {
      const message = 'This invoice has no lines, so there is nothing to send to Xero.';
      await invoiceRepository.recordXeroResult({ id: invoiceId, state: 'failed', message });
      return { pushed: false, message };
    }

    const pushed = await xeroClient.upsertInvoice(token, connection.tenantId, {
      ...(invoice.xeroInvoiceId ? { xeroInvoiceId: invoice.xeroInvoiceId } : {}),
      contactId: contact.value.contactId,
      invoiceNumber: String(invoice.invoiceNumber),
      // Already `YYYY-MM-DD`. Falling back to today rather than sending null:
      // Xero requires a date, and the invoice was issued whether or not the
      // field was stamped.
      date: invoice.issuedOn ?? today(),
      dueDate: invoice.dueOn ?? invoice.issuedOn ?? today(),
      reference: invoice.poNumber,
      lines,
    });

    if (!pushed.ok) {
      await recordFailure(invoiceId, pushed, connection);
      return { pushed: false, message: pushed.detail };
    }

    await invoiceRepository.recordXeroResult({
      id: invoiceId,
      state: 'synced',
      message: null,
      xeroInvoiceId: pushed.value.invoiceId,
    });

    log.info(
      { invoiceId, invoiceNumber: invoice.invoiceNumber, xeroInvoiceId: pushed.value.invoiceId },
      'invoice pushed to Xero',
    );

    return { pushed: true, message: null };
  },

  /**
   * Reads invoices back from Xero and marks the paid ones paid.
   *
   * ── Why polling and not a Xero webhook ────────────────────────────────
   * A webhook needs a publicly reachable HTTPS endpoint, an intent-to-receive
   * handshake and payload signature verification — and PlastaGo has no public
   * URL yet (the same thing blocking the PO extractor's callback). Polling
   * works today, costs one batched call per fifty invoices, and the switch to
   * webhooks later changes only what triggers this function.
   */
  async syncPayments(): Promise<{ checked: number; paid: number }> {
    if (!xeroClient.enabled) return { checked: 0, paid: 0 };

    const connection = await xeroRepository.findConnection();
    if (!connection || connection.status !== 'connected') return { checked: 0, paid: 0 };

    const candidates = await xeroRepository.findAwaitingPayment(SWEEP_BATCH);
    if (candidates.length === 0) return { checked: 0, paid: 0 };

    let token: string;

    try {
      token = await withAccessToken(connection);
    } catch (error) {
      log.warn({ err: error }, 'payment sweep could not authenticate with Xero');
      return { checked: 0, paid: 0 };
    }

    const byXeroId = new Map(
      candidates
        .filter((row): row is typeof row & { xeroInvoiceId: string } => row.xeroInvoiceId !== null)
        .map((row) => [row.xeroInvoiceId, row.id]),
    );

    const result = await xeroClient.getInvoices(token, connection.tenantId, [...byXeroId.keys()]);

    if (!result.ok) {
      if (meansConnectionDead(result)) await markDead(result.detail);
      log.warn({ detail: result.detail }, 'payment sweep could not read invoices');
      return { checked: 0, paid: 0 };
    }

    let paid = 0;

    for (const remote of result.value) {
      const localId = byXeroId.get(remote.invoiceId);
      if (!localId) continue;

      // `PAID` is Xero's own terminal state. `amountDue === 0` is checked too
      // because an invoice settled by a credit note reaches zero without ever
      // being stamped PAID, and the office would otherwise chase it forever.
      const settled = remote.status === 'PAID' || (remote.amountDue !== null && remote.amountDue <= 0);

      if (settled) {
        await xeroRepository.markPaid(
          localId,
          remote.fullyPaidOnDate ? new Date(remote.fullyPaidOnDate) : new Date(),
        );
        paid += 1;
      }
    }

    // Everything looked at gets its sweep stamp moved, paid or not — otherwise
    // the oldest-first sort never advances past the same fifty rows.
    await xeroRepository.touchSynced(candidates.map((row) => row.id));

    if (paid > 0) log.info({ checked: candidates.length, paid }, 'xero payment sweep');

    return { checked: candidates.length, paid };
  },
};

/* ── Tokens ──────────────────────────────────────────────────────────────── */

/**
 * In-flight refresh, shared by every caller that arrives during one.
 *
 * ── The race this closes ──────────────────────────────────────────────────
 * Sending forty invoices fires forty pushes at once. If the access token has
 * expired, all forty refresh — and because Xero invalidates the old refresh
 * token on first use, the first succeeds and the other thirty-nine present a
 * token that is already dead. The connection is then destroyed by the very act
 * of using it, and every one of those invoices reports "reconnect required".
 *
 * ⚠️ This guard is per PROCESS. Two API instances refreshing at the same
 * instant can still collide; the loser reports needs-reconnect and Matthew
 * reconnects once. Closing that properly needs a lock in Mongo or Redis, which
 * is worth doing when the API is actually scaled out — and is a much smaller
 * change than the one this comment would otherwise be hiding.
 */
let refreshInFlight: Promise<string> | null = null;

/**
 * A usable access token, refreshing first if the stored one has expired.
 *
 * Throws rather than returning a result: every caller treats "no token" as
 * fatal to its own work, and each already records that outcome its own way.
 */
async function withAccessToken(connection: XeroConnectionRow): Promise<string> {
  if (!isExpired(connection.accessExpiresAt)) return open(connection.accessTokenSealed);

  refreshInFlight ??= doRefresh(connection).finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

async function doRefresh(connection: XeroConnectionRow): Promise<string> {
  const refreshed = await xeroClient.refresh(open(connection.refreshTokenSealed));

  if (!refreshed.ok) {
    /*
     * A refusal here is terminal. The refresh token was spent or revoked, and
     * nothing this process can do will produce another one — only a human
     * re-authorising will. Marking it means the page stops offering a retry
     * that cannot work and offers Reconnect instead.
     */
    const message = refreshed.detail;
    await markDead(message);
    throw AppError.dependencyUnavailable(
      'The Xero connection has lapsed. Reconnect to Xero on the Xero page.',
    );
  }

  /*
   * ⚠️ Persisted BEFORE the token is returned to anyone.
   *
   * The refresh token in this response replaces one Xero has already killed.
   * If the caller used the access token first and the process died before this
   * write, the connection would be unrecoverable — we would hold a refresh
   * token Xero no longer honours and no copy of the one it issued.
   */
  await xeroRepository.updateTokens({
    accessTokenSealed: seal(refreshed.value.accessToken),
    refreshTokenSealed: seal(refreshed.value.refreshToken),
    accessExpiresAt: refreshed.value.expiresAt,
    refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_MS),
  });

  log.info('xero access token refreshed');

  return refreshed.value.accessToken;
}

async function markDead(message: string): Promise<void> {
  await xeroRepository.markNeedsReconnect(message);
}

/* ── Contacts ────────────────────────────────────────────────────────────── */

/**
 * The Xero contact for one PlastaGo account, created if it does not exist.
 *
 * Looked up by name every push rather than cached on the account. The contact
 * can be renamed, merged or archived inside Xero by the accountant at any
 * time, and a stored id that no longer resolves fails with a validation error
 * nobody can interpret. A lookup costs one call and is always right.
 */
async function resolveContact(
  token: string,
  tenantId: string,
  account: { accountId: string; accountName: string },
): Promise<XeroResult<{ contactId: string }>> {
  const found = await xeroClient.findContact(token, tenantId, account.accountName);

  if (!found.ok) return found;
  if (found.value) return { ok: true, value: { contactId: found.value.contactId } };

  /*
   * Accounts payable, not the site contact — the same choice `emailInvoice`
   * makes, and for the same reason: the AP desk is who chases the invoice.
   * Falling back to any contact with an address, because a Xero contact with
   * no email still bills correctly, it just cannot be emailed from Xero.
   */
  const record = await accountRepository.findById(account.accountId, { accountId: null });
  const contacts = record?.contacts ?? [];
  const payable = contacts.find((contact) => contact.role === 'accounts' && contact.email);
  const email = payable?.email ?? contacts.find((contact) => contact.email)?.email ?? null;

  const created = await xeroClient.createContact(token, tenantId, {
    name: account.accountName,
    email,
  });

  if (!created.ok) return created;

  log.info({ name: account.accountName }, 'created a Xero contact');

  return { ok: true, value: { contactId: created.value.contactId } };
}

/* ── Shared helpers ──────────────────────────────────────────────────────── */

async function recordFailure(
  invoiceId: string,
  result: { ok: false; status: number; detail: string },
  connection: XeroConnectionRow,
): Promise<void> {
  if (meansConnectionDead(result)) await markDead(result.detail);

  await invoiceRepository.recordXeroResult({
    id: invoiceId,
    state: 'failed',
    message: result.detail,
  });

  log.warn(
    { invoiceId, status: result.status, organisation: connection.tenantName },
    'xero push failed',
  );
}

/**
 * Today as `YYYY-MM-DD`.
 *
 * ⚠️ Sydney, not UTC. Between midnight and 10am AEST the UTC date is still
 * yesterday, so `toISOString().slice(0, 10)` would date a morning invoice to
 * the previous day — and in Xero that can land it in a closed period.
 */
function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function assertXeroAdmin(caller: Caller): void {
  if (!caller.roles.some((role) => XERO_ADMIN_ROLES.has(role))) {
    throw AppError.forbidden(
      'Only a super administrator can manage the Xero connection',
    );
  }
}

function assertConfigured(): void {
  if (!xeroClient.enabled) {
    throw AppError.dependencyUnavailable(
      'Xero is not configured on this environment. Set XERO_PROVIDER=xero and the client credentials.',
    );
  }
}
