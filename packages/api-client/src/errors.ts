import { ApiErrorSchema, type ErrorCode, type FieldIssue } from '@plastago/shared';

/** Codes the client can raise that the server never sends. */
export type ClientErrorCode = 'NETWORK_ERROR' | 'CONTRACT_MISMATCH' | 'ABORTED';

/**
 * Every failed request throws this, whatever went wrong.
 *
 * Callers branch on `code`, never on message text — the server guarantees one
 * error envelope, so there is no reason to string-match.
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ErrorCode | ClientErrorCode;
  readonly issues: readonly FieldIssue[];
  readonly requestId: string | undefined;

  constructor(
    status: number,
    code: ErrorCode | ClientErrorCode,
    message: string,
    options?: { issues?: readonly FieldIssue[]; requestId?: string; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.issues = options?.issues ?? [];
    this.requestId = options?.requestId;
  }

  /** True when retrying could plausibly succeed — used by the offline outbox. */
  get isRetryable(): boolean {
    if (this.code === 'NETWORK_ERROR') return true;
    return this.status >= 500 || this.status === 429;
  }

  /** Field errors keyed by path, ready for react-hook-form's `setError`. */
  get fieldErrors(): Record<string, string> {
    return Object.fromEntries(this.issues.map((issue) => [issue.path, issue.message]));
  }
}

export function toApiRequestError(status: number, payload: unknown): ApiRequestError {
  const parsed = ApiErrorSchema.safeParse(payload);
  if (parsed.success) {
    const { code, message, issues, requestId } = parsed.data.error;
    return new ApiRequestError(status, code, message, {
      ...(issues ? { issues } : {}),
      requestId,
    });
  }
  // A proxy or gateway failed before reaching our own error handler.
  return new ApiRequestError(status, 'INTERNAL_ERROR', `Request failed with status ${status}`);
}
