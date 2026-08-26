import type { ErrorCode, FieldIssue } from '@plastago/shared';

/**
 * The only error type application code should throw.
 *
 * Anything else reaching the error handler is treated as an unexpected bug: it
 * is logged at `error` with a stack, and the client receives a generic 500 with
 * no internals leaked.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly issues?: FieldIssue[];
  /** `true` for errors we raised deliberately, so the handler can log at `warn`. */
  readonly expected = true;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    options?: { issues?: FieldIssue[]; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (options?.issues) this.issues = options.issues;
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(message = 'Malformed request', issues?: FieldIssue[]): AppError {
    return new AppError(400, 'BAD_REQUEST', message, issues ? { issues } : undefined);
  }

  static validation(message = 'Validation failed', issues?: FieldIssue[]): AppError {
    return new AppError(422, 'VALIDATION_FAILED', message, issues ? { issues } : undefined);
  }

  static unauthenticated(message = 'Authentication required'): AppError {
    return new AppError(401, 'UNAUTHENTICATED', message);
  }

  static forbidden(message = 'Not permitted'): AppError {
    return new AppError(403, 'FORBIDDEN', message);
  }

  static notFound(message = 'Not found'): AppError {
    return new AppError(404, 'NOT_FOUND', message);
  }

  static conflict(message = 'Conflicts with current state'): AppError {
    return new AppError(409, 'CONFLICT', message);
  }

  static dependencyUnavailable(message = 'A required dependency is unavailable'): AppError {
    return new AppError(503, 'DEPENDENCY_UNAVAILABLE', message);
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
