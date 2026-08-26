import { ApiRequestError } from '@/lib/api-client';
import { isServiceError, type ServiceErrorCode } from '@/services/service-error';

export interface ErrorPresentation {
  /** Short, specific, no jargon. Goes in the heading or toast title. */
  title: string;
  /** What to do about it. Omitted when there is nothing useful to say. */
  detail?: string;
  /** False when retrying the same action cannot help. */
  retryable: boolean;
  requestId?: string | undefined;
}

/**
 * One place that turns a failure into words a user can act on.
 *
 * The rule this file exists to enforce: **never show the user a code, a status
 * or an exception message.** "VALIDATION_FAILED" and "Request failed with
 * status 500" are facts about our system, not about their situation. Every
 * message below names what happened and, where possible, what to do next.
 *
 * Auth-specific copy lives in `features/auth/auth-messages.ts` instead, because
 * the same code needs different wording in different flows — `CODE_EXPIRED`
 * during first sign-in is not the same sentence as `CODE_EXPIRED` when
 * re-authenticating mid-task.
 */
const GENERIC: Record<ServiceErrorCode, ErrorPresentation> = {
  OFFLINE: {
    title: 'No connection',
    detail: 'Check your internet connection. Nothing was saved.',
    retryable: true,
  },
  TIMEOUT: {
    title: 'That took too long',
    detail: 'The server did not respond. Nothing was saved — try again.',
    retryable: true,
  },
  UNEXPECTED: {
    title: 'Something went wrong',
    detail: 'This one is on us. Try again, and let the office know if it keeps happening.',
    retryable: true,
  },
  RATE_LIMITED: {
    title: 'Too many requests',
    detail: 'Wait a moment and try again.',
    retryable: true,
  },
  VALIDATION_FAILED: {
    title: 'Check the highlighted fields',
    detail: 'Some details need correcting before this can be saved.',
    retryable: false,
  },
  UNAUTHENTICATED: {
    title: 'Your session has ended',
    detail: 'Sign in again to continue. Your unsaved changes are still on this page.',
    retryable: false,
  },
  FORBIDDEN: {
    title: 'Your role does not allow that',
    detail: 'Ask a super admin if you need access to this.',
    retryable: false,
  },
  NOT_FOUND: {
    title: 'Not found',
    detail: 'It may have been deleted, or you may not have access to it.',
    retryable: false,
  },
  CONFLICT: {
    title: 'Someone else changed this',
    detail: 'Reload to see the current version before saving again.',
    retryable: false,
  },

  // Auth codes reaching a generic handler — a fallback, not the intended path.
  IDENTIFIER_UNKNOWN: {
    title: 'We could not find that account',
    retryable: false,
  },
  ACCOUNT_SUSPENDED: {
    title: 'That account is suspended',
    detail: 'Contact the office on 1300 395 438.',
    retryable: false,
  },
  CHALLENGE_NOT_FOUND: {
    title: 'That sign-in attempt has expired',
    detail: 'Start again to get a new code.',
    retryable: false,
  },
  CODE_EXPIRED: {
    title: 'That code has expired',
    detail: 'Request a new one.',
    retryable: false,
  },
  CODE_INCORRECT: {
    title: 'That code is not right',
    retryable: false,
  },
  CODE_ATTEMPTS_EXCEEDED: {
    title: 'Too many incorrect attempts',
    detail: 'Start again to get a new code.',
    retryable: false,
  },
  RESEND_TOO_SOON: {
    title: 'Hold on a moment',
    detail: 'Wait for the countdown before requesting another code.',
    retryable: false,
  },
};

/**
 * `ApiRequestError` → the same vocabulary.
 *
 * Both error types are in play and will be until every domain sits behind a
 * service: `ServiceError` from the service layer, `ApiRequestError` from direct
 * api-client calls (the readiness probe today). They must not produce two
 * different standards of message — "Request failed with status 502" is a fact
 * about our infrastructure, not about the user's situation.
 */
function describeApiError(error: ApiRequestError): ErrorPresentation {
  const base = (() => {
    switch (error.code) {
      case 'NETWORK_ERROR':
        return {
          title: 'Cannot reach the server',
          detail: 'Check your connection. If you are running locally, start the API.',
          retryable: true,
        };
      case 'ABORTED':
        return { title: 'Request cancelled', retryable: true };
      case 'CONTRACT_MISMATCH':
        return {
          title: 'The server sent something unexpected',
          detail: 'This is a mismatch on our side, not something you did.',
          retryable: false,
        };
      case 'UNAUTHENTICATED':
        return GENERIC.UNAUTHENTICATED;
      case 'FORBIDDEN':
        return GENERIC.FORBIDDEN;
      case 'NOT_FOUND':
        return GENERIC.NOT_FOUND;
      case 'CONFLICT':
        return GENERIC.CONFLICT;
      case 'VALIDATION_FAILED':
      case 'BAD_REQUEST':
        return GENERIC.VALIDATION_FAILED;
      case 'RATE_LIMITED':
        return GENERIC.RATE_LIMITED;
      case 'DEPENDENCY_UNAVAILABLE':
        return {
          title: 'A service the system depends on is down',
          detail: 'Nothing was saved. Try again shortly.',
          retryable: true,
        };
      default:
        break;
    }

    // A gateway or proxy failed before reaching our own error handler, so there
    // is no envelope to read — only the status.
    if (error.status >= 502 && error.status <= 504) {
      return {
        title: 'The server is not responding',
        detail: 'It may be restarting. Try again in a moment.',
        retryable: true,
      };
    }

    return GENERIC.UNEXPECTED;
  })();

  return { ...base, requestId: error.requestId };
}

export function describeError(error: unknown): ErrorPresentation {
  if (isServiceError(error)) {
    return { ...GENERIC[error.code], requestId: error.requestId };
  }

  if (error instanceof ApiRequestError) {
    return describeApiError(error);
  }

  // Offline is worth detecting directly: the browser knows, and "no connection"
  // is far more useful than "something went wrong".
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return GENERIC.OFFLINE;
  }

  return GENERIC.UNEXPECTED;
}
