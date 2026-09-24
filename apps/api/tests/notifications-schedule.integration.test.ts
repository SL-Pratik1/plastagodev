import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UserModel } from '../src/domains/auth/auth.model.js';
import { RunModel } from '../src/domains/dispatch/run.model.js';
import { JobModel } from '../src/domains/jobs/job.model.js';
import { jobRepository } from '../src/domains/jobs/job.repository.js';
import { ScheduledRunModel } from '../src/domains/notifications/notification.model.js';
import { notificationRepository } from '../src/domains/notifications/notification.repository.js';

/**
 * The filters behind the notification fixes of 2026-09-24, against a real Mongo.
 *
 * ── Why these are not in the service suites ───────────────────────────────
 * Those fake their repositories, and a fake accepts whatever filter it is
 * handed. Each thing below is a query whose mistake is invisible there and
 * visible to a customer or a driver:
 *
 *  • "ready for tomorrow?" must pick the jobs on TOMORROW'S RUNS — not the
 *    jobs whose SLA deadline is tomorrow, which is what it used to do;
 *  • a job whose date moved past its run must come off it, and the stops left
 *    behind must be renumbered;
 *  • each alert must reach the roles that can act on it, allocator included;
 *  • a scheduled slot must run once, however many processes race for it.
 *
 * Its own database, dropped afterwards. Skips where there is no Mongo.
 */

const MONGO_URL = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const TEST_DB = 'plastago_notify_schedule_test';

let reachable = false;

