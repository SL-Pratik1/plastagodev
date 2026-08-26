import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'redis' });

let client: Redis | null = null;

/**
 * Redis backs BullMQ (§6A.1). It is opt-in via `ENABLE_QUEUES` so the API boots
 * on a machine without Redis installed — the frontend team is never blocked on
 * infrastructure they don't need yet.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ: its blocking commands must
 * not be aborted by the client's own retry budget.
 */
export function getRedis(): Redis | null {
  if (!env.ENABLE_QUEUES) return null;

  if (!client) {
    client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    client.on('ready', () => log.info('ready'));
    client.on('error', (error: Error) => log.error({ err: error }, 'connection error'));
  }

  return client;
}

export async function pingRedis(): Promise<number> {
  const redis = getRedis();
  if (!redis) throw new Error('Queues are disabled');
  const startedAt = performance.now();
  await redis.ping();
  return Math.round(performance.now() - startedAt);
}

export async function disconnectRedis(): Promise<void> {
  if (!client) return;
  await client.quit();
  client = null;
}
