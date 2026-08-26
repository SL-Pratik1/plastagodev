import { env } from './config/env.js';
import { connectMongo, disconnectMongo } from './db/mongo.js';
import { disconnectRedis, getRedis } from './db/redis.js';
import { logger } from './lib/logger.js';
import { createSystemWorker } from './queues/workers/system.worker.js';

const log = logger.child({ module: 'worker-bootstrap' });

/**
 * Separate worker process (§6A.1: "one service, plus BullMQ worker processes").
 *
 * Deployed as its own Render service so a slow PDF render or a stuck OCR call
 * can never occupy a web request slot.
 */
async function main(): Promise<void> {
  if (!env.ENABLE_QUEUES) {
    log.error(
      'ENABLE_QUEUES=false — nothing for this process to do. ' +
        'Start Redis and set ENABLE_QUEUES=true.',
    );
    process.exit(1);
  }

  const connection = getRedis();
  if (!connection) {
    log.fatal('no Redis connection available');
    process.exit(1);
  }

  await connectMongo();

  const workers = [createSystemWorker(connection)];
  log.info({ workers: workers.length }, 'workers started');

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    void (async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info({ signal }, 'draining workers');
      // Let in-flight jobs finish so a half-written side effect is not left behind.
      await Promise.all(workers.map((worker) => worker.close()));
      await disconnectRedis();
      await disconnectMongo();
      process.exit(0);
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main().catch((error: unknown) => {
  log.fatal({ err: error }, 'worker failed to start');
  process.exit(1);
});
