/**
 * The single failure type every service throws.
 *
 * ── Why this exists rather than surfacing `ApiRequestError` ─────────────────
 * The UI must not branch on HTTP. Screens are built now against mock data and
 * wired to Express later; if a component tests `error.status === 409` then the
 * component is coupled to a transport it currently does not even use. So each
 * service adapter translates its own failures into these codes, and the UI
 * branches on `code` alone.
 *
 * When the real endpoints land, the HTTP adapter maps `ApiRequestError.code`
 * (the server's `ErrorCode` envelope, already defined in `@plastago/shared`)
 * onto these — and no screen changes.
 *
 * `message` here is for developers and logs. User-facing copy is resolved from
 * `code` in the UI layer, because the right wording depends on what the user was
 * doing: the same `CODE_EXPIRED` reads differently on first sign-in and on a
 * re-authentication prompt.
 */
export const SERVICE_ERROR_CODES = [
  // Transport and generic
  'OFFLINE',
  'TIMEOUT',
  'UNEXPECTED',
  'RATE_LIMITED',
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  // Authentication (§9 A1/A2)
  'IDENTIFIER_UNKNOWN',
  'ACCOUNT_SUSPENDED',
  'CHALLENGE_NOT_FOUND',
  'CODE_INCORRECT',
  'CODE_EXPIRED',
  'CODE_ATTEMPTS_EXCEEDED',
  'RESEND_TOO_SOON',
] as const;

export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];

export interface ServiceErrorOptions {
  /** True when trying the same thing again could plausibly work. */
  retryable?: boolean;
  /** Correlates with a server log line. The only diagnostic we get (§6A.8). */
  requestId?: string;
  /** Field-level messages, keyed by form field name, for `setError`. */
  fieldErrors?: Record<string, string>;
  cause?: unknown;
}

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly retryable: boolean;
  readonly requestId: string | undefined;
  readonly fieldErrors: Record<string, string>;

  constructor(code: ServiceErrorCode, message: string, options: ServiceErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ServiceError';
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.requestId = options.requestId;
    this.fieldErrors = options.fieldErrors ?? {};
  }
}

const RETRYABLE = new Set<ServiceErrorCode>(['OFFLINE', 'TIMEOUT', 'UNEXPECTED', 'RATE_LIMITED']);

export function isServiceError(error: unknown): error is ServiceError {
  return error instanceof ServiceError;
}

/** Narrow an unknown catch value to a code, so callers can always switch. */
export function serviceErrorCode(error: unknown): ServiceErrorCode {
  return isServiceError(error) ? error.code : 'UNEXPECTED';
}
