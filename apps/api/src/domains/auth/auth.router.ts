import { OtpRequestSchema, OtpVerifySchema } from '@plastago/shared';
import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { env } from '../../config/env.js';
import { asyncHandler } from '../../lib/async-handler.js';
import { AppError } from '../../lib/app-error.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { authController } from './auth.controller.js';
import { ActiveRoleSchema, OtpResendSchema } from './auth.schemas.js';

/**
 * Router layer — paths and middleware only. No logic.
 *
 * ── Why these routes carry their own limiter ────────────────────────────────
 * The global limiter in `middleware/security.ts` is sized for ordinary API
 * traffic (300/minute), which is far too generous for an unauthenticated
 * endpoint that spends money: every request here can send an SMS. The service
 * additionally caps sends PER IDENTIFIER, because an IP limit alone is defeated
 * by a handful of proxies while the cost — and the nuisance to whoever owns
 * that phone — is per number.
 *
 * Sizing note: the office sits behind ONE NAT address, so these are per-office
 * ceilings, not per-person. Deliberately loose enough for a Monday morning with
 * every staff member signing in at once — and much looser again in development,
 * where a developer and their browser share one address. See `config/env.ts`.
 */
const sendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.OTP_SENDS_PER_IP,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  // IPv6-safe: bare `req.ip` would key every address in a /64 separately.
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
  handler: (_req, _res, next) => {
    next(new AppError(429, 'RATE_LIMITED', 'Too many sign-in codes requested — try again later'));
  },
});

/**
 * Verification is looser than sending: a mistyped code is the normal case, it
 * costs nothing, and the per-challenge attempt counter is the real guard
 * against guessing — five attempts against a six-digit code is a 1-in-200,000
 * chance, and the challenge is burned after that.
 */
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.OTP_VERIFIES_PER_IP,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
  handler: (_req, _res, next) => {
    next(new AppError(429, 'RATE_LIMITED', 'Too many attempts — try again later'));
  },
});

export const authRouter = Router();

authRouter.post(
  '/otp/request',
  sendLimiter,
  validate({ body: OtpRequestSchema }),
  asyncHandler(authController.requestCode),
);

authRouter.post(
  '/otp/resend',
  sendLimiter,
  validate({ body: OtpResendSchema }),
  asyncHandler(authController.resendCode),
);

authRouter.post(
  '/otp/verify',
  verifyLimiter,
  validate({ body: OtpVerifySchema }),
  asyncHandler(authController.verifyCode),
);

authRouter.get('/session', asyncHandler(authController.getSession));

/**
 * The only route in this file that requires a session.
 *
 * `requireAuth` rather than leaving it to the service: this is where a reader
 * looks to find out who may call what, and "everything above is anonymous, this
 * one is not" should be visible here rather than buried in a service method.
 * No rate limiter — it sends nothing, costs nothing, and cannot grant a role
 * the caller does not already hold.
 */
authRouter.post(
  '/active-role',
  requireAuth,
  validate({ body: ActiveRoleSchema }),
  asyncHandler(authController.setActiveRole),
);

authRouter.post('/sign-out', asyncHandler(authController.signOut));
