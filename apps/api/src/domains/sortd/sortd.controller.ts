import { ROLES, SURFACES, type Role, type Surface } from '@plastago/shared';
import type { Request, Response } from 'express';
import { sortdBaseUrl } from '../../config/env.js';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { sortdWebhookService } from './sortd-webhook.service.js';
import { sortdService, type SortdCaller } from './sortd.service.js';

const log = logger.child({ module: 'sortd' });

/** Controller layer — HTTP in, HTTP out. No business rules, no Mongoose. */

/**
 * What the widget receives. `enabled: false` is a normal answer, not an error
 * — a surface with no Sortd key is a supported deployment, and the widget has
 * to tell that apart from a request that failed.
 */
type SortdSessionResponse =
  | { enabled: false }
  | { enabled: true; baseUrl: string; sessionId: string; expiresAt: string };

/**
 * Identity from `req.auth` and nowhere else — not the body, not the query.
 * That is what makes it impossible to open the widget as somebody else,
 * whatever the client sends.
 */
function callerFrom(req: Request): SortdCaller {
  if (!req.auth) throw AppError.unauthenticated('Sign in to continue');

  const role = req.auth.role;
  if (!(ROLES as readonly string[]).includes(role)) {
    throw AppError.forbidden('Your role does not allow that');
  }

  return { userId: req.auth.userId, role: role as Role, accountId: req.auth.accountId };
}

function isSurface(value: unknown): value is Surface {
  return typeof value === 'string' && (SURFACES as readonly string[]).includes(value);
}

export const sortdController = {
  /** GET /sortd/session */
  session: async (req: Request, res: Response): Promise<void> => {
    const caller = callerFrom(req);

    // A bearer credential for one person's support history: never cached by a
    // browser or a proxy between here and there.
    res.set('cache-control', 'no-store');

    if (!sortdService.enabledFor(caller)) {
      res.json({ enabled: false } satisfies SortdSessionResponse);
      return;
    }

    try {
      const session = await sortdService.sessionFor(caller);

      res.json(
        (session
          ? { enabled: true, baseUrl: sortdBaseUrl, ...session }
          : { enabled: false }) satisfies SortdSessionResponse,
      );
    } catch (error) {
      /*
       * ⚠️ THE ONE ROUTE THAT SWALLOWS ITS OWN ERROR AND STILL ANSWERS 200.
       *
       * The bubble sits on every screen of every surface. A 500 here would put
       * an error on pages that are working perfectly, and make a Sortd outage
       * look like a PlastaGo outage to every user at once. Whoever is on call
       * gets the log line; the user sees no bubble and carries on.
       *
       * Safe precisely because support is an accessory: there is no state to
       * corrupt and no decision that silently goes the wrong way.
       */
      log.error(
        { err: error, userId: caller.userId, role: caller.role },
        'could not open a Sortd support session',
      );
      res.json({ enabled: false } satisfies SortdSessionResponse);
    }
  },

  /**
   * DELETE /sortd/session — on sign-out, while the caller can still be
   * identified. The local rows are removed whether or not Sortd answers.
   */
  revoke: async (req: Request, res: Response): Promise<void> => {
    await sortdService.revoke(callerFrom(req).userId);
    res.status(204).send();
  },

  /**
   * POST /api/v1/webhooks/sortd/:surface
   *
   * Authenticated by its signature alone — there is no session on an inbound
   * call. See `server.ts` for why it is mounted ahead of the JSON parser.
   */
  webhook: async (req: Request, res: Response): Promise<void> => {
    const surface = req.params.surface;

    if (!isSurface(surface)) {
      throw AppError.notFound('No such Sortd app');
    }

    /*
     * `express.raw()` yields a Buffer. If a future refactor mounted a JSON
     * parser ahead of this route, the body would be an object and every
     * signature would fail as "bad signature" — so the shape is asserted and
     * reported as our fault instead.
     */
    if (!Buffer.isBuffer(req.body)) {
      // A plain Error, so the handler logs it as the bug it is and answers 500.
      throw new Error('Sortd webhook did not receive a raw body — check the mount order');
    }

    const outcome = await sortdWebhookService.receive({
      surface,
      rawBody: req.body.toString('utf8'),
      timestamp: req.get('x-sortd-timestamp') ?? '',
      signature: req.get('x-sortd-signature') ?? '',
    });

    res.status(outcome.status).json(outcome.body);
  },
};
