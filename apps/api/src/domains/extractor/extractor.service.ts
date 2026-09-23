import { env } from '../../config/env.js';
import {
  extractorClient,
  meansNotAMember,
  meansStaleToken,
  setOwnerCredentialsResolver,
  type ExtractorResult,
} from '../../integrations/extractor.js';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { extractorRepository } from './extractor.repository.js';

const log = logger.child({ module: 'extractor-session' });

/**
 * The session broker behind the Extractor tab (I6).
 *
 * ── What this exists to prevent ───────────────────────────────────────────
 * The extractor can be embedded by putting an embed token in the iframe URL.
 * That token is a tenant-wide credential with no expiry, and a URL is the least
 * private thing in a browser: it is in history, in the referrer, in any
 * screenshot of the address bar, and in every proxy log between here and there.
 *
 * So the token never leaves the server. The browser is given a session id
 * instead — one user, one day, revocable — and this file is the only thing that
 * can mint one.
 *
 * ── Why the recovery branches are worth their complexity ──────────────────
 * Two states are both normal and unrecoverable without them:
 *
 *  1. A PlastaGo user who has never opened the tab is not a member of the
 *     extractor tenant, so their first session request fails. Every new office
 *     hire hits this.
 *  2. A token revoked at the vendor leaves us holding a dead credential, and
 *     nothing in the running process can fix that by retrying.
 *
 * Both are repaired here, once per request, and both are session-authenticated:
 * there is no legacy-header path in this file.
 */

/**
 * PlastaGo's tenant discriminator.
 *
 * Single-tenant, so this is a constant rather than a lookup — but it is a NAMED
 * constant, because the day a second extractor tenant exists this is the value
 * that has to come from the request instead, and a literal sprinkled through
 * four call sites is how that migration gets missed.
 */
const TENANT_ID = 'plastago';

/** Matches the Application registered in the extractor's admin dashboard. */
const APP_NAME = 'plastago-admin';

/**
 * How much life a cached session must have left to be reused.
 *
 * Five minutes, per the integration guide's own advice. A session handed over
 * with less than that expires while somebody is mid-upload, and the iframe's
 * failure mode is a blank panel with no way back except a reload the user has
 * no reason to try.
 */
const MIN_REMAINING_MS = 5 * 60_000;

export interface BrokeredSession {
  sessionId: string;
  /** ISO 8601. The frontend re-mints rather than waiting to be told it failed. */
  expiresAt: string;
}

export interface Caller {
  userId: string;
  name: string;
}

/**
 * Points the vendor client at the embed-token collection.
 *
 * ── Why every entry point calls this ──────────────────────────────────────
 * The token is stored, not configured (see `extractor.model.ts`), and
 * `integrations/extractor.ts` must not read Mongo itself (§6A.3). So the store
 * is handed in, and it has to be handed in by whoever starts the process:
 * `index.ts` for the API, `worker.ts` for the background queues, and
 * `setup-extractor.ts` for the one script that talks to the vendor directly.
 *
 * Safe to call more than once, and cheap — it installs a closure, it does not
 * read anything. A process that forgets falls back to env rather than breaking.
 */
export function wireExtractor(): void {
  setOwnerCredentialsResolver(async () => {
    const stored = await extractorRepository.findToken(TENANT_ID, APP_NAME);
    if (!stored) return null;

    /*
     * Rows written before `ownerEmail` existed carry none, and env is the only
     * place left that knows who the tenant was onboarded as. Returning null
     * rather than guessing lets the client raise its own named error.
     */
    const userEmail = stored.ownerEmail ?? env.EXTRACTOR_USER_EMAIL ?? null;
    if (!userEmail) return null;

    return { embedToken: stored.token, userEmail };
  });
}

