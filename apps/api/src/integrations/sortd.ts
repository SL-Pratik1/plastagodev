import type { Surface } from '@plastago/shared';
import * as z from 'zod';
import { env, sortdBaseUrl } from '../config/env.js';
import { AppError } from '../lib/app-error.js';

/**
 * The Sortd support platform's session API.
 *
 * ⚠️ The three `SORTD_API_KEY_*` values and the three webhook secrets are read
 * HERE and nowhere else. Callers get a `{ sessionId, expiresAt }` back; a key
 * never leaves this process, and the rest of the API cannot reach one even by
 * accident.
 *
 * ── Why the surface is an argument to every call ──────────────────────────
 * PlastaGo's Sortd organisation has one app per surface, and a key is scoped
 * to its app. A session minted with the console's key for a driver would open
 * the console's knowledge base and file the driver's ticket against the wrong
 * repository. Making the surface a parameter means no call can be written
 * without deciding which app it is for.
 */

/** What a Sortd session can see: own tickets, one tenant's, or all of them. */
export type SortdRole = 'user' | 'admin' | 'owner';

export interface SortdSessionRequest {
  /** PlastaGo's own user id, so a person's history survives an email change. */
  externalUserId: string;
  email: string;
  name: string;
  role: SortdRole;
  /** The customer account, for the two customer roles. See the service. */
  appTenantId?: string;
  /** Display-only label for the tenant in the Sortd portal. */
  appTenantName?: string;
}

export interface SortdSession {
  sessionId: string;
  /** ISO 8601. Sortd sessions last a day. */
  expiresAt: string;
}

/**
 * A slow Sortd must not become a slow PlastaGo.
 *
 * Every authenticated shell asks for a session on load, so an outage at Sortd
 * without a bound would hold an Express handler open for the platform's socket
 * timeout on every page. The controller degrades a failure to "no bubble".
 */
const TIMEOUT_MS = 8_000;

/**
 * ⚠️ Parsed, not cast. The session id goes straight into a script attribute in
 * the browser, so a changed response shape must fail here rather than boot
 * the widget with `undefined`.
 */
const SessionResponseSchema = z.object({
  sessionId: z.string().min(1),
  expiresAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), 'not a date'),
});

function apiKeyFor(surface: Surface): string | undefined {
  return {
    admin: env.SORTD_API_KEY_ADMIN,
    portal: env.SORTD_API_KEY_PORTAL,
    driver: env.SORTD_API_KEY_DRIVER,
  }[surface];
}

/**
 * The secret one surface's webhooks are signed with, or null when unset.
 *
 * Kept beside the keys so that every Sortd credential in the codebase is read
 * in this one file.
 */
export function sortdWebhookSecretFor(surface: Surface): string | null {
  return (
    {
      admin: env.SORTD_WEBHOOK_SECRET_ADMIN,
      portal: env.SORTD_WEBHOOK_SECRET_PORTAL,
      driver: env.SORTD_WEBHOOK_SECRET_DRIVER,
    }[surface] ?? null
  );
}

/**
 * One authenticated call to one surface's Sortd app.
 *
 * The response body is never put into the thrown error or a log line: Sortd
 * echoes request context on some errors, and an error path is exactly where a
 * credential gets copied into a log that outlives it.
 */
async function call(
  surface: Surface,
  path: string,
  init: { method: 'POST' | 'PUT' | 'DELETE'; body?: unknown },
): Promise<unknown> {
  const key = apiKeyFor(surface);
  if (!sortdBaseUrl || !key) {
    throw AppError.dependencyUnavailable(`Sortd is not configured for the ${surface} app`);
  }

  let response: Response;
  try {
    response = await fetch(`${sortdBaseUrl}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw AppError.dependencyUnavailable(`Sortd ${init.method} ${path} did not answer`);
  }

  if (!response.ok) {
    throw new SortdRequestError(init.method, path, response.status);
  }

  return response.json().catch(() => null);
}

/** A refusal from Sortd, carrying the status and nothing from the body. */
export class SortdRequestError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
  ) {
    super(`Sortd ${method} ${path} failed: ${String(status)}`);
    this.name = 'SortdRequestError';
  }
}

function parseSession(payload: unknown): SortdSession {
  const parsed = SessionResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw AppError.dependencyUnavailable('Sortd returned a session in an unexpected shape');
  }
  return parsed.data;
}

const sessionPath = (sessionId: string) => `/api/embed/sessions/${encodeURIComponent(sessionId)}`;

export const sortdClient = {
  /**
   * True when this surface can be offered the bubble at all.
   *
   * A key alone is not enough — `SORTD_ENABLED=false` switches every surface
   * off without discarding a credential that was shown only once.
   */
  enabled(surface: Surface): boolean {
    return Boolean(sortdBaseUrl && apiKeyFor(surface) && env.SORTD_ENABLED !== 'false');
  },

  async createSession(surface: Surface, request: SortdSessionRequest): Promise<SortdSession> {
    return parseSession(
      await call(surface, '/api/embed/sessions', { method: 'POST', body: request }),
    );
  },

  /** Extends a live session. Throws when Sortd no longer knows it. */
  async refreshSession(surface: Surface, sessionId: string): Promise<SortdSession> {
    return parseSession(
      await call(surface, `${sessionPath(sessionId)}/refresh`, { method: 'PUT' }),
    );
  },

  async revokeSession(surface: Surface, sessionId: string): Promise<void> {
    await call(surface, sessionPath(sessionId), { method: 'DELETE' });
  },
};