beforeAll(async () => {
  try {
    await mongoose.connect(MONGO_URL, { dbName: TEST_DB, serverSelectionTimeoutMS: 2000 });
    reachable = true;
    await ScheduledRunModel.syncIndexes();
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
  if (reachable) {
    await Promise.all([
      JobModel.deleteMany({}),
      RunModel.deleteMany({}),
      UserModel.deleteMany({}),
      ScheduledRunModel.deleteMany({}),
    ]);
  }
});

const ACCOUNT = new mongoose.Types.ObjectId();
const ZONE = new mongoose.Types.ObjectId();
const TOMORROW = '2026-09-25';

let nextNumber = 80_000;

async function run(date: string, driverId: mongoose.Types.ObjectId | null = null) {
  nextNumber += 1;
  const { insertedId } = await RunModel.collection.insertOne({
    runNumber: nextNumber,
    name: `Run ${String(nextNumber)}`,
    date,
    status: driverId ? 'assigned' : 'planning',
    driverId,
    driverName: driverId ? 'Troy Holm' : null,
  });
  return insertedId;
}

/** A job with the fields the reminder reads. Raw, like the other integration suites. */
async function job(input: {
  status: string;
  runId?: mongoose.Types.ObjectId | null;
  runSequence?: number | null;
  driverId?: mongoose.Types.ObjectId | null;
  targetDate?: string;
}): Promise<mongoose.Types.ObjectId> {
  nextNumber += 1;
  const { insertedId } = await JobModel.collection.insertOne({
    jobNumber: nextNumber,
    status: input.status,
    accountId: ACCOUNT,
    accountName: 'Westbrook Homes',
    siteName: `Lot ${String(nextNumber)} Kingsford Smith Avenue`,
    suburb: 'Austral',
    zoneId: ZONE,
    readyDate: '2026-09-24',
    targetDate: input.targetDate ?? '2026-10-01',
    siteContactEmail: 'site@westbrook.com.au',
    siteContactMobile: null,
    bookedByUserId: null,
    runId: input.runId ?? null,
    runSequence: input.runSequence ?? null,
    driverId: input.driverId ?? null,
    driverName: input.driverId ? 'Troy Holm' : null,
  });
  return insertedId;
}

describe('"ready for tomorrow?" follows the truck', () => {
  it("asks the jobs on tomorrow's runs — whatever their deadline", async ({ skip }) => {
    if (!reachable) skip();

    const tomorrowsRun = await run(TOMORROW);
    const onRun = await job({ status: 'assigned', runId: tomorrowsRun, targetDate: '2026-10-01' });

    const reminders = await jobRepository.dueForReadinessReminder(TOMORROW);

    expect(reminders.map((reminder) => reminder.id)).toEqual([onRun.toHexString()]);
    expect(reminders[0]).toMatchObject({ runDate: TOMORROW, readyDate: '2026-09-24' });
  });

  /* The old rule: asked about "tomorrow's pickup" when no truck was coming. */
  it('does not ask a job with no truck, even when its deadline is tomorrow', async ({ skip }) => {
    if (!reachable) skip();

    await job({ status: 'booked', runId: null, targetDate: TOMORROW });

    expect(await jobRepository.dueForReadinessReminder(TOMORROW)).toEqual([]);
  });

  it('asks nobody on a run for another day', async ({ skip }) => {
    if (!reachable) skip();

    const laterRun = await run('2026-09-28');
    await job({ status: 'assigned', runId: laterRun });

    expect(await jobRepository.dueForReadinessReminder(TOMORROW)).toEqual([]);
  });

  it('leaves out stops that have already left the depot', async ({ skip }) => {
    if (!reachable) skip();

    const tomorrowsRun = await run(TOMORROW);
    await job({ status: 'in-transit', runId: tomorrowsRun });
    await job({ status: 'cancelled', runId: tomorrowsRun });

    expect(await jobRepository.dueForReadinessReminder(TOMORROW)).toEqual([]);
  });
});

describe('a job whose date moved past its run', () => {
  it('reports the run it is on, with its day and driver', async ({ skip }) => {
    if (!reachable) skip();

    const driver = new mongoose.Types.ObjectId();
    const runId = await run(TOMORROW, driver);
    const id = await job({ status: 'assigned', runId, runSequence: 1, driverId: driver });

    expect(await jobRepository.allocationOf(id.toHexString())).toMatchObject({
      runId: runId.toHexString(),
      runDate: TOMORROW,
      driverId: driver.toHexString(),
      status: 'assigned',
    });
  });

  it('comes off it — back to booked, with no run and no driver', async ({ skip }) => {
    if (!reachable) skip();

    const driver = new mongoose.Types.ObjectId();
    const runId = await run(TOMORROW, driver);
    const moved = await job({ status: 'in-transit', runId, runSequence: 1, driverId: driver });

    expect(await jobRepository.releaseFromRun(moved.toHexString(), runId.toHexString())).toBe(true);

    const row = await JobModel.collection.findOne({ _id: moved });
    expect(row).toMatchObject({ status: 'booked', runId: null, driverId: null, runSequence: null });
  });

  it('renumbers the stops left behind, so the sheet never reads 1, 3', async ({ skip }) => {
    if (!reachable) skip();

    const runId = await run(TOMORROW);
    const first = await job({ status: 'booked', runId, runSequence: 1 });
    const moved = await job({ status: 'booked', runId, runSequence: 2 });
    const third = await job({ status: 'booked', runId, runSequence: 3 });

    await jobRepository.releaseFromRun(moved.toHexString(), runId.toHexString());

    const [a, b] = await Promise.all([
      JobModel.collection.findOne({ _id: first }),
      JobModel.collection.findOne({ _id: third }),
    ]);
    expect(a?.runSequence).toBe(1);
    expect(b?.runSequence).toBe(2);
  });

  it('touches nothing when the job is no longer on that run', async ({ skip }) => {
    if (!reachable) skip();

    const runId = await run(TOMORROW);
    const elsewhere = await run('2026-09-28');
    const id = await job({ status: 'booked', runId: elsewhere, runSequence: 1 });

    expect(await jobRepository.releaseFromRun(id.toHexString(), runId.toHexString())).toBe(false);
  });
});

describe('who a staff alert reaches', () => {
  async function staff(name: string, roles: string[], status = 'active') {
    await UserModel.collection.insertOne({ name, email: null, role: roles[0], roles, status });
  }

  it('finds the allocator when asked for, and not otherwise', async ({ skip }) => {
    if (!reachable) skip();

    await staff('Renee', ['operations']);
    await staff('Priya', ['office-staff']);
    await staff('Dean', ['allocator', 'driver']);
    await staff('Troy', ['driver']);
    await staff('Former', ['office-staff'], 'suspended');

    const office = await notificationRepository.officeRecipients();
    const fleet = await notificationRepository.officeRecipients(['super-admin', 'operations', 'allocator']);

    expect(office.map((person) => person.name).sort()).toEqual(['Priya', 'Renee']);
    expect(fleet.map((person) => person.name).sort()).toEqual(['Dean', 'Renee']);
    // Roles come back, so each person can be linked to a screen they can open.
    expect(fleet.find((person) => person.name === 'Dean')?.roles).toEqual(['allocator', 'driver']);
  });
});

describe('a scheduled slot runs once', () => {
  it('lets exactly one of several racing claims win', async ({ skip }) => {
    if (!reachable) skip();

    const claims = await Promise.all(
      Array.from({ length: 5 }, () => notificationRepository.claimScheduledRun('queue-sweep', TOMORROW)),
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('never runs a finished slot again', async ({ skip }) => {
    if (!reachable) skip();

    expect(await notificationRepository.claimScheduledRun('queue-sweep', TOMORROW)).toBe(true);
    await notificationRepository.finishScheduledRun('queue-sweep', TOMORROW, 'done', null);

    expect(await notificationRepository.claimScheduledRun('queue-sweep', TOMORROW)).toBe(false);
  });

  /* A failure is retried — a few times, not every five minutes all day. */
  it('retries a failed slot, but gives up after three attempts', async ({ skip }) => {
    if (!reachable) skip();

    const attempts: boolean[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const claimed = await notificationRepository.claimScheduledRun('readiness-reminders', `${TOMORROW}T15`);
      attempts.push(claimed);
      if (claimed) {
        await notificationRepository.finishScheduledRun(
          'readiness-reminders',
          `${TOMORROW}T15`,
          'failed',
          'boom',
        );
      }
    }

    expect(attempts).toEqual([true, true, true, false]);
  });

  it('takes over a slot abandoned mid-run', async ({ skip }) => {
    if (!reachable) skip();

    const longAgo = new Date(Date.now() - 60 * 60_000);
    expect(await notificationRepository.claimScheduledRun('queue-sweep', TOMORROW, longAgo)).toBe(true);

    // Still "running" an hour later: the process died under it.
    expect(await notificationRepository.claimScheduledRun('queue-sweep', TOMORROW)).toBe(true);
  });

  it('does not take over a run still in progress', async ({ skip }) => {
    if (!reachable) skip();

    expect(await notificationRepository.claimScheduledRun('queue-sweep', TOMORROW)).toBe(true);
    expect(await notificationRepository.claimScheduledRun('queue-sweep', TOMORROW)).toBe(false);
  });
});
