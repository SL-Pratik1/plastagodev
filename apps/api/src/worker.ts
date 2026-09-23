import { env } from './config/env.js';
import { connectMongo, disconnectMongo } from './db/mongo.js';
import { disconnectRedis, getRedis } from './db/redis.js';
import { wireExtractor } from './domains/extractor/extractor.service.js';
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
  await connectMongo();

  // Jobs in this process can reach the extractor, and its credentials are in
  // Mongo — so the store is installed here too, not only in the web process.
  wireExtractor();

  if (!env.ENABLE_QUEUES) {
    /*
     * The queues are the only thing this process runs, so with them switched off
     * there is nothing left for it to do. It stops cleanly rather than fatally:
     * a crash-looping worker in a local or preview environment that deliberately
     * runs without Redis is noise, not a signal.
     */
    log.warn(
      'ENABLE_QUEUES=false — nothing for the worker to run. ' +
        'Start Redis and set ENABLE_QUEUES=true for the background queues.',
    );
    await disconnectMongo();
    return;
  }

  const connection = getRedis();
  if (!connection) {
    log.fatal('no Redis connection available');
    process.exit(1);
  }

  const workers = [createSystemWorker(connection)];
  log.info({ workers: workers.length }, 'workers started');

  installShutdown(workers);
}

/** Drains whatever this process ended up running, in the right order. */
function installShutdown(workers: Array<{ close: () => Promise<void> }>): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    void (async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info({ signal, workers: workers.length }, 'draining workers');
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
