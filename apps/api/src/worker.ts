import { env } from './config/env.js';
import { connectMongo, disconnectMongo } from './db/mongo.js';
import { auditWatcher } from './domains/audit/audit.watcher.js';
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
  await connectMongo();

  /*
   * M1.6 · §6A.3 #7 — the audit change-stream backstop.
   *
   * Started here rather than in the API because it must run EXACTLY ONCE: one
   * watcher per API replica would write one copy of every unattributed change
   * per replica, into a collection that by design cannot be de-duplicated
   * afterwards.
   *
   * It needs Mongo and nothing else, so it starts before the Redis check below
   * and survives a deployment with queues switched off. On a standalone `mongod`
   * it declines with a warning rather than failing — see the watcher.
   */
  await auditWatcher.start();

  if (!env.ENABLE_QUEUES) {
    /*
     * No longer fatal. The audit backstop above is real work, and killing the
     * process would take it down with the queues — which is how a deployment
     * ends up with no accountability log and no sign that it is missing.
     */
    log.warn(
      'ENABLE_QUEUES=false — running the audit backstop only. ' +
        'Start Redis and set ENABLE_QUEUES=true for the background queues.',
    );
    installShutdown([]);
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
      // Closed before Mongo: the stream holds a cursor on that connection.
      await auditWatcher.stop();
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