export const extractorService = {
  /**
   * A session for one signed-in user, cached where possible.
   *
   * Steps follow the integration order: cache, token, onboard-if-missing,
   * mint, recover, store.
   */
  async sessionFor(caller: Caller): Promise<BrokeredSession> {
    if (!extractorClient.enabled) {
      throw AppError.dependencyUnavailable(
        'The document extractor is not configured for this deployment',
      );
    }

    /* ── 1. The cache ──────────────────────────────────────────────────── */

    const cached = await extractorRepository.findSession({
      tenantId: TENANT_ID,
      userId: caller.userId,
      notBefore: new Date(Date.now() + MIN_REMAINING_MS),
    });

    if (cached) {
      return { sessionId: cached.sessionId, expiresAt: cached.expiresAt.toISOString() };
    }

    /* ── 2. Who the extractor will think is acting ─────────────────────── */

    const identity = await extractorRepository.findIdentity(caller.userId);

    if (!identity?.email) {
      /*
       * ⚠️ Refused rather than substituted.
       *
       * PlastaGo signs drivers and site supervisors in by SMS, so `email` is
       * nullable and a staff account can genuinely have none. The tempting fix
       * is to fall back to the platform address — and that would attribute this
       * person's uploads and template edits to "PlastaGo Platform" in the
       * extractor's activity log, which is the one thing that log exists to
       * get right.
       */
      throw AppError.validation(
        'Your account needs an email address before you can use the Extractor. Ask an administrator to add one.',
      );
    }

    /* ── 3. The embed token ────────────────────────────────────────────── */

    const token = await currentToken();

    /* ── 4. Mint, with one round of recovery ───────────────────────────── */

    let result = await extractorClient.createSessionWithToken(identity.email, token.token);

    if (!result.ok && meansStaleToken(result)) {
      log.warn(
        { detail: result.detail },
        'the stored embed token was rejected — re-onboarding and retrying once',
      );

      await extractorRepository.deleteToken(TENANT_ID, APP_NAME);
      const fresh = await currentToken();
      result = await extractorClient.createSessionWithToken(identity.email, fresh.token);
    } else if (!result.ok && meansNotAMember(result)) {
      log.info(
        { userId: caller.userId },
        'first Extractor visit for this user — adding them to the tenant',
      );

      await addToTenant(identity.email, identity.name);
      result = await extractorClient.createSessionWithToken(identity.email, token.token);
    }

    const session = unwrapOrThrow(result);

    /* ── 5. Cache it ───────────────────────────────────────────────────── */

    const expiresAt = new Date(session.expiresAt);

    await extractorRepository.saveSession({
      tenantId: TENANT_ID,
      userId: caller.userId,
      sessionId: session.sessionId,
      expiresAt,
    });

    log.info({ userId: caller.userId, expiresAt }, 'extractor session brokered');

    return { sessionId: session.sessionId, expiresAt: expiresAt.toISOString() };
  },

  /**
   * Forgets this user's cached session.
   *
   * Exposed so the frontend can recover from an "Invalid session" inside the
   * iframe without an administrator clearing a collection. It does not revoke
   * the session at the vendor: a session the browser has already been given may
   * still be in use in another tab, and the row expiring on its own is the
   * lesser harm than pulling it out from under a live upload.
   */
  async forget(caller: Caller): Promise<void> {
    await extractorRepository.deleteSession(TENANT_ID, caller.userId);
  },
};

/* ── The token, from cache or from onboarding ────────────────────────────── */

/**
 * The tenant's embed token.
 *
 * ── Why env is a seed rather than the source ──────────────────────────────
 * `EXTRACTOR_EMBED_TOKEN` is what this deployment was onboarded with and it is
 * almost certainly correct — but it cannot be rotated by a running process. So
 * it is adopted into the collection on first use, and from then on the row is
 * what is read. That gives the recovery branch above something it can actually
 * repair.
 */
