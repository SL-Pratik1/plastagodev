import type { RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
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
 */
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
});
