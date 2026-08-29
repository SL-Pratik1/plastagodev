import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import { db, META_KEYS } from './db';
import { isEffectivelyOffline, subscribeSimulatedOffline } from './transport';

/**
 * Whether the app should behave as connected.
 *
 * Tracks the browser's own events AND the demo's offline switch, so every screen
 * reads one answer. `navigator.onLine` alone lies — it reports link state, not
 * reachability, so a driver on a captive portal or a dead 4G cell reads as
 * online; see the note in `outbox.ts`.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => !isEffectivelyOffline());

  useEffect(() => {
    const sync = () => {
      setOnline(!isEffectivelyOffline());
    };
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    const unsubscribe = subscribeSimulatedOffline(sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
      unsubscribe();
    };
  }, []);

  return online;
}

export interface OutboxSummary {
  pending: number;
  failed: number;
  lastSyncAt: string | null;
}

/**
 * Live outbox counts, driven by Dexie's `liveQuery` so the UI updates the moment
 * the queue changes — no polling, no manual invalidation.
 *
 * The driver must be able to SEE what has and has not synced (§M4.12). A queue
 * that drains invisibly is indistinguishable from one that is stuck, and the
 * driver is the only person who can tell us it is stuck.
 */
export function useOutboxSummary(): OutboxSummary {
  const [summary, setSummary] = useState<OutboxSummary>({
    pending: 0,
    failed: 0,
    lastSyncAt: null,
  });

  useEffect(() => {
    const subscription = liveQuery(async () => {
      const [pending, failed, lastSync] = await Promise.all([
        db.outbox.where('status').anyOf('pending', 'syncing').count(),
        db.outbox.where('status').equals('failed').count(),
        db.meta.get(META_KEYS.lastSuccessfulSyncAt),
      ]);
      return {
        pending,
        failed,
        lastSyncAt: typeof lastSync?.value === 'string' ? lastSync.value : null,
      };
    }).subscribe({
      next: setSummary,
      error: (error: unknown) => {
        console.error('outbox liveQuery failed', error);
      },
    });

    return () => subscription.unsubscribe();
  }, []);

  return summary;
}
