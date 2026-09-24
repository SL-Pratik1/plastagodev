import mongoose from 'mongoose';
import { OPEN_JOB_STATUSES } from '@plastago/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UserModel } from '../src/domains/auth/auth.model.js';
import { JobCommentModel, JobModel } from '../src/domains/jobs/job.model.js';
import { jobRepository } from '../src/domains/jobs/job.repository.js';
import { notificationRepository } from '../src/domains/notifications/notification.repository.js';
import { portalRepository } from '../src/domains/portal/portal.repository.js';

/**
 * The three database filters behind two fixes, against a real Mongo.
 *
 * ── Why these are not in the service suites ───────────────────────────────
 * The service suites fake their repositories, and a fake accepts whatever
 * filter it is handed. Each thing below is a filter whose mistake would be
 * invisible there and visible to a customer:
 *
 *  • the risk-assessment rule must reach an account's OPEN jobs and nothing
 *    else — not its finished jobs, and never another account's;
 *  • an office message must notify the account's administrators and the
 *    supervisor who booked the pickup — not every supervisor on the account;
 *  • the portal thread must carry both sides of the customer thread, and only
 *    that thread.
 *
 * Skips where there is no Mongo, like the other integration suites.
 */

const MONGO_URL = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const TEST_DB = 'plastago_messages_test';

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
  if (reachable) {
    await Promise.all([
      JobModel.deleteMany({}),
      JobCommentModel.deleteMany({}),
      UserModel.deleteMany({}),
    ]);
  }
});

const ACCOUNT = new mongoose.Types.ObjectId();
const OTHER_ACCOUNT = new mongoose.Types.ObjectId();
const ZONE = new mongoose.Types.ObjectId();

let nextJobNumber = 70_000;

/**
 * A job with the fields the portal's read decorates a pickup with.
 *
 * Raw `insertOne` rather than `JobModel.create`: a job carries a long tail of
 * required fields that have nothing to do with what is under test, and
 * inventing all of them would make this a test of job validation.
 */
async function job(input: {
  status: string;
  accountId?: mongoose.Types.ObjectId;
  riskAssessmentRequired?: boolean;
  bookedByUserId?: mongoose.Types.ObjectId | null;
}): Promise<mongoose.Types.ObjectId> {
  nextJobNumber += 1;
  const { insertedId } = await JobModel.collection.insertOne({
    jobNumber: nextJobNumber,
    status: input.status,
    accountId: input.accountId ?? ACCOUNT,
    accountName: 'Westbrook Homes',
    siteName: `Lot ${String(nextJobNumber)} Kingsford Smith Avenue`,
    suburb: 'Austral',
    zoneId: ZONE,
    builderName: '',
    poNumber: null,
    bookedByName: 'Someone',
    bookedByUserId: input.bookedByUserId ?? null,
    readyDate: '2026-09-24',
    targetDate: '2026-10-01',
    serviceLevel: 'standard',
    expectedAreaM2: 120,
    recoveredWeightKg: null,
    bagCount: 4,
    totalIncGst: mongoose.Types.Decimal128.fromString('245.52'),
    completedAt: null,
    arrivedAt: null,
    runId: null,
    driverName: null,
    notes: '',
    riskAssessmentRequired: input.riskAssessmentRequired ?? false,
  });
  return insertedId;
}

async function user(input: {
  roles: string[];
  accountId: mongoose.Types.ObjectId | null;
  status?: string;
  name: string;
}): Promise<mongoose.Types.ObjectId> {
  const { insertedId } = await UserModel.collection.insertOne({
    name: input.name,
    email: null,
    role: input.roles[0],
    roles: input.roles,
    status: input.status ?? 'active',
    accountId: input.accountId,
  });
  return insertedId;
}

async function flagOf(id: mongoose.Types.ObjectId): Promise<boolean | undefined> {
  const row = await JobModel.collection.findOne({ _id: id });
  return row?.riskAssessmentRequired as boolean | undefined;
}

