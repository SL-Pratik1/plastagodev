import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunModel } from '../src/domains/dispatch/run.model.js';
import { runRepository } from '../src/domains/dispatch/run.repository.js';
import { JobModel } from '../src/domains/jobs/job.model.js';
import { driverRepository } from '../src/domains/driver/driver.repository.js';

/**
 * That staffing a run reaches every stop on it.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * `assign` propagated the driver in the same write that moved a stop from
 * `booked` to `assigned`, so its filter was `status: 'booked'`. Any stop that
 * had already moved further — the office marks one arrived, or the run was
 * unassigned for an edit and re-staffed — was skipped, and kept `driverId:
 * null`.
 *
 * Nothing showed it. The board reads runs, the run sheet lists stops by
 * `runId`, and both looked right. The failure only appeared on the phone, at
 * the fence: `findJobForDriver` filters by `driverId`, so the driver could see
 * the stop in his list and get a 404 opening it, and every status write against
 * it failed the same filter.
 *
 * The service suite could not catch it — it fakes the run repository, and a
 * fake accepts whatever filter you hand it. So this one goes to a real Mongo,
 * and skips where there is not one.
 */

const MONGO_URL = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const TEST_DB = 'plastago_assign_test';

let reachable = false;

beforeAll(async () => {
  try {
    await mongoose.connect(MONGO_URL, { dbName: TEST_DB, serverSelectionTimeoutMS: 2000 });
    reachable = true;
  } catch {
    reachable = false;
  }
});

afterAll(async () => {
  if (reachable) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

beforeEach(async () => {
  if (reachable) await Promise.all([RunModel.deleteMany({}), JobModel.deleteMany({})]);
});

const DATE = '2026-09-20';
const DRIVER = new mongoose.Types.ObjectId();
const ACCOUNT = new mongoose.Types.ObjectId();
const ZONE = new mongoose.Types.ObjectId();

/** A run in `planning` with one stop per status asked for. */
async function runWithStops(statuses: string[]): Promise<{ runId: string; jobIds: string[] }> {
  const run = await RunModel.create({
    runNumber: Math.floor(Math.random() * 1_000_000) + 1,
    name: 'Run 1 — North West',
    date: DATE,
    status: 'planning',
  });

  const jobIds: string[] = [];

  for (const [index, status] of statuses.entries()) {
    /*
     * `insertOne` on the raw collection rather than `JobModel.create`: a job
     * carries a long tail of required fields that have nothing to do with what
     * is under test here, and inventing plausible values for all of them would
     * make the test about job validation instead of about the assign filter.
     *
     * `accountId` and `zoneId` are the exception: the driver's read joins on
     * both to decorate a stop, so a job without them is not a thin fixture, it
     * is an impossible row.
     */
    const { insertedId } = await JobModel.collection.insertOne({
      jobNumber: 70_000 + index,
      status,
      runId: run._id,
      runSequence: index + 1,
      driverId: null,
      driverName: null,
      readyDate: DATE,
      accountId: ACCOUNT,
      zoneId: ZONE,
    });
    jobIds.push(insertedId.toHexString());
  }

  return { runId: run._id.toHexString(), jobIds };
}

/*
 * Takes `string | undefined` because `noUncheckedIndexedAccess` is on and
 * `jobIds[0]` is honestly typed. Throwing here names the real fault — the
 * fixture built fewer stops than the test reads — rather than failing later on
 * a confusing assertion about a row that was never created.
 */
async function driverOn(
  jobId: string | undefined,
): Promise<{ driverId: string | null; status: string }> {
  if (jobId === undefined) throw new Error('the fixture did not create that stop');

  const row = await JobModel.collection.findOne({ _id: new mongoose.Types.ObjectId(jobId) });
  return {
    driverId: row?.driverId ? String(row.driverId) : null,
    status: String(row?.status),
  };
}

describe('assigning a driver to a run', () => {
  it('stamps the driver on a stop that has already moved past booked', async ({ skip }) => {
    if (!reachable) skip();

    const { runId, jobIds } = await runWithStops(['arrived', 'booked']);

    await runRepository.assign(runId, DRIVER.toHexString(), 'Troy Holm', 1);

    // The assertion the original bug failed: the arrived stop gets a driver…
    const arrived = await driverOn(jobIds[0]);
    expect(arrived.driverId).toBe(DRIVER.toHexString());

    // …without being walked backwards to `assigned`, which would throw away the
    // driver's own timestamped progress.
    expect(arrived.status).toBe('arrived');
  });

  it('still moves a booked stop to assigned', async ({ skip }) => {
    if (!reachable) skip();

    const { runId, jobIds } = await runWithStops(['booked']);

    await runRepository.assign(runId, DRIVER.toHexString(), 'Troy Holm', 1);

    expect(await driverOn(jobIds[0])).toEqual({
      driverId: DRIVER.toHexString(),
      status: 'assigned',
    });
  });

  /*
   * A cancelled stop is the one that must NOT be stamped. It has no driver
   * because nobody drove to it, and writing today's allocation onto it would be
   * inventing a history that did not happen.
   */
  it('leaves a cancelled stop alone', async ({ skip }) => {
    if (!reachable) skip();

    const { runId, jobIds } = await runWithStops(['cancelled']);

    await runRepository.assign(runId, DRIVER.toHexString(), 'Troy Holm', 1);

    expect(await driverOn(jobIds[0])).toEqual({ driverId: null, status: 'cancelled' });
  });

  /*
   * The end the driver actually stands at. A stop he can see on his run sheet
   * and cannot open is worse than one that is missing, because he has no way to
   * tell which it is from the cab.
   */
  it('leaves every stop on the run openable by that driver', async ({ skip }) => {
    if (!reachable) skip();

    const { runId, jobIds } = await runWithStops(['arrived', 'booked']);

    await runRepository.assign(runId, DRIVER.toHexString(), 'Troy Holm', 1);

    for (const jobId of jobIds) {
      const stop = await driverRepository.findJobForDriver(jobId, DRIVER.toHexString());
      expect(stop, `stop ${jobId} is on the run but its driver cannot open it`).not.toBeNull();
    }
  });
});
