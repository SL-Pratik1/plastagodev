import { timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/app-error.js';
import { asyncHandler } from '../../lib/async-handler.js';
import { logger } from '../../lib/logger.js';
import { validate } from '../../middleware/validate.js';
import { poReviewController } from './po-review.controller.js';
import { ExtractorWebhookSchema } from './po-review.schemas.js';

const log = logger.child({ module: 'po-webhook' });

/**
 * The extractor's callback (I6 · M2.12).
 *
 * ── Why this is its own router, outside the queue's session gate ──────────
 * Every other route under `/queues` sits behind `requireAuth`, because a person
 * is asking. This caller is a machine in another datacentre with no session and
 * no way to obtain one — an OTP flow needs a mailbox and a human.
 *
 * The alternative was to exempt one path inside `queueRouter`, and that is worse
 * than it looks: the exemption would sit in a file whose contract is "everything
 * here is authenticated", one line away from routes that decide what a customer
 * is billed. A separate router with a different credential makes the boundary
 * legible — this is the only unauthenticated write in the versioned API, and it
 * is the only route in this file.
 *
 * ── What the secret does and does not buy ─────────────────────────────────
 * It authenticates the PING. It does not make the payload trustworthy, and the
 * handler deliberately does not read it: `ingestFromExtractor` takes only the
 * id and re-fetches the document from the vendor with our own credentials.
 *
 * So the worst a leaked secret achieves is making us re-read documents that
 * already exist in our own tenant. That is the property worth having, because a
 * webhook secret travels in a URL and URLs end up in logs.
 */
export const poWebhookRouter = Router();

/**
 * Checks the shared secret in `?token=`.
 *
 * ── Why the token is in the query string ──────────────────────────────────
 * Because the vendor's webhook configuration accepts a URL and nothing else —
 * there is no field for a custom header, and it does not sign its requests. A
 * query parameter is what the integration surface allows.
 *
 * The compensating controls are that the secret authorises nothing but a
 * re-read (see above), and that it is never logged: the failure branch records
 * the caller's address, not what they presented.
 */
function requireWebhookSecret(req: Request, _res: Response, next: NextFunction): void {
  const expected = env.EXTRACTOR_WEBHOOK_SECRET;

  if (!expected) {
    // The route is mounted but the pipeline is off. 503 rather than 401: the
    // caller's credentials are not the problem, and a vendor retrying against a
    // 401 forever would never surface the real cause.
    throw AppError.dependencyUnavailable('The document extractor is not configured');
  }

  const presented = typeof req.query.token === 'string' ? req.query.token : '';

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);

  // Length is compared first because `timingSafeEqual` throws on a mismatch.
  // That leaks the secret's length, which is not a secret worth protecting.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    log.warn({ ip: req.ip }, 'extractor webhook presented an invalid token');
    throw AppError.unauthenticated('Invalid webhook token');
  }

  next();
}

poWebhookRouter.post(
  '/extractor',
  requireWebhookSecret,
  validate({ body: ExtractorWebhookSchema }),
  asyncHandler(poReviewController.webhook),
);
