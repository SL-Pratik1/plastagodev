import { api } from '@/lib/api-client';
import * as z from 'zod';
import type { OutboxOperation } from './db';

/**
 * How a queued operation actually reaches the server.
 *
 * ── Why this is a seam and not just the api-client call ───────────────────
 * Because the outbox is the *only* write path in this app (see `outbox.ts`), and
 * that means it is also the only thing standing between a UI-only build and a
 * real one. Extracting the send makes the swap one line in `main.tsx`, exactly
 * as `createMockServices()` does in the web app — instead of the queue's replay
 * logic being entangled with a transport it cannot run without.
 *
 * It also means the offline behaviour is genuinely exercised in the demo. The
 * queue fills, drains, retries and reports failures against the mock transport
 * using the same code that will run against HTTP.
 */
export interface OutboxRequest {
  method: OutboxOperation['method'];
  path: string;
  body: unknown;
  idempotencyKey: string;
}

export type OutboxTransport = (request: OutboxRequest) => Promise<void>;

/** Replies are not inspected — the outbox only needs to know they parsed. */
const AnyResponseSchema = z.unknown();

/** The real one. Every path the app enqueues becomes an endpoint. */
export const httpTransport: OutboxTransport = async (request) => {
  await api.request(request.path, {
    method: request.method,
    schema: AnyResponseSchema,
    body: request.body,
    idempotencyKey: request.idempotencyKey,
  });
};

let transport: OutboxTransport = httpTransport;

export function setOutboxTransport(next: OutboxTransport): void {
  transport = next;
}

export function sendOperation(request: OutboxRequest): Promise<void> {
  return transport(request);
}

/**
 * ── DEMO ONLY ─────────────────────────────────────────────────────────────
 * A switch that makes the app behave as if there were no signal, regardless of
 * what the browser thinks.
 *
 * This exists because M4.12 — "everything works with no signal, actions queue,
 * and the driver can see clearly what has and has not synced" — is the single
 * hardest thing to *show* anyone. Turning off real Wi-Fi mid-demonstration is
 * both unreliable and unrepeatable, and `navigator.onLine` cannot be faked from
 * page code.
 *
 * Delete this together with the mock services. Nothing outside the offline layer
 * and the header control should ever read it.
 */
const SIMULATED_OFFLINE_KEY = 'plastago.driver.demo.offline';

/**
 * Persisted, so it survives a reload.
 *
 * Not a nicety: the flag started as a module variable, which meant reloading the
 * app — or the PWA being restarted by the OS — silently put the driver back
 * online. In a demo that is worse than useless, because the presenter reloads to
 * show the queue surviving and the queue is what disappears.
 */
function readStoredOffline(): boolean {
  try {
    return window.localStorage.getItem(SIMULATED_OFFLINE_KEY) === 'true';
  } catch {
    return false;
  }
}

let simulatedOffline = readStoredOffline();
const listeners = new Set<(offline: boolean) => void>();

export function isSimulatedOffline(): boolean {
  return simulatedOffline;
}

export function setSimulatedOffline(value: boolean): void {
  if (simulatedOffline === value) return;
  simulatedOffline = value;
  try {
    if (value) window.localStorage.setItem(SIMULATED_OFFLINE_KEY, 'true');
    else window.localStorage.removeItem(SIMULATED_OFFLINE_KEY);
  } catch {
    // The switch still works for this page session.
  }
  for (const listener of listeners) listener(value);
}

export function subscribeSimulatedOffline(listener: (offline: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True when the app should behave as offline — real or simulated. */
export function isEffectivelyOffline(): boolean {
  return !navigator.onLine || simulatedOffline;
}
