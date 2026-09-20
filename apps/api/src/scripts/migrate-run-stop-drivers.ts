import { OPEN_JOB_STATUSES } from '@plastago/shared';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { JobModel } from '../domains/jobs/job.model.js';
import { RunModel } from '../domains/dispatch/run.model.js';

const log = logger.child({ script: 'migrate-run-stop-drivers' });

/**
 * Put the driver back on stops that sit on a staffed run without one.
 *
 * ── Why any stop is in that state ─────────────────────────────────────────
 * `runRepository.assign` used to propagate the driver only to stops still at
 * `booked`, because the same write also moved them to `assigned`. Any stop that
 * had already been pushed further — marked arrived from the office, say — was
 * skipped by that filter and kept `driverId: null`.
 *
 * That is invisible on the board and fatal on the phone. The run sheet lists
 * stops by `runId`, so the driver SEES it; every other driver route filters by
 * `driverId`, so opening it 404s and no status update against it can land. The
 * repository no longer does that, but rows written before the fix are still
 * sitting there, and a driver cannot repair one from the cab.
 *
 * ── What it deliberately does not touch ───────────────────────────────────
 * Only OPEN stops, and only where the driver is genuinely absent. A completed
 * or futile stop carries the driver who actually did the work, and a cancelled
 * one never had a driver at all — stamping today's allocation onto either would
 * be rewriting history to fix a bug in the present.
 *
 * Safe to run repeatedly — matched rows stop matching once they are fixed.
 *
 *     npm run migrate:run-stop-drivers --workspace=@plastago/api
 */
async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });
  log.info({ db: env.MONGODB_DB_NAME }, 'connected');

  const staffed = await RunModel.find({ driverId: { $ne: null } })
    .select({ _id: 1, driverId: 1, driverName: 1, date: 1 })
    .lean<
      Array<{
        _id: mongoose.Types.ObjectId;
        driverId: mongoose.Types.ObjectId;
        driverName: string | null;
        date: string;
      }>
    >();

  log.info({ runs: staffed.length }, 'runs with a driver on them');

  let repaired = 0;

  for (const run of staffed) {
    /*
     * One update per run rather than one per stop: the driver is a property of
     * the run, so the whole run's worth of stops takes the same value and the
     * query planner uses the `runId` index once.
     */
    const result = await JobModel.updateMany(
      { runId: run._id, status: { $in: OPEN_JOB_STATUSES }, driverId: null },
      { $set: { driverId: run.driverId, driverName: run.driverName } },
    );

    if (result.modifiedCount > 0) {
      log.info(
        { runId: run._id.toHexString(), date: run.date, stops: result.modifiedCount },
        'stops restored to their driver',
      );
      repaired += result.modifiedCount;
    }
  }

  log.info({ repaired }, 'migration complete');

  await mongoose.disconnect();
}

main().catch((error: unknown) => {
  log.error({ err: error }, 'migration failed');
  process.exitCode = 1;
});
