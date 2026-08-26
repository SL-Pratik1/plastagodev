import { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { getRedis } from '../db/redis.js';
import { logger } from '../lib/logger.js';
import { QUEUE_NAMES, type QueueName } from './queue-names.js';

const log = logger.child({ module: 'queues' });

const queues = new Map<QueueName, Queue>();

/**
 * BullMQ queue accessor (§6A.1).
 *
 * Returns `null` when `ENABLE_QUEUES=false` so callers degrade rather than
 * crash on a machine with no Redis. Producers must therefore treat enqueueing
 * as best-effort during local development — which is correct anyway, since a
 * queued side effect should never be required for a request to succeed.
 */
export function getQueue(name: QueueName): Queue | null {
  const connection = getRedis();
  if (!connection) return null;

  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        // Keep a window of history so the admin dashboard can surface
        // failed-job counts (§6A.8) — dead-letter jobs must be visible.
        removeOnComplete: { age: 86_400, count: 1_000 },
        removeOnFail: { age: 604_800 },
      },
    });
    queues.set(name, queue);
    log.info({ queue: name }, 'queue ready');
  }
  return queue;
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();
}

export function queuesEnabled(): boolean {
  return env.ENABLE_QUEUES;
}

export { QUEUE_NAMES };
export type { QueueName };
