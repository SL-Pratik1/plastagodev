import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JobChargeModel, JobModel } from '../src/domains/jobs/job.model.js';
import { reportRepository } from '../src/domains/reports/report.repository.js';

/**
 * The zone report's revenue must come from the CHARGES on a job, not from the
 * quote frozen on the job when it was booked.
 *
 * ⚠️ `byZone` used to `$sum: '$totalExGst'`. That field is the price agreed at
 * booking; every charge raised afterwards — contamination, extra bags, extra
 * load time, the futile fee — is a `jobcharges` row and never touches it. So the
 * Zones tab reported less revenue than the Volume and Financial tabs on the same
 * screen, for the same period, while jobs and m² matched exactly. That is the
 * worst shape a reconciliation error can take: everything looks right except the
 * money, so the number gets believed.
 *
 * This test exists at the repository level on purpose. The service-level suite
 * mocks this repository, so it could not have caught it — the defect was in the
 * aggregation itself.
 */
const MONGO_URL = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const TEST_DB = 'plastago_zone_revenue_test';

const ACCOUNT = new mongoose.Types.ObjectId();
const FILTERS = { from: '2026-07-01', to: '2026-07-31' } as Parameters<
  typeof reportRepository.byZone
>[0];

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
  if (!reachable) return;
  await JobModel.deleteMany({});
  await JobChargeModel.deleteMany({});
});

/** A completed Sydney job whose booked quote is deliberately LESS than its charges. */
async function seedJob() {
  const jobId = new mongoose.Types.ObjectId();

  await JobModel.collection.insertOne({
    _id: jobId,
    jobNumber: 90001,
    accountId: ACCOUNT,
    accountName: 'QA Account',
    brandId: 'plastago',
    siteName: 'Lot 1 Example Rise',
    addressLine: '1 Example Rise',
    suburb: 'Box Hill',
    postcode: '2765',
    zone: 'sydney',
    status: 'completed',
    completedAt: new Date('2026-07-15T04:00:00.000Z'),
    readyDate: '2026-07-14',
    targetDate: '2026-07-21',
    serviceLevel: 'standard',
    freightItem: 'plasterboard-bagged',
    expectedAreaM2: 100,
    bagCount: 0,
    inductionRequired: false,
    craneAvailable: false,
    riskAssessmentRequired: false,
    // The quote frozen at booking. The contamination charge below came later.
    totalExGst: mongoose.Types.Decimal128.fromString('220.00'),
    gst: mongoose.Types.Decimal128.fromString('22.00'),
    totalIncGst: mongoose.Types.Decimal128.fromString('242.00'),
    createdAt: new Date('2026-07-10T00:00:00.000Z'),
    updatedAt: new Date('2026-07-15T04:00:00.000Z'),
  });

  const charge = (code: string, amount: string, source: string, approvalState: string) => ({
    _id: new mongoose.Types.ObjectId(),
    jobId,
    code,
    description: code,
    quantity: 1,
    unitRate: mongoose.Types.Decimal128.fromString(amount),
    amount: mongoose.Types.Decimal128.fromString(amount),
    source,
    approvalState,
    raisedAt: new Date('2026-07-15T04:00:00.000Z'),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await JobChargeModel.collection.insertMany([
    charge('service-fee', '220.00', 'system', 'not-required'),
    // Raised on site, approved afterwards — invisible to `job.totalExGst`.
    charge('contamination', '90.00', 'driver', 'approved'),
    // Rejected work is not revenue and must not be counted.
    charge('extra-load-time', '55.00', 'driver', 'rejected'),
  ]);
}

describe('zone revenue', () => {
  it('counts charges raised after booking, not just the booked quote', async ({ skip }) => {
    if (!reachable) skip();
    await seedJob();

    const rows = await reportRepository.byZone(FILTERS);
    const sydney = rows.find((row) => row.zone === 'sydney');

    // 220.00 service fee + 90.00 contamination = 310.00, NOT the 220.00 quote.
    expect(sydney?.revenueCents).toBe(31_000);
    expect(sydney?.jobs).toBe(1);
    expect(sydney?.areaM2).toBe(100);
  });

  it('agrees with the financial report for the same period', async ({ skip }) => {
    if (!reachable) skip();
    await seedJob();

    const zones = await reportRepository.byZone(FILTERS);
    const financial = await reportRepository.financial(FILTERS, 'zone');

    const zoneTotal = zones.reduce((total, row) => total + row.revenueCents, 0);
    const financialTotal = financial.reduce(
      (total, row) => total + row.baseRevenueCents + row.additionalCents,
      0,
    );

    expect(zoneTotal).toBe(financialTotal);
  });
});
