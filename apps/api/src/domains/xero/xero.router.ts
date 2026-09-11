import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { xeroController } from './xero.controller.js';
import { XeroCallbackQuerySchema } from './xero.schemas.js';

/**
 * Router layer — paths and middleware only. No logic.
 *
 * ── Why the callback is mounted BEFORE the auth gate ──────────────────────
 * `GET /callback` is a top-level navigation arriving from login.xero.com, not
 * a call from the PlastaGo app. Requiring a session there would fail for a
 * reason that has nothing to do with the user: the browser is following a
 * cross-site redirect, and any cookie set `SameSite=Strict` is withheld on
 * exactly that kind of navigation. The result would be a connection that
 * cannot be completed in some browsers and can in others — the worst class of
 * bug to diagnose.
 *
 * It is not unauthenticated in the sense that matters. The single-use `state`
 * row is the credential: it was created by a signed-in super administrator,
 * it expires in ten minutes, it is destroyed atomically on use, and without a
 * matching row the request does nothing. See `xero.service.ts`.
 *
 * ── Why everything else is super-admin only ───────────────────────────────
 * There is one decision in this domain — "may this person bind PlastaGo's
 * invoicing to a set of accounting books" — and it does not vary by route.
 * The service asserts it again rather than trusting the router, because this
 * gate is coarse by design and the service is what a test exercises.
 */
export const xeroRouter = Router();

xeroRouter.get(
  '/callback',
  validate({ query: XeroCallbackQuerySchema }),
  asyncHandler(xeroController.callback),
);

xeroRouter.use(requireAuth);
xeroRouter.use(requireRole('super-admin'));

xeroRouter.get('/status', asyncHandler(xeroController.status));
xeroRouter.post('/connect', asyncHandler(xeroController.connect));
xeroRouter.delete('/connection', asyncHandler(xeroController.disconnect));