describe('the risk-assessment rule reaches open jobs only', () => {
  it('changes every open job on the account, including one a driver is on', async ({ skip }) => {
    if (!reachable) skip();

    const open = await Promise.all(OPEN_JOB_STATUSES.map((status) => job({ status })));

    const changed = await jobRepository.setRiskAssessmentOnOpenJobs(
      ACCOUNT.toHexString(),
      true,
      OPEN_JOB_STATUSES,
    );

    expect(changed.map((row) => row.id).sort()).toEqual(open.map((id) => id.toHexString()).sort());
    for (const id of open) expect(await flagOf(id)).toBe(true);
  });

  it('leaves finished jobs on the rule they were done under', async ({ skip }) => {
    if (!reachable) skip();

    const finished = await Promise.all(
      ['completed', 'admin-complete', 'futile', 'cancelled'].map((status) => job({ status })),
    );

    const changed = await jobRepository.setRiskAssessmentOnOpenJobs(
      ACCOUNT.toHexString(),
      true,
      OPEN_JOB_STATUSES,
    );

    expect(changed).toEqual([]);
    for (const id of finished) expect(await flagOf(id)).toBe(false);
  });

  it('never touches another account’s jobs', async ({ skip }) => {
    if (!reachable) skip();

    const theirs = await job({ status: 'arrived', accountId: OTHER_ACCOUNT });

    await jobRepository.setRiskAssessmentOnOpenJobs(ACCOUNT.toHexString(), true, OPEN_JOB_STATUSES);

    expect(await flagOf(theirs)).toBe(false);
  });

  it('reports only the jobs it changed, so a repeat is a no-op', async ({ skip }) => {
    if (!reachable) skip();

    await job({ status: 'assigned', riskAssessmentRequired: true });
    const stale = await job({ status: 'arrived', riskAssessmentRequired: false });

    const first = await jobRepository.setRiskAssessmentOnOpenJobs(
      ACCOUNT.toHexString(),
      true,
      OPEN_JOB_STATUSES,
    );
    const second = await jobRepository.setRiskAssessmentOnOpenJobs(
      ACCOUNT.toHexString(),
      true,
      OPEN_JOB_STATUSES,
    );

    expect(first.map((row) => row.id)).toEqual([stale.toHexString()]);
    expect(second).toEqual([]);
  });

  it('switches it off the same way', async ({ skip }) => {
    if (!reachable) skip();

    const id = await job({ status: 'booked', riskAssessmentRequired: true });

    await jobRepository.setRiskAssessmentOnOpenJobs(ACCOUNT.toHexString(), false, OPEN_JOB_STATUSES);

    expect(await flagOf(id)).toBe(false);
  });
});

