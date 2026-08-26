import type * as z from 'zod';
import { ApiRequestError, toApiRequestError } from './errors.js';

export interface ApiClientOptions {
  /** Empty string means same-origin, which is what the dev proxy and prod both want. */
  baseUrl: string;
  /** Extra headers per request — e.g. a bearer token on the driver app. */
  getHeaders?: () => Record<string, string> | undefined;
}

export interface RequestOptions<TSchema extends z.ZodType> {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Schema the response body must satisfy. */
  schema: TSchema;
  body?: unknown;
  searchParams?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  /**
   * Idempotency key for a replayed offline action. The offline outbox MUST set
   * this — without it, a retry after a timeout can double-create (§6A.4).
   */
  idempotencyKey?: string;
  /**
   * Non-2xx statuses that still carry a valid body and should be parsed rather
   * than thrown. `/readyz` is the motivating case: it answers 503 while
   * degraded, and that body is exactly the report we want to render.
   */
  acceptStatuses?: readonly number[];
}

export interface ApiClient {
  request: <TSchema extends z.ZodType>(
    path: string,
    options: RequestOptions<TSchema>,
  ) => Promise<z.output<TSchema>>;
}

/**
 * The single way the browser apps talk to the API.
 *
 * Two deliberate properties:
 *
 *  1. **Responses are parsed, not cast.** Every call passes the schema it
 *     expects, from `@plastago/shared`. A contract break fails here, loudly, at
 *     the boundary — instead of surfacing as `undefined` deep inside a component.
 *
 *  2. **Failures are always `ApiRequestError`.** One error type, with a code the
 *     caller can branch on and a `requestId` that maps to a server log line.
 */
export function createApiClient({ baseUrl, getHeaders }: ApiClientOptions): ApiClient {
  async function request<TSchema extends z.ZodType>(
    path: string,
    options: RequestOptions<TSchema>,
  ): Promise<z.output<TSchema>> {
    const url = buildUrl(baseUrl, path, options.searchParams);

    const headers = new Headers({ accept: 'application/json' });
    for (const [key, value] of Object.entries(getHeaders?.() ?? {})) {
      headers.set(key, value);
    }
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    if (options.idempotencyKey) headers.set('idempotency-key', options.idempotencyKey);

    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method ?? 'GET',
        headers,
        // Web auth is an httpOnly cookie (§6A.1), so credentials must be sent.
        credentials: 'include',
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new ApiRequestError(0, 'ABORTED', 'Request was cancelled', { cause });
      }
      throw new ApiRequestError(0, 'NETWORK_ERROR', 'Could not reach the server', { cause });
    }

    const payload: unknown = response.status === 204 ? null : await safeJson(response);

    const accepted = response.ok || (options.acceptStatuses?.includes(response.status) ?? false);
    if (!accepted) throw toApiRequestError(response.status, payload);

    const parsed = options.schema.safeParse(payload);
    if (!parsed.success) {
      // 2xx with a body we did not expect is a contract break. Hiding it would
      // produce a confusing bug a long way from its cause.
      throw new ApiRequestError(
        response.status,
        'CONTRACT_MISMATCH',
        `Response from ${path} did not match the expected schema`,
        { cause: parsed.error },
      );
    }

    return parsed.data;
  }

  return { request };
}

function buildUrl(
  baseUrl: string,
  path: string,
  searchParams: RequestOptions<z.ZodType>['searchParams'],
): string {
  const base = `${baseUrl}${path}`;
  if (!searchParams) return base;

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? `${base}?${suffix}` : base;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
