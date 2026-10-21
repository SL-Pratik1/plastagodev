import { ROLE_SURFACE, type Role, type Surface } from '@plastago/shared';
import { sortdClient, type SortdRole, type SortdSession } from '../../integrations/sortd.js';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { sortdRepository, type CachedSortdSession } from './sortd.repository.js';

const log = logger.child({ module: 'sortd-session' });

/**
 * Sortd support sessions — the server half of the support bubble.
 *
 * The browser asks for a session and is handed an opaque one-day id. The key
 * that mints it stays in `integrations/sortd.ts`; nothing in this file or its
 * callers ever holds one.
 */

/** Who a session is minted for. Always the caller, from `req.auth`. */
export interface SortdCaller {
  userId: string;
  /** The ACTIVE role — it decides the surface, and so which Sortd app. */
  role: Role;
  accountId: string | null;
}

/**
 * Re-mint this far ahead of Sortd's own expiry.
 *
 * A session that lapses mid-conversation reads as the widget breaking, so the
 * margin makes sure a page that was already open never holds one past its end.
 */
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * PlastaGo role → Sortd role.
 *
 * A Record rather than a rule, because PlastaGo's roles are a fixed list in
 * code (unlike armpal's, which are data). A role added to `ROLES` will not
 * compile until somebody decides here what it may see in support.
 *
 * - `owner` sees every ticket in the app. PlastaGo's administrator, nobody
 *   else.
 * - `admin` sees every ticket in its `appTenantId`. A customer administrator,
 *   over their own account — see `identityFor` for the tenant.
 * - `user` sees only their own tickets. Everyone else.
 */
const SORTD_ROLE: Record<Role, SortdRole> = {
  'super-admin': 'owner',
  operations: 'user',
  'office-staff': 'user',
  allocator: 'user',
  driver: 'user',
  'customer-administrator': 'admin',
  'customer-site-supervisor': 'user',
};

/** The two customer roles, whose tickets carry their account as the tenant. */
const CUSTOMER_ROLES: ReadonlySet<Role> = new Set(['customer-administrator', 'customer-site-supervisor']);

export interface SortdAccess {
  surface: Surface;
  sortdRole: SortdRole;
  appTenantId: string | null;
}

/**
 * Which app, which Sortd role and which tenant this caller gets.
 *
 * ⚠️ NEVER `admin` WITHOUT A TENANT. Sortd treats an `admin` session with no
 * `appTenantId` as seeing every ticket in the app — every customer's support
 * history at once. A customer administrator with no account on their record is
 * a data fault, and the answer to a data fault is no bubble, not the widest
 * view Sortd has.
 *
 * Exported for the test that walks every role.
 */
export function accessFor(caller: SortdCaller): SortdAccess {
  const sortdRole = SORTD_ROLE[caller.role];
  const appTenantId = CUSTOMER_ROLES.has(caller.role) ? caller.accountId : null;

  if (sortdRole === 'admin' && !appTenantId) {
    throw AppError.forbidden('A customer administrator needs an account to open support');
  }

  return { surface: ROLE_SURFACE[caller.role], sortdRole, appTenantId };
}

/**
 * The address Sortd is given for someone with no email.
 *
 * ── Why a placeholder at all ──────────────────────────────────────────────
 * Sortd requires `email` on every session, and PlastaGo signs drivers and site
 * supervisors in by SMS — most of them have no address. Refusing them would
 * take support away from exactly the people standing on a site with a
 * question. `externalUserId` is what Sortd keys the person on; the email is
 * only a label.
 *
 * ── Why `.invalid` ────────────────────────────────────────────────────────
 * RFC 2606 reserves it: no mail can ever be delivered there. A made-up address
 * on plastago.com.au could land in somebody's catch-all, and anything Sortd
 * sends to it would be a support conversation read by the wrong person.
 */
export function placeholderEmailFor(userId: string): string {
  return `user-${userId}@no-email.plastago.invalid`;
}

function toSession(row: Pick<CachedSortdSession, 'sessionId' | 'expiresAt'>): SortdSession {
  return { sessionId: row.sessionId, expiresAt: row.expiresAt.toISOString() };
}

/** Revokes at Sortd without letting a failure reach the caller. */
async function revokeQuietly(surface: Surface, sessionId: string): Promise<void> {
  if (!sortdClient.enabled(surface)) return;

  try {
    await sortdClient.revokeSession(surface, sessionId);
  } catch (error) {
    // It lapses on its own within a day; never block the caller on Sortd.
    log.warn({ err: error, surface }, 'could not revoke a Sortd session remotely');
  }
}

export const sortdService = {
  /** True when the caller's surface has a Sortd app to talk to. */
  enabledFor(caller: SortdCaller): boolean {
    return sortdClient.enabled(ROLE_SURFACE[caller.role]);
  },

  /**
   * The caller's support session, reusing a cached one wherever possible.
   *
   * Cheapest first, each step reached only because the one before could not
   * serve the request:
   *
   *  1. A cached session minted as the same role and tenant, with time left.
   *     Nearly every call.
   *  2. The same, near expiry — EXTENDED rather than replaced, so a
   *     conversation part-way through survives the boundary.
   *  3. A fresh mint: nothing cached, a refresh Sortd refused, or a cached
   *     session minted as a role or tenant the caller no longer has.
   *
   * Returns null when this surface has no Sortd app. Anything else throws; the
   * controller decides how quietly to fail.
   */
  async sessionFor(caller: SortdCaller): Promise<SortdSession | null> {
    const access = accessFor(caller);
    const { surface } = access;

    if (!sortdClient.enabled(surface)) return null;

    const cached = await sortdRepository.findSession(caller.userId, surface);

    if (cached) {
      const sameAccess =
        cached.sortdRole === access.sortdRole && cached.appTenantId === access.appTenantId;

      if (!sameAccess) {
        /*
         * Their role or account changed since this was minted. The old session
         * still opens Sortd with the old visibility, so it is revoked rather
         * than merely replaced — overwriting the row alone would leave it live
         * at Sortd for the rest of its day.
         */
        log.info(
          { userId: caller.userId, surface, from: cached.sortdRole, to: access.sortdRole },
          'Sortd access changed — replacing the cached session',
        );
        await revokeQuietly(surface, cached.sessionId);
      } else if (cached.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) {
        return toSession(cached);
      } else {
        try {
          const refreshed = await sortdClient.refreshSession(surface, cached.sessionId);
          await sortdRepository.saveSession({
            userId: caller.userId,
            ...access,
            sessionId: refreshed.sessionId,
            expiresAt: new Date(refreshed.expiresAt),
          });
          return refreshed;
        } catch {
          /*
           * Swallowed HERE only. A refusal means Sortd no longer knows this
           * session — revoked elsewhere, or expired while nobody was signed
           * in. That is an ordinary state, and the answer is the mint below.
           */
        }
      }
    }

    const identity = await sortdRepository.findIdentity(caller.userId);
    if (!identity) throw AppError.unauthenticated('Sign in to continue');

    const appTenantName = access.appTenantId
      ? await sortdRepository.findAccountName(access.appTenantId)
      : null;

    const minted = await sortdClient.createSession(surface, {
      externalUserId: caller.userId,
      email: identity.email ?? placeholderEmailFor(caller.userId),
      name: identity.name,
      role: access.sortdRole,
      ...(access.appTenantId ? { appTenantId: access.appTenantId } : {}),
      ...(appTenantName ? { appTenantName } : {}),
    });

    await sortdRepository.saveSession({
      userId: caller.userId,
      ...access,
      sessionId: minted.sessionId,
      expiresAt: new Date(minted.expiresAt),
    });

    log.info({ userId: caller.userId, surface, role: access.sortdRole }, 'Sortd session minted');

    return minted;
  },

  /**
   * Ends every support session this person holds, on sign-out.
   *
   * ⚠️ THE LOCAL ROWS GO FIRST and Sortd is told second. If the remote call
   * fails, the session lapses on its own within a day; if a local row survived
   * instead, the next sign-in on this browser could be handed back a session
   * that was meant to be over. So the delete never waits on the network.
   *
   * Every surface, not just the current one: an allocator who covered a shift
   * today holds a driver-app session as well as a console one.
   */
  async revoke(userId: string): Promise<void> {
    const sessions = await sortdRepository.takeAllSessions(userId);

    await Promise.all(sessions.map((session) => revokeQuietly(session.surface, session.sessionId)));
  },
};
