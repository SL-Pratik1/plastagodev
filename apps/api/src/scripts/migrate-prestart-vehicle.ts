import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { JobPreStartModel } from '../domains/jobs/job.model.js';
import { VehicleDefectModel } from '../domains/driver/defect.model.js';

const log = logger.child({ script: 'migrate-prestart-vehicle' });

/**
 * Pre-starts are now one per driver, day and VEHICLE (Matt, 21 Oct), and
 * pre-starts, defects and tip-off dockets link to the vehicle by its `_id`.
 *
 * ── What changes ──────────────────────────────────────────────────────────
 * The old key was a unique index on `jobId` (`job_unique`) — the driver's first
 * stop that day. That allowed one check per day however many trucks the driver
 * used, so a driver who changed truck mid-day could not check the second one.
 * The new key is a partial unique index on (driverId, date, vehicleId).
 *
 * The vehicle pages used to find pre-starts and defects by matching the plate,
 * so a truck that got new plates lost its history. They now follow `vehicleId`.
 *
 * ── Why a script ──────────────────────────────────────────────────────────
 * Mongoose creates indexes that are missing; it never drops one. So:
 *   1. every pre-start, defect and docket gets its `vehicleId`, from the plate
 *      it was saved with;
 *   2. every pre-start gets its `date` — the Sydney day it was completed;
 *   3. the old indexes are dropped;
 *   4. `syncIndexes` builds the new ones.
 *
 * Safe to run twice, and does nothing on an empty database. A plate with no
 * vehicle on the fleet is left unlinked (and counted). A pre-start that would
 * collide with another on the new key is left without a date (and logged)
 * rather than deleted: it still shows on the vehicle's Pre-start checks tab.
 *
 *     npm run migrate:prestart-vehicle --workspace=@plastago/api
 */
async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });
  log.info({ db: env.MONGODB_DB_NAME }, 'connected');

  const db = mongoose.connection;
  const collection = db.collection('jobprestarts');

  /* ── 1. Link by vehicle id ─────────────────────────────────────────────── */
  const vehicles = await db
    .collection('vehicles')
    .find({})
    .project<{ _id: mongoose.Types.ObjectId; rego: string }>({ rego: 1 })
    .toArray();
  const idByRego = new Map(vehicles.map((vehicle) => [vehicle.rego.trim().toUpperCase(), vehicle._id]));

  for (const name of ['jobprestarts', 'vehicledefects', 'runtipoffs']) {
    const target = db.collection(name);
    const unlinked = await target
      .find({ $or: [{ vehicleId: { $exists: false } }, { vehicleId: null }] })
      .project<{ _id: mongoose.Types.ObjectId; vehicleRego?: string | null }>({ vehicleRego: 1 })
      .toArray();

    let linked = 0;
    let unknown = 0;
    for (const row of unlinked) {
      const vehicleId = idByRego.get((row.vehicleRego ?? '').trim().toUpperCase());
      if (!vehicleId) {
        unknown += 1;
        continue;
      }
      await target.updateOne({ _id: row._id }, { $set: { vehicleId } });
      linked += 1;
    }
    log.info({ collection: name, linked, noVehicleOnTheFleet: unknown }, 'vehicle ids backfilled');
  }

  /* ── 2. Date every pre-start ───────────────────────────────────────────── */
  const undated = await collection
    .find({ $or: [{ date: { $exists: false } }, { date: null }] })
    .project<{ _id: mongoose.Types.ObjectId; driverId: mongoose.Types.ObjectId | null; vehicleId?: mongoose.Types.ObjectId | null; completedAt: Date }>({
      driverId: 1,
      vehicleId: 1,
      completedAt: 1,
    })
    .sort({ completedAt: 1 })
    .toArray();

  let dated = 0;
  let skipped = 0;

  for (const row of undated) {
    const date = row.completedAt.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    const clash = row.vehicleId
      ? await collection.findOne({
          _id: { $ne: row._id },
          driverId: row.driverId,
          date,
          vehicleId: row.vehicleId,
        })
      : null;

    if (clash) {
      skipped += 1;
      log.warn({ preStartId: row._id.toHexString(), date }, 'second check of the same truck that day — left undated');
      continue;
    }

    await collection.updateOne({ _id: row._id }, { $set: { date } });
    dated += 1;
  }
  log.info({ dated, skipped }, 'dates backfilled');

  /* ── 3. Drop the old indexes ───────────────────────────────────────────── */
  const stale: Array<[string, string]> = [
    ['jobprestarts', 'job_unique'],
    ['jobprestarts', 'driver_day_vehicle_unique'],
    ['jobprestarts', 'vehicle_completed'],
    ['vehicledefects', 'vehicle_history'],
  ];
  for (const [name, index] of stale) {
    const target = db.collection(name);
    const existing = await target.indexes().catch(() => []);
    if (existing.some((row) => row.name === index)) {
      await target.dropIndex(index);
      log.info({ collection: name, index }, 'dropped');
    }
  }

  /* ── 4. Build the new ones ─────────────────────────────────────────────── */
  await JobPreStartModel.syncIndexes();
  await VehicleDefectModel.syncIndexes();

  const after = await collection.indexes();
  log.info({ indexes: after.map((index) => index.name) }, 'migration complete');

  await mongoose.disconnect();
}

main().catch((error: unknown) => {
  log.error({ err: error }, 'migration failed');
  process.exitCode = 1;
});
