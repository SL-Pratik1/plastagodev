import type { ErrorRequestHandler } from 'express';
import type { ApiError, ErrorCode, FieldIssue } from '@plastago/shared';
import * as z from 'zod';
import { isProduction } from '../config/env.js';
import { isAppError } from '../lib/app-error.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'error-handler' });

/**
 * The single exit point for every error in the service (§6A.7).
 *
 * Guarantees:
 *   • one response shape — `ApiError` from `@plastago/shared`, always
 *   • the requestId is in the body, so a user report maps to a log line
 *   • internals never leak: unexpected errors become a flat 500
 *
 * Must be registered LAST, after all routers and after `notFound`.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const requestId = req.requestId ?? 'unknown';

  let status = 500;
  let code: ErrorCode = 'INTERNAL_ERROR';
  let message = 'Something went wrong on our side';
  let issues: FieldIssue[] | undefined;

  if (isAppError(error)) {
    status = error.status;
    code = error.code;
    message = error.message;
    issues = error.issues;
    log.warn({ requestId, code, status, err: error }, 'handled error');
  } else if (error instanceof z.ZodError) {
    // A schema used outside `validate()` — still return a clean 422.
    status = 422;
    code = 'VALIDATION_FAILED';
    message = 'Validation failed';
    issues = error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    }));
    log.warn({ requestId, err: error }, 'unwrapped ZodError');
  } else if (isBodyParserError(error)) {
    status = 400;
    code = 'BAD_REQUEST';
    message = 'Request body is not valid JSON';
    log.warn({ requestId }, 'malformed JSON body');
  } else {
    // Unexpected: this is a bug. Log everything, tell the client nothing.
    log.error({ requestId, err: error }, 'unhandled error');
    if (!isProduction && error instanceof Error) {
      message = error.message;
    }
  }

  if (res.headersSent) {
    // Too late to write a body; kill the socket so the client sees a failure
    // rather than a truncated success.
    res.destroy();
    return;
  }

  const body: ApiError = {
    error: {
      code,
      message,
      ...(issues && issues.length > 0 ? { issues } : {}),
      requestId,
    },
  };

  res.status(status).json(body);
};

function isBodyParserError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    (error as { type?: unknown }).type === 'entity.parse.failed'
  );
}
