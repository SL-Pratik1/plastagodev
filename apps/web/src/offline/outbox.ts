import { ApiRequestError } from '@plastago/api-client';
import { db, META_KEYS, type OutboxOperation } from './db';
import { isEffectivelyOffline, sendOperation, subscribeSimulatedOffline } from './transport';

const MAX_ATTEMPTS = 8;

export interface EnqueueInput {
  method: OutboxOperation['method'];
  path: string;
  body?: unknown;
}

/**
 * Queue a mutation for the server.
 *
 * Every write from the driver app goes through here, online or not. That is the
 * point: there is no separate "online path" that behaves differently, so the
 * offline case cannot rot from disuse.
 */
export async function enqueue(input: EnqueueInput): Promise<string> {
  const idempotencyKey = crypto.randomUUID();

  await db.outbox.add({
    idempotencyKey,
    method: input.method,
    path: input.path,
    body: input.body ?? null,
    createdAt: new Date().toISOString(),
    attempts: 0,
    status: 'pending',
  });

  // Best effort — if we are offline this fails silently and the periodic flush
  // or the `online` event will pick it up.
  void flushOutbox();

  return idempotencyKey;
}

/**
 * Operations still on their way to the server: waiting, in flight, or failed
 * with attempts left.
 *
 * For reads that must not contradict what the driver has already done. The
 * query cache lives in memory, so after a reload the server's answer is all a
 * screen has — and until the queue drains, that answer is the one from before
 * the driver acted. An operation out of attempts is left out: it will never
 * arrive, and pretending otherwise would hide the failure the sync badge
 * reports.
 *
 * Never throws. A browser with IndexedDB blocked still gets its screens, just
 * without the overlay.
 */
export async function queuedOperations(): Promise<OutboxOperation[]> {
  try {
    const rows = await db.outbox.where('status').anyOf('pending', 'syncing', 'failed').toArray();
    return rows.filter((row) => row.attempts < MAX_ATTEMPTS);
  } catch {
    return [];
  }
}

/**
 * Told when queued work has actually reached the server.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * A queued write resolves the moment it is durably on the phone, which is
 * several `await`s before the request is even sent. So a screen that refetches
 * on a resolved mutation asks the server a question it has not yet been told the
 * answer to, gets the OLD answer, and caches it as fresh — the driver submits a
 * pre-start and the run sheet still says "not done" until they reload.
 *
 * Nothing else can close that gap: only the drain knows when the server has it.
 * Listeners are told once per successful drain rather than once per operation,
 * because the only useful reaction is "re-read everything", and a burst of
 * queued stops draining at the same traffic light should cost one refetch.
 */
type SyncedListener = () => void;

const syncedListeners = new Set<SyncedListener>();

export function onOutboxSynced(listener: SyncedListener): () => void {
  syncedListeners.add(listener);
  return () => {
    syncedListeners.delete(listener);
  };
}

let flushing = false;

/**
 * Drain the outbox in the order the driver performed the actions.
 *
 * Strictly sequential, and it STOPS on the first retryable failure. Skipping
 * ahead would let a later action land before an earlier one — e.g. "completed"
 * arriving before "arrived", which corrupts the on-site duration that the Extra
 * Load Time charge is computed from.
 */
export async function flushOutbox(): Promise<{ sent: number; failed: number }> {
  // `isEffectivelyOffline` rather than `navigator.onLine`, so the demo's offline
  // switch takes the same path a dead cell does.
  if (flushing || isEffectivelyOffline()) return { sent: 0, failed: 0 };
  flushing = true;

  let sent = 0;
  let failed = 0;

  try {
    const pending = await db.outbox.where('status').anyOf('pending', 'failed').sortBy('createdAt');
    const now = Date.now();

    for (const operation of pending) {
      if (operation.attempts >= MAX_ATTEMPTS) continue;

      /*
       * ⚠️ The backoff has to be READ, not just written.
       *
       * `nextAttemptAt` was computed on every failure and never consulted, so
       * the 15-second sweep retried a failing operation every 15 seconds and
       * burned all eight attempts in about two minutes. Any outage longer than
       * that — a tunnel, a dead cell, an API restart — permanently killed every
       * queued write, and nothing ever retried them again. The backoff exists
       * precisely so a driver who loses signal for ten minutes does not lose
       * the run they recorded during it.
       */
      if (operation.nextAttemptAt !== undefined && Date.parse(operation.nextAttemptAt) > now) {
        continue;
      }

      await db.outbox.update(operation.id, { status: 'syncing' });

      try {
        await sendOperation({
          method: operation.method,
          path: operation.path,
          body: operation.body,
          idempotencyKey: operation.idempotencyKey,
        });

        await db.outbox.delete(operation.id);
        sent += 1;
      } catch (error) {
        failed += 1;
        const retryable = error instanceof ApiRequestError ? error.isRetryable : true;
        const message = error instanceof Error ? error.message : 'Unknown error';

        await db.outbox.update(operation.id, {
          status: 'failed',
          attempts: operation.attempts + 1,
          lastError: message,
          nextAttemptAt: new Date(Date.now() + backoffMs(operation.attempts + 1)).toISOString(),
        });

        await bumpFailureCount();

        // A retryable failure means the network or server is unhappy; pressing
        // on would just burn attempts on every queued item.
        if (retryable) break;
      }
    }

    if (sent > 0) {
      await db.meta.put({
        key: META_KEYS.lastSuccessfulSyncAt,
        value: new Date().toISOString(),
      });
    }
  } finally {
    flushing = false;
  }

  /*
   * After `flushing` is cleared, so a listener that reacts by writing is not
   * refused the flush its own write asks for. Each listener is isolated: a
   * throwing subscriber must not strand the queue or the ones after it.
   */
  if (sent > 0) {
    for (const listener of syncedListeners) {
      try {
        listener();
      } catch {
        // A screen failing to refresh is not a reason to stop syncing.
      }
    }
  }

  return { sent, failed };
}

function backoffMs(attempt: number): number {
  // 2s, 4s, 8s … capped at 5 minutes.
  return Math.min(2_000 * 2 ** (attempt - 1), 300_000);
}

async function bumpFailureCount(): Promise<void> {
  const current = await db.meta.get(META_KEYS.syncFailureCount);
  const count = typeof current?.value === 'number' ? current.value : 0;
  await db.meta.put({ key: META_KEYS.syncFailureCount, value: count + 1 });
}

/**
 * Wire the outbox to the browser's connectivity signals.
 *
 * `navigator.onLine` lies — it reports link state, not reachability, so a driver
 * on a captive-portal or a dead 4G cell reads as "online". The interval is the
 * safety net for exactly that case.
 */
export function startOutboxSync(intervalMs = 15_000): () => void {
  const onOnline = () => void flushOutbox();
  window.addEventListener('online', onOnline);

  // Coming back from the demo's offline switch has to drain the queue too,
  // otherwise the switch would look like it had broken sync rather than paused it.
  const unsubscribe = subscribeSimulatedOffline((offline) => {
    if (!offline) void flushOutbox();
  });

  const timer = window.setInterval(() => void flushOutbox(), intervalMs);
  void flushOutbox();

  return () => {
    window.removeEventListener('online', onOnline);
    unsubscribe();
    window.clearInterval(timer);
  };
}
