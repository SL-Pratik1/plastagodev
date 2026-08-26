import Dexie, { type EntityTable } from 'dexie';

/**
 * Local database for the driver PWA.
 *
 * ⚠️ This is the SCHEMA HALF of the offline story. The other half — the sync
 * protocol — must be written down before either driver implementation is built
 * (§6A.4, §13.5 rule 3): operation log · idempotency keys · last-write-wins with
 * server arbitration · explicit conflict cases · photos as a separate resumable
 * queue. The Flutter app implements the same protocol against Drift, so a vague
 * shared understanding is how the two silently diverge.
 *
 * The tables here are deliberately DOMAIN-FREE. An outbox that stores
 * `{ method, path, body }` needs no change when a new job action is added, and
 * it keeps the queue's replay logic in one place instead of one per feature.
 */

export type OutboxStatus = 'pending' | 'syncing' | 'failed';

export interface OutboxOperation {
  id: number;
  /**
   * Client-generated UUID sent as the `idempotency-key` header. Without it, a
   * retry after a timeout can double-create — the driver taps "Complete" once,
   * the server records it twice.
   */
  idempotencyKey: string;
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body: unknown;
  /** Monotonic ordering: operations replay in the order the driver performed them. */
  createdAt: string;
  attempts: number;
  status: OutboxStatus;
  lastError?: string;
  nextAttemptAt?: string;
}

export interface PendingUpload {
  id: number;
  /** Links the file to the operation that references it. */
  idempotencyKey: string;
  /** Server-issued presigned target. Photos go direct to S3 (§6A.10 #9). */
  uploadUrl?: string;
  contentType: string;
  blob: Blob;
  createdAt: string;
  attempts: number;
  lastError?: string;
}

export interface SyncMeta {
  key: string;
  value: unknown;
}

class DriverDatabase extends Dexie {
  outbox!: EntityTable<OutboxOperation, 'id'>;
  uploads!: EntityTable<PendingUpload, 'id'>;
  meta!: EntityTable<SyncMeta, 'key'>;

  constructor() {
    super('plastago-driver');

    // Bump the version and add a new `.stores()` block for any schema change —
    // never edit an existing one. Drivers will have live data in here.
    this.version(1).stores({
      outbox: '++id, status, createdAt, idempotencyKey',
      uploads: '++id, idempotencyKey, createdAt',
      meta: 'key',
    });
  }
}

export const db = new DriverDatabase();

/** Keys used in the `meta` table, so they are not stringly-typed at call sites. */
export const META_KEYS = {
  /** Surfaced on the admin dashboard as the stand-in for error tracking (§6A.8). */
  lastSuccessfulSyncAt: 'lastSuccessfulSyncAt',
  syncFailureCount: 'syncFailureCount',
} as const;
