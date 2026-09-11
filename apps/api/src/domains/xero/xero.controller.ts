import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/app-error.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { type XeroCallbackQuerySchema } from './xero.schemas.js';
import { xeroService, type Caller } from './xero.service.js';

/** Controller layer — HTTP in, HTTP out. No business rules, no Mongoose. */

function callerFrom(req: Request): Caller {
  if (!req.auth) throw AppError.unauthenticated('Sign in to continue');
  // `req.auth.roles` is widened to `string[]` on the Express type. Narrowed
  // here the same way `invoice.controller` does, at the one boundary where the
  // session's shape meets the domain's.
  return {
    userId: req.auth.userId,
    name: req.auth.name,
    roles: req.auth.roles as Caller['roles'],
  };
}

/** Where the browser is sent after the Xero round trip, success or not. */
const XERO_PAGE = '/admin/xero';

export const xeroController = {
  status: async (req: Request, res: Response): Promise<void> => {
    res.json(await xeroService.status(callerFrom(req)));
  },

  /**
   * Hands back the Xero URL rather than redirecting.
   *
   * ── Why not a 302 ─────────────────────────────────────────────────────
   * The caller is `fetch` from a signed-in page, and a redirect would be
   * followed by the fetch itself — landing Xero's HTML login page inside an
   * XHR response where nothing can render it. The page needs the URL so it can
   * navigate the WHOLE window, which is the only thing that works for a
   * third-party login.
   *
   * POST because it creates a single-use state row, and a GET that does that
   * is one a browser or a link prefetcher is entitled to repeat.
   */
  connect: async (req: Request, res: Response): Promise<void> => {
    res.status(201).json(await xeroService.beginConnect(callerFrom(req)));
  },

  /**
   * Xero's redirect back. Deliberately unauthenticated — see the router.
   *
   * Always answers with a redirect to the Xero page, never with JSON: the
   * caller is a browser mid-navigation, and an error envelope in the address
   * bar is a dead end with no way back into PlastaGo.
   */
  callback: async (
    req: ValidatedRequest<{ query: typeof XeroCallbackQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    const result = await xeroService.completeCallback(req.validated.query);

    const params = new URLSearchParams({
      xero: result.ok ? 'connected' : 'failed',
      message: result.message,
    });

    res.redirect(`${env.PUBLIC_APP_URL}${XERO_PAGE}?${params.toString()}`);
  },

  disconnect: async (req: Request, res: Response): Promise<void> => {
    await xeroService.disconnect(callerFrom(req));
    res.status(204).send();
  },
};
