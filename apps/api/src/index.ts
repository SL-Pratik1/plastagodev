import type { Server } from 'node:http';
import { API_PREFIX } from '@plastago/shared';
import { initAuth } from './auth/better-auth.js';
import { env } from './config/env.js';
import { connectMongo, disconnectMongo, isMongoConnected } from './db/mongo.js';
import { authRepository } from './domains/auth/auth.repository.js';
import { wireExtractor } from './domains/extractor/extractor.service.js';
import { scheduler } from './domains/notifications/scheduler.service.js';
import { disconnectRedis } from './db/redis.js';
import { logger } from './lib/logger.js';
import { closeQueues } from './queues/index.js';
import { createServer } from './server.js';

const log = logger.child({ module: 'bootstrap' });

async function main(): Promise<void> {
  await connectMongo();
  await prepareDatabase();
  await initAuth();

  // The extractor's credentials live in Mongo, so this has to follow the
  // connection and precede the first request that could reach the vendor.
  wireExtractor();

  const app = createServer();
  const server: Server = app.listen(env.PORT, () => {
    log.info(
      {
        port: env.PORT,
        env: env.NODE_ENV,
        queues: env.ENABLE_QUEUES ? 'enabled' : 'disabled',
      },
      `API listening on http://localhost:${String(env.PORT)}${API_PREFIX}`,
    );
  });

  // Give in-flight requests a chance to finish; a hard exit mid-invoice-write is
  // exactly the failure a transactional system must not have.
  server.headersTimeout = 65_000;
  server.requestTimeout = 60_000;

  /*
   * The daily sweep and the evening reminders. Only with a database: every run
   * claims its slot there first, and without one nothing could be claimed.
   */
  if (isMongoConnected()) scheduler.start();

  registerShutdown(server);
}

/**
 * Idempotent database preparation, on every boot.
 *
 * Indexes and `$jsonSchema` validators are not optional extras — the unique
 * index on `email` is what makes "one identifier, one person" true, and the
 * validators are the only integrity guard that applies to writers we do not
 * control (§6A.3 #4, #6). Applying them at boot means no environment can be
 * missing them because somebody forgot to run a script.
 *
 * Never fatal in development: a laptop with no Mongo should still serve, and
 * `/readyz` reports the truth.
 */
async function prepareDatabase(): Promise<void> {
  if (!isMongoConnected()) {
    log.warn('skipping index and validator setup — no database connection');
    return;
  }

  try {
    await authRepository.createIndexes();
    await authRepository.ensureSchemaValidators();
    await authRepository.seedBrands();
    log.info('indexes, validators and brand reference data are in place');
  } catch (error) {
    log.error({ err: error }, 'database preparation failed');
    if (env.NODE_ENV === 'production') throw error;
  }
}

function registerShutdown(server: Server): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    void (async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info({ signal }, 'shutting down');

      const forceExit = setTimeout(() => {
        log.error('graceful shutdown timed out — forcing exit');
        process.exit(1);
      }, 15_000);
      forceExit.unref();

      try {
        scheduler.stop();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        await closeQueues();
        await disconnectRedis();
        await disconnectMongo();
        log.info('shutdown complete');
        process.exit(0);
      } catch (error) {
        log.error({ err: error }, 'error during shutdown');
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A crash we cannot reason about must be loud and fatal, not silently limping.
  process.on('unhandledRejection', (reason) => {
    log.fatal({ err: reason }, 'unhandled promise rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    log.fatal({ err: error }, 'uncaught exception');
    process.exit(1);
  });
}

void main().catch((error: unknown) => {
  log.fatal({ err: error }, 'failed to start');
  process.exit(1);
});
