import cors from 'cors';
import type { Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { env, isProduction } from '../config/env.js';
import { AppError } from '../lib/app-error.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'security' });

/**
 * Baseline hardening (§6A.7): helmet, an explicit CORS allowlist, and a rate
 * limiter. All three are applied to every route — anything looser is a per-route
 * override, never a global relaxation.
 */
export function applySecurity(app: Express): void {
  // Render terminates TLS, so trust one proxy hop. Without this the rate limiter
  // sees the proxy IP for every caller and limits all users as one.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      // The API serves JSON only; CSP belongs on the static frontends.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin, curl and server-to-server calls send no Origin header.
        if (!origin) return callback(null, true);
        if (env.CORS_ORIGINS.includes(origin)) return callback(null, true);
        log.warn({ origin }, 'blocked by CORS allowlist');
        callback(AppError.forbidden(`Origin ${origin} is not allowed`));
      },
      credentials: true,
      maxAge: 86_400,
    }),
  );

  app.use(
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      limit: env.RATE_LIMIT_MAX,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      // Probes must never be throttled — the platform uses them to decide on a
      // restart, and a 429 would read as an outage.
      skip: (req) => req.path === '/healthz' || req.path === '/readyz',
      handler: (_req, _res, next) => {
        next(new AppError(429, 'RATE_LIMITED', 'Too many requests — slow down'));
      },
    }),
  );

  if (!isProduction) {
    log.debug({ corsOrigins: env.CORS_ORIGINS }, 'CORS allowlist');
  }
}