async function currentToken(): Promise<{ token: string }> {
  const stored = await extractorRepository.findToken(TENANT_ID, APP_NAME);
  if (stored) return { token: stored.token };

  if (env.EXTRACTOR_EMBED_TOKEN) {
    await extractorRepository.saveToken({
      tenantId: TENANT_ID,
      appName: APP_NAME,
      token: env.EXTRACTOR_EMBED_TOKEN,
      tokenId: null,
      organizationId: null,
      appId: env.EXTRACTOR_APP_ID ?? null,
      ownerEmail: env.EXTRACTOR_USER_EMAIL ?? null,
    });

    log.info('adopted EXTRACTOR_EMBED_TOKEN into the embed-token cache');
    return { token: env.EXTRACTOR_EMBED_TOKEN };
  }

  /*
   * Nothing stored and nothing in env.
   *
   * ⚠️ This REFUSES; it used to onboard. Onboarding creates a tenant, and a
   * tenant is not a thing to create as a side effect of somebody opening a tab.
   *
   * The branch existed when `EXTRACTOR_EMBED_TOKEN` was mandatory at boot,
   * which made it unreachable in practice — the process could not start
   * without the very value whose absence it handled. Now that the token lives
   * in the database and boot no longer demands it, the branch is reachable,
   * and what it would do is the one irreversible mistake available here: a
   * SECOND PlastaGo tenant, empty, with the real one's mailbox and templates
   * stranded behind a credential nobody holds.
   *
   * Onboarding stays where it can be done deliberately and once:
   * `npm run setup:extractor -- --onboard`.
   */
  throw AppError.dependencyUnavailable(
    'The document extractor has no embed token on file. Restore the token for the ' +
      'existing tenant — do not onboard again, which would create a second one.',
  );
}

/**
 * Adds a PlastaGo user to the extractor tenant, session-authenticated.
 *
 * ⚠️ This is the step that would otherwise need the deprecated header auth.
 * Creating a member requires a session, and the caller has none — that is the
 * failure being recovered. The OWNER's session is used instead: it is already
 * cached on this server for the ingestion pipeline, its holder is a member by
 * construction, and it never leaves the process.
 */
async function addToTenant(email: string, fullName: string): Promise<void> {
  const ownerSessionId = await extractorClient.ownerSessionId();
  const { firstName, lastName } = splitName(fullName);

  const result = await extractorClient.addMember(ownerSessionId, { firstName, lastName, email });

  if (!result.ok) {
    log.error({ status: result.status, detail: result.detail }, 'could not add the user');
    throw AppError.dependencyUnavailable(
      'Could not register you with the document extractor. Try again shortly.',
    );
  }
}

/**
 * A single `name` field split for a vendor that wants two.
 *
 * PlastaGo stores one name because that is what an audit trail prints. The
 * remainder goes to `lastName` rather than the second word alone, so
 * "Mary Anne Van Der Berg" keeps everything after the first space instead of
 * silently dropping two of her names.
 */
function splitName(fullName: string): { firstName: string; lastName: string } {
  const trimmed = fullName.trim();
  const space = trimmed.indexOf(' ');

  if (space === -1) {
    // The vendor requires both. A repeated name is honest; an empty string or a
    // placeholder like "-" would read as data corruption on their screen.
    return { firstName: trimmed, lastName: trimmed };
  }

  return {
    firstName: trimmed.slice(0, space),
    lastName: trimmed.slice(space + 1).trim(),
  };
}

/**
 * Turns a failed vendor call into an error the office can act on.
 *
 * ⚠️ The vendor's own message is logged, not returned. It can name internal
 * hosts and, on a failed extraction call, echo document text — and this
 * response goes to a browser.
 */
function unwrapOrThrow<T>(result: ExtractorResult<T>): T {
  if (result.ok) return result.value;

  log.error({ status: result.status, detail: result.detail }, 'could not broker a session');

  if (result.status === 403 || result.status === 401) {
    throw AppError.forbidden('The document extractor refused your account');
  }

  throw AppError.dependencyUnavailable(
    'The document extractor is unavailable right now. Try again shortly.',
  );
}
