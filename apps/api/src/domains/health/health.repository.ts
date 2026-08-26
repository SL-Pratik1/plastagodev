import type { DependencyCheck } from '@plastago/shared';
import { env } from '../../config/env.js';
import { isMongoConnected, pingMongo } from '../../db/mongo.js';
import { pingRedis } from '../../db/redis.js';

/**
 * Repository layer — the ONLY place in this domain that touches Mongoose or the
 * Redis client (§6A.3 #5).
 *
 * Note what this buys even for something as small as health: the service below
 * has no idea which database is in use, so it needs no change when Mongo moves
 * from a local standalone to Atlas.
 */
export const healthRepository = {
  async checkMongo(): Promise<DependencyCheck> {
    if (!isMongoConnected()) {
      return { state: 'down', detail: 'No active connection' };
    }
    try {
      const latencyMs = await pingMongo();
      return { state: 'up', latencyMs };
    } catch (error) {
      return { state: 'down', detail: toDetail(error) };
    }
  },

  async checkRedis(): Promise<DependencyCheck> {
    if (!env.ENABLE_QUEUES) {
      return { state: 'disabled', detail: 'ENABLE_QUEUES=false' };
    }
    try {
      const latencyMs = await pingRedis();
      return { state: 'up', latencyMs };
    } catch (error) {
      return { state: 'down', detail: toDetail(error) };
    }
  },
};

function toDetail(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
