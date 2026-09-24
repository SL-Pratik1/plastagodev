import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JobChargeModel, JobModel } from '../src/domains/jobs/job.model.js';
import { FutileReviewModel } from '../src/domains/queues/futile-review.model.js';
import { queueRepository } from '../src/domains/queues/queue.repository.js';

/**
 * That the futile queue shows what the job was CHARGED, not what a futile costs
 * today.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * The fee is configurable (Settings → Pricing → Additional services), and
 * `raiseChargeOnce` resolves it once — when the driver marks the pickup futile —
 * then freezes it onto the job as a charge line. That frozen figure is what the
 * invoice copies and what the customer pays.
 *
 * The queue used to render the price list's CURRENT value on every row instead.
 * The two agree until somebody edits the fee, and then every historical row
 * silently restates itself: a pickup charged $120 last month read $150 in the
 * queue, beside a job and an invoice that both still said $120. Nothing was
 * mis-billed — but the screen the office decides on stopped matching the money,
 * which is how somebody talks a customer out of paying a charge that stands.
 *
 * ⚠️ The service suite cannot catch this. `queues.service.test.ts` fakes
 * `queueRepository` wholesale, so the join under test does not run there at all
 * — the same blind spot that hid the `amountExGst` bug in
 * `charge-approval.integration.test.ts`.
 */

const MONGO_URL = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const TEST_DB = 'plastago_futile_fee_test';

/** What the driver's pickup was actually charged, months ago. */
const CHARGED = '120.00';
/** What a futile costs today, after somebody repriced it. */
const REPRICED_FALLBACK = '150.00';

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
      JobChargeModel.deleteMany({}),
      FutileReviewModel.deleteMany({}),
      JobModel.deleteMany({}),
    ]);
  }
});

/**
 * A futile job, its review, and optionally the charge that was frozen onto it.
 *
 * ⚠️ The job goes in through the raw collection rather than the model. A `Job`
 * has dozens of required paths and this test asserts on one number; validating
 * the other forty would make it a test of the job schema, and it would break
 * every time an unrelated field became mandatory.
 */
async function seedFutile(options: {
  withCharge: boolean;
  /**
   * Where the charge is in approvals. Real futile charges start `pending` —
   * every driver-raised charge does — and the office may approve or reject it.
   */
  approvalState?: 'pending' | 'approved' | 'rejected';
}): Promise<string> {
  const jobId = new mongoose.Types.ObjectId();

  await JobModel.collection.insertOne({
    _id: jobId,
    jobNumber: 61_412,
    status: 'futile',
    brandId: 'plastago',
    accountId: new mongoose.Types.ObjectId(),
    accountName: 'Clarendon Homes',
    builderName: 'Clarendon Homes',
    siteName: 'Lot 214 (#46) Allambie Circuit',
    suburb: 'Oran Park',
    zoneId: new mongoose.Types.ObjectId(),
    driverId: null,
    driverName: 'Troy Holm',
    readyDate: '2026-09-18',
    expectedAreaM2: 823.41,
    onSiteMinutes: null,
  });

  if (options.withCharge) {
    await JobChargeModel.create({
      jobId,
      code: 'futile-pickup',
      description: 'Futile pickup',
      quantity: 1,
      unitRate: mongoose.Types.Decimal128.fromString(CHARGED),
      amount: mongoose.Types.Decimal128.fromString(CHARGED),
      source: 'driver',
      approvalState: options.approvalState ?? 'pending',
      raisedBy: 'Troy Holm',
      raisedAt: new Date(),
      photoCount: 2,
      note: 'Concrete truck across the driveway.',
    });
  }

  const review = await FutileReviewModel.create({
    jobId,
    reason: 'access-blocked',
    note: 'Concrete truck across the driveway.',
    markedAt: new Date(),
    outcome: 'pending',
  });

  return review._id.toHexString();
}

describe('the futile queue, against a real database', () => {
  it('lists the fee frozen on the job, not the repriced one', async ({ skip }) => {
    if (!reachable) skip();

    await seedFutile({ withCharge: true });

    const { data } = await queueRepository.futileList(
      { page: 1, pageSize: 20 },
      // Stands for the price list having been edited since. If this value comes
      // back, the row is reading settings instead of the job.
      REPRICED_FALLBACK,
    );

    expect(data).toHaveLength(1);
    expect(data[0]?.feeExGst).toBe(CHARGED);
  });

  it('shows the same figure on the detail screen as on the list', async ({ skip }) => {
    if (!reachable) skip();

    const reviewId = await seedFutile({ withCharge: true });

    const review = await queueRepository.futileGet(reviewId, REPRICED_FALLBACK);

    // Two screens the office decides on. Disagreeing about the amount is worse
    // than either of them being wrong on its own.
    expect(review?.feeExGst).toBe(CHARGED);
  });

  /*
   * A review whose charge line is missing — one opened before the charge
   * existed, or a job whose charges were cleared. Today's price beats a blank,
   * and it is what every row used to show.
   */
  it('falls back to the price list when the job carries no futile charge', async ({ skip }) => {
    if (!reachable) skip();

    await seedFutile({ withCharge: false });

    const { data } = await queueRepository.futileList({ page: 1, pageSize: 20 }, REPRICED_FALLBACK);

    expect(data[0]?.feeExGst).toBe(REPRICED_FALLBACK);
  });

  /*
   * The office can reject a futile fee in approvals — a goodwill waiver. The
   * queue went on showing $120 for it, beside a job and an invoice that charge
   * nothing; and hiding the charge instead would fall back to today's price.
   */
  it('shows a waived (rejected) fee as nothing charged', async ({ skip }) => {
    if (!reachable) skip();

    const reviewId = await seedFutile({ withCharge: true, approvalState: 'rejected' });

    const { data } = await queueRepository.futileList({ page: 1, pageSize: 20 }, REPRICED_FALLBACK);
    const review = await queueRepository.futileGet(reviewId, REPRICED_FALLBACK);

    expect(data[0]?.feeExGst).toBe('0.00');
    expect(review?.feeExGst).toBe('0.00');
  });

  it('shows an approved fee as charged', async ({ skip }) => {
    if (!reachable) skip();

    await seedFutile({ withCharge: true, approvalState: 'approved' });

    const { data } = await queueRepository.futileList({ page: 1, pageSize: 20 }, REPRICED_FALLBACK);

    expect(data[0]?.feeExGst).toBe(CHARGED);
  });

  /*
   * A futile job carries other charges too — the service fee and the area were
   * quoted onto it at booking. Matching on `jobId` alone would pick whichever
   * came back first and report the service fee as the futile fee.
   */
  it('ignores the job’s other charges', async ({ skip }) => {
    if (!reachable) skip();

    const reviewId = await seedFutile({ withCharge: true });
    const review = await queueRepository.futileGet(reviewId, REPRICED_FALLBACK);

    const jobId = review?.jobId;
    expect(jobId).toBeDefined();

    await JobChargeModel.create({
      jobId: new mongoose.Types.ObjectId(jobId),
      code: 'service-fee',
      description: 'Service fee — Sydney',
      quantity: 1,
      unitRate: mongoose.Types.Decimal128.fromString('220.00'),
      amount: mongoose.Types.Decimal128.fromString('220.00'),
      source: 'system',
      approvalState: 'not-required',
      raisedBy: null,
      raisedAt: new Date(),
      photoCount: 0,
      note: null,
    });

    const { data } = await queueRepository.futileList({ page: 1, pageSize: 20 }, REPRICED_FALLBACK);

    expect(data[0]?.feeExGst).toBe(CHARGED);
  });
});
