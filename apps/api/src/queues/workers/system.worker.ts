import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { logger } from '../../lib/logger.js';
import { QUEUE_NAMES, type SystemJobs } from '../queue-names.js';

const log = logger.child({ module: 'worker:system' });

/**
 * Reference worker. It proves the wiring end to end — Redis, BullMQ,
 * concurrency, failure logging — without pretending to do any real work.
 *
 * Copy this shape for the real workers (notifications, documents, po-ingestion).
 * Two things every one of them must keep:
 *   • a `switch` on `job.name` that is exhaustive, so a new job type cannot be
 *     silently dropped
 *   • a failure handler that logs, because a stuck queue is otherwise invisible
 *     with no error-tracking vendor (§6A.8)
 */
export function createSystemWorker(connection: Redis): Worker {
  const worker = new Worker(
    QUEUE_NAMES.system,
    async (job: Job<SystemJobs[keyof SystemJobs]>) => {
      switch (job.name) {
        case 'heartbeat': {
          log.info({ jobId: job.id, enqueuedAt: job.data.enqueuedAt }, 'heartbeat');
          await job.updateProgress(100);
          return { ok: true };
        }
        default:
          throw new Error(`Unknown job name: ${job.name}`);
      }
    },
    { connection, concurrency: 5 },
  );

  worker.on('failed', (job, error) => {
    log.error({ jobId: job?.id, name: job?.name, err: error }, 'job failed');
  });
  worker.on('error', (error) => {
    log.error({ err: error }, 'worker error');
  });

  return worker;
}
