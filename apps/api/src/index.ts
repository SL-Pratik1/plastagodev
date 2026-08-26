import type { Server } from 'node:http';
import { API_PREFIX } from '@plastago/shared';
import { env } from './config/env.js';
import { connectMongo, disconnectMongo } from './db/mongo.js';
import { disconnectRedis } from './db/redis.js';
import { logger } from './lib/logger.js';
import { closeQueues } from './queues/index.js';
import { createServer } from './server.js';

const log = logger.child({ module: 'bootstrap' });

async function main(): Promise<void> {
  await connectMongo();

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

  registerShutdown(server);
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
