import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { AppError } from '../../lib/app-error.js';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { sortdController } from './sortd.controller.js';

/**
 * Router layer — paths and middleware only. No logic.
 *
 * ── `requireAuth` and nothing more, deliberately ──────────────────────────
 * Every role on every surface gets support, and none is gated by capability:
 * the person most likely to need to ask a question is the one a gate has just
 * stopped. Which Sortd app and what it may see are decided in the service,
 * from the caller's own session.
 *
 * The webhook is NOT here. It has no session and needs the raw body, so it is
 * mounted in `server.ts` ahead of the JSON parser.
 */
export const sortdRouter = Router();

sortdRouter.use(requireAuth);

/**
 * Generous, because a hit is almost always the cached row and costs one indexed
 * read. It exists to stop a client stuck in a render loop from turning into a
 * stream of session mints against Sortd, not to ration normal use. Keyed by
 * user, because the office sits behind one address.
 */
const sessionLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => req.auth?.userId ?? 'anonymous',
  handler: (_req, _res, next) => {
    next(new AppError(429, 'RATE_LIMITED', 'Too many support requests — try again in a minute'));
  },
});

sortdRouter.get('/session', sessionLimiter, asyncHandler(sortdController.session));

/**
 * Not rate limited: it runs on the way out of a sign-out, and somebody who
 * pressed "Sign out" twice must not be left with a live session because the
 * second attempt was throttled.
 */
sortdRouter.delete('/session', asyncHandler(sortdController.revoke));