describe('who is told about an office message on a pickup', () => {
  it('reaches the account’s administrators and the supervisor who booked it', async ({ skip }) => {
    if (!reachable) skip();

    const admin = await user({ name: 'Angela', roles: ['customer-administrator'], accountId: ACCOUNT });
    const booker = await user({ name: 'Dave', roles: ['customer-site-supervisor'], accountId: ACCOUNT });
    // Another supervisor on the same account cannot see Dave's pickup.
    await user({ name: 'Priya', roles: ['customer-site-supervisor'], accountId: ACCOUNT });
    // Suspended, another account, and staff: none of them are this pickup's audience.
    await user({
      name: 'Old admin',
      roles: ['customer-administrator'],
      accountId: ACCOUNT,
      status: 'suspended',
    });
    await user({ name: 'Other', roles: ['customer-administrator'], accountId: OTHER_ACCOUNT });
    await user({ name: 'Renee', roles: ['operations'], accountId: ACCOUNT });

    const audience = await notificationRepository.jobAudience(
      ACCOUNT.toHexString(),
      booker.toHexString(),
    );

    expect(audience.map((row) => row.id).sort()).toEqual(
      [admin.toHexString(), booker.toHexString()].sort(),
    );
  });

  it('reaches only the administrators on a pickup the office booked', async ({ skip }) => {
    if (!reachable) skip();

    const admin = await user({ name: 'Angela', roles: ['customer-administrator'], accountId: ACCOUNT });
    await user({ name: 'Dave', roles: ['customer-site-supervisor'], accountId: ACCOUNT });

    const audience = await notificationRepository.jobAudience(ACCOUNT.toHexString(), null);

    expect(audience.map((row) => row.id)).toEqual([admin.toHexString()]);
  });

  it('carries each person’s email, for the message that follows the bell', async ({ skip }) => {
    if (!reachable) skip();

    const admin = await user({ name: 'Angela', roles: ['customer-administrator'], accountId: ACCOUNT });
    await UserModel.collection.updateOne({ _id: admin }, { $set: { email: 'angela@iplasta.com.au' } });
    const booker = await user({ name: 'Dave', roles: ['customer-site-supervisor'], accountId: ACCOUNT });

    const audience = await notificationRepository.jobAudience(
      ACCOUNT.toHexString(),
      booker.toHexString(),
    );

    expect(Object.fromEntries(audience.map((row) => [row.name, row.email]))).toEqual({
      Angela: 'angela@iplasta.com.au',
      // Signs in by SMS — no address, so the bell is all they get.
      Dave: null,
    });
  });

  // Money goes to administrators only — a supervisor never sees a price (M1.5).
  it('keeps invoice notices to the administrators, even from the booker', async ({ skip }) => {
    if (!reachable) skip();

    const admin = await user({ name: 'Angela', roles: ['customer-administrator'], accountId: ACCOUNT });
    await user({ name: 'Dave', roles: ['customer-site-supervisor'], accountId: ACCOUNT });

    const administrators = await notificationRepository.accountAdministrators(ACCOUNT.toHexString());

    expect(administrators.map((row) => row.id)).toEqual([admin.toHexString()]);
  });

  it('does not reach a booker who has since moved to another account', async ({ skip }) => {
    if (!reachable) skip();

    const moved = await user({
      name: 'Dave',
      roles: ['customer-site-supervisor'],
      accountId: OTHER_ACCOUNT,
    });

    const audience = await notificationRepository.jobAudience(
      ACCOUNT.toHexString(),
      moved.toHexString(),
    );

    expect(audience).toEqual([]);
  });
});

describe('the portal thread', () => {
  it('carries both sides of the customer thread and nothing else', async ({ skip }) => {
    if (!reachable) skip();

    const viewer = new mongoose.Types.ObjectId();
    const colleague = new mongoose.Types.ObjectId();
    const office = new mongoose.Types.ObjectId();
    const id = await job({ status: 'arrived' });

    const at = (minute: number) => new Date(Date.UTC(2026, 8, 24, 1, minute));
    await JobCommentModel.create([
      { jobId: id, body: 'Booked for Thursday', author: 'Renee', authorId: office, at: at(1), visibility: 'customer' },
      { jobId: id, body: 'Thanks', author: 'Angela', authorId: viewer, at: at(2), visibility: 'customer', fromCustomer: true },
      { jobId: id, body: 'Board is stacked', author: 'Dave', authorId: colleague, at: at(3), visibility: 'customer', fromCustomer: true },
      { jobId: id, body: 'Chase the PO', author: 'Renee', authorId: office, at: at(4), visibility: 'internal' },
      { jobId: id, body: 'Gate code 4821', author: 'Renee', authorId: office, at: at(5), visibility: 'driver' },
    ]);

    const pickup = await portalRepository.findJob(
      id.toHexString(),
      { accountId: ACCOUNT.toHexString(), bookedByUserId: null },
      true,
      viewer.toHexString(),
    );

    expect(pickup?.messages.map((message) => message.body)).toEqual([
      'Booked for Thursday',
      'Thanks',
      'Board is stacked',
    ]);
    expect(pickup?.messages.map((message) => [message.fromCustomer, message.mine])).toEqual([
      [false, false],
      [true, true],
      [true, false],
    ]);
  });
});
