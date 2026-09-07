import type { Role } from '@plastago/shared';
import type { RequestHandler } from 'express';
import { authService } from '../domains/auth/auth.service.js';
import { AppError } from '../lib/app-error.js';

/**
 * The gate every other domain sits behind (§9 · M1.5).
 *
 * ── Why the session is re-read from the database on each request ────────────
 * The cookie could carry the role instead, and that would be one query cheaper.
 * But a role is a live fact: an allocator taking over a sick driver's shift
 * changes theirs mid-morning, and an offboarded user is suspended precisely so
 * they stop being able to act. A role baked into a token stays true for the
 * life of that token, which is the wrong answer for both.
 *
 * `authService.getSession` already re-reads the user record and refuses a
 * suspended one, so revocation takes effect on the next request rather than at
 * the next sign-in.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  void (async () => {
    try {
      const session = await authService.getSession({
        ip: req.ip ?? null,
        headers: toHeaders(req.headers),
      });

      if (!session) {
        next(AppError.unauthenticated('Sign in to continue'));
        return;
      }

      req.auth = {
        userId: session.user.id,
        // Who to write into an audit trail. Taken from the session rather than
        // from the request, so a caller cannot sign somebody else's name to a
        // job event.
        name: session.user.name,
        roles: session.user.roles,
        // Carried so repositories can scope by it without a second lookup.
        accountId: session.user.accountId,
      };
      next();
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * Role gate. Use AFTER `requireAuth`.
 *
 * ⚠️ Deliberately coarse. The web app's capability matrix
 * (`features/auth/permissions.ts`) is the detailed model and it belongs there,
 * because it also drives navigation and route guards. This is the server's
 * backstop: it answers "may this kind of user reach this endpoint at all",
 * which is the question a browser cannot be trusted to answer.
 *
 * Row-level scoping — a site supervisor seeing only their own sites — is NOT
 * this middleware's job. It happens in the repository, from `req.auth`
 * (§6A.3 #5), because a filter applied in a controller is one somebody can
 * forget to apply.
 */
export function requireRole(...allowed: readonly Role[]): RequestHandler {
  const permitted = new Set<string>(allowed);

  return (req, _res, next) => {
    if (!req.auth) {
      // A programming error: the route was mounted without `requireAuth`.
      next(AppError.unauthenticated('Sign in to continue'));
      return;
    }

    if (!req.auth.roles.some((role) => permitted.has(role))) {
      next(AppError.forbidden('Your role does not allow that'));
      return;
    }

    next();
  };
}

function toHeaders(source: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  return headers;
}
