import { ApiRequestError } from '@plastago/api-client';
import {
  SERVICE_ERROR_CODES,
  ServiceError,
  type ServiceErrorCode,
} from '../service-error.js';

/**
 * The reserved `FieldIssue.path` the API uses to carry a precise auth reason.
 *
 * Must match `AUTH_REASON_PATH` in `apps/api/src/lib/auth-error.ts`. The server
 * cannot put `CODE_EXPIRED` in `error.code` — `ErrorCodeSchema` is a closed
 * union of nine transport codes and the contract is frozen — so the class of
 * failure goes in the code and the exact reason comes through here.
 */
const AUTH_REASON_PATH = 'authReason';

const KNOWN = new Set<string>(SERVICE_ERROR_CODES);

/**
 * The one place HTTP becomes a `ServiceError`.
 *
 * Every screen branches on `ServiceErrorCode` and nothing else — no component
 * knows a status code exists. This function is the entire reason that holds:
 * add a domain adapter, translate here, and the UI needs no change.
 */
export function toServiceError(error: unknown): ServiceError {
  if (!(error instanceof ApiRequestError)) {
    return new ServiceError('UNEXPECTED', 'Unrecognised failure', { cause: error });
  }

  const options = {
    requestId: error.requestId,
    fieldErrors: error.fieldErrors,
    cause: error,
  };

  // A precise reason, when the server sent one, always wins: `CODE_EXPIRED` and
  // `CODE_INCORRECT` are both 401s, and the sign-in screen must not confuse them.
  const reason = error.issues.find((issue) => issue.path === AUTH_REASON_PATH)?.message;
  if (reason && KNOWN.has(reason)) {
    return new ServiceError(reason as ServiceErrorCode, error.message, options);
  }

  return new ServiceError(mapCode(error), error.message, options);
}

function mapCode(error: ApiRequestError): ServiceErrorCode {
  switch (error.code) {
    // Raised by the client, never sent by the server.
    case 'NETWORK_ERROR':
      return 'OFFLINE';
    case 'ABORTED':
      return 'UNEXPECTED';
    case 'CONTRACT_MISMATCH':
      // The server answered 2xx with a body we do not understand. That is our
      // bug, and "something went wrong on our side" is the honest thing to say.
      return 'UNEXPECTED';

    case 'VALIDATION_FAILED':
    case 'BAD_REQUEST':
      return 'VALIDATION_FAILED';
    case 'UNAUTHENTICATED':
      return 'UNAUTHENTICATED';
    case 'FORBIDDEN':
      return 'FORBIDDEN';
    case 'NOT_FOUND':
      return 'NOT_FOUND';
    case 'CONFLICT':
      return 'CONFLICT';
    case 'RATE_LIMITED':
      return 'RATE_LIMITED';

    case 'DEPENDENCY_UNAVAILABLE':
    case 'INTERNAL_ERROR':
      // 504 and 408 are worth separating: "it took too long" is retryable
      // advice, where a flat 500 is not the user's problem to solve.
      return error.status === 504 || error.status === 408 ? 'TIMEOUT' : 'UNEXPECTED';

    default:
      return 'UNEXPECTED';
  }
}

/** Wraps an adapter call so every rejection leaves as a `ServiceError`. */
export async function viaService<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toServiceError(error);
  }
}
