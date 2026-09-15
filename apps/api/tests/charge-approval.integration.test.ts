import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JobChargeModel } from '../src/domains/jobs/job.model.js';
import { queueRepository } from '../src/domains/queues/queue.repository.js';

/**
 * That approving a charge actually works, and leaves a trail.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * `decideCharges` projected `amountExGst`. The schema field is `amount`. Mongo
 * returned nothing for the name it was asked for, and the `.toString()` in the
 * return mapping threw — AFTER `updateMany` had already moved the charge. So the
 * office pressed Approve on a $160 contamination charge, was shown "Something
 * went wrong", pressed it again, and got "None of those charges could be
 * decided". The money was live the whole time and nothing on screen said so.
 *
 * The service suite could not catch it: it fakes `queueRepository`, and a mock
 * accepts any field name you hand it. That is the same shape of bug, and the
 * same blind spot, as the tip-off write in
 * `driver.tipoff-persistence.integration.test.ts`.
 *
 * Two further rules are pinned here because both were broken in the same
 * function: the driver's note is theirs and the office must not write over it,
 * and a money decision has to record who made it.
 */

describe('the charge decision matches its schema', () => {
  /* Pure introspection, so it runs with no database — on a laptop and in CI. */
  it('defines every path the decision reads and writes', () => {
    const schema = JobChargeModel.schema;

    for (const path of [
      'amount',
      'approvalState',
      'note',
      'decidedBy',
      'decidedAt',
      'decisionNote',
    ]) {
      expect(schema.path(path), `JobCharge is missing "${path}"`).toBeDefined();
    }
  });

  /*
   * `amountExGst` is the WIRE name — `ChargeApprovalItem` carries it. A schema
   * that also answered to it would mean the two spellings had been reconciled in
   * the wrong direction, which is exactly how the original bug hid.
   */
  it('does not answer to the wire name for the amount', () => {
    expect(JobChargeModel.schema.path('amountExGst')).toBeUndefined();
  });
});

const MONGO_URL = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const TEST_DB = 'plastago_charge_approval_test';

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

const DRIVER_NOTE = 'Timber right through the second bag.';

async function seedPending(): Promise<string> {
  const charge = await JobChargeModel.create({
    jobId: new mongoose.Types.ObjectId(),
    code: 'contamination',
    description: 'Contamination — timber offcuts',
    quantity: 1,
    unitRate: mongoose.Types.Decimal128.fromString('160.19'),
    amount: mongoose.Types.Decimal128.fromString('160.19'),
    source: 'driver',
    approvalState: 'pending',
    raisedBy: 'Troy Holm',
    raisedAt: new Date(),
    photoCount: 6,
    note: DRIVER_NOTE,
  });

  return charge._id.toHexString();
}

beforeEach(async () => {
  if (reachable) await JobChargeModel.deleteMany({});
});

describe('decideCharges, against a real database', () => {
  it('returns the amount it decided, rather than throwing on it', async ({ skip }) => {
    if (!reachable) skip();

    const id = await seedPending();

    const result = await queueRepository.decideCharges({
      ids: [id],
      to: 'approved',
      note: null,
      decidedBy: 'Priya Raman',
    });

    expect(result.changed).toBe(1);
    // The throw was here. A decided charge must come back with its money, because
    // the caller reports "$160.19 became billable" from exactly this.
    expect(result.decided[0]?.amountExGst).toBe('160.19');
  });

  it('records who decided it and when', async ({ skip }) => {
    if (!reachable) skip();

    const id = await seedPending();
    await queueRepository.decideCharges({
      ids: [id],
      to: 'approved',
      note: null,
      decidedBy: 'Priya Raman',
    });

    const row = await JobChargeModel.findById(id).lean<{
      approvalState: string;
      decidedBy: string | null;
      decidedAt: Date | null;
    }>();

    expect(row?.approvalState).toBe('approved');
    expect(row?.decidedBy).toBe('Priya Raman');
    expect(row?.decidedAt).toBeInstanceOf(Date);
  });

  it("keeps the driver's note and files the office's reason separately", async ({ skip }) => {
    if (!reachable) skip();

    const id = await seedPending();
    await queueRepository.decideCharges({
      ids: [id],
      to: 'rejected',
      note: 'Photos show clean board.',
      decidedBy: 'Priya Raman',
    });

    const row = await JobChargeModel.findById(id).lean<{
      note: string | null;
      decisionNote: string | null;
    }>();

    // The customer disputes the charge, not the decision — so the first-hand
    // account of what was in the load is the one thing that must survive.
    expect(row?.note).toBe(DRIVER_NOTE);
    expect(row?.decisionNote).toBe('Photos show clean board.');
  });

  it('decides only what is still pending, so two people cannot both win', async ({ skip }) => {
    if (!reachable) skip();

    const id = await seedPending();
    await queueRepository.decideCharges({ ids: [id], to: 'approved', note: null, decidedBy: 'A' });
    const second = await queueRepository.decideCharges({
      ids: [id],
      to: 'rejected',
      note: 'Too late',
      decidedBy: 'B',
    });

    expect(second.changed).toBe(0);

    const row = await JobChargeModel.findById(id).lean<{
      approvalState: string;
      decidedBy: string | null;
    }>();

    expect(row?.approvalState).toBe('approved');
    expect(row?.decidedBy).toBe('A');
  });
});
