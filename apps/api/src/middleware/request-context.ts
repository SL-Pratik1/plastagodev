import type { RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { REQUEST_ID_HEADER, resolveRequestId } from '../lib/request-id.js';

/** Assigns (or adopts) a request id and echoes it back on the response. */
export const requestId: RequestHandler = (req, res, next) => {
  req.requestId = resolveRequestId(req);
  res.setHeader(REQUEST_ID_HEADER, req.requestId);
  next();
};

/**
 * Structured request/response logging. With no error-tracking vendor (§6A.8)
 * these lines are the primary record of what happened in production, so the
 * levels are deliberate: 5xx errors, 4xx warnings, everything else info.
 *
 * ── ⚠️ Development prints far less, and that is a real decision ────────────
 * Pino's default serializers dump every request and response header — roughly
 * thirty lines per call. In production that is the point: those lines ARE the
 * incident record. On a laptop it buries everything a developer is actually
 * looking at, and the case that proved it was the sign-in code: the stub mailer
 * printed it correctly and nobody could find it under the headers of the
 * request that caused it.
 *
 * So development gets a one-line summary and production keeps the detail.
 * Nothing is dropped from the production record.
 */
const terse = env.NODE_ENV === 'development';

export const requestLogger: RequestHandler = pinoHttp({
  logger,
  genReqId: (req) => (req as { requestId?: string }).requestId ?? 'unknown',
  autoLogging: {
    ignore: (req) => req.url === '/healthz',
  },
  customLogLevel: (_req, res, error) => {
    if (error || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => `${req.method ?? '?'} ${req.url ?? '?'} → ${res.statusCode}`,
  ...(terse
    ? {
        serializers: {
          // The method, path and status are already in the message above; what
          // is left is the noise.
          req: () => undefined,
          res: () => undefined,
        },
      }
    : {}),
});
