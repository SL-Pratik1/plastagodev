import { evidencePurposeForCharge, photoPurpose, type ChargeCode } from '@plastago/shared';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountModel } from '../src/domains/accounts/account.model.js';
import { ContaminationReportModel } from '../src/domains/driver/contamination-report.model.js';
import { driverRepository } from '../src/domains/driver/driver.repository.js';
import { invoiceRepository } from '../src/domains/invoices/invoice.repository.js';
import { InvoiceLineModel, InvoiceModel } from '../src/domains/invoices/invoice.model.js';
import { JobChargeModel, JobModel, JobPhotoModel } from '../src/domains/jobs/job.model.js';
import { FutileReviewModel } from '../src/domains/queues/futile-review.model.js';
import {
  photoPurposeExpressions,
  queueRepository,
} from '../src/domains/queues/queue.repository.js';

/**
 * The exception reports' evidence, the approvals grid's filters and the
 * billing writes — against a real database.
 *
 * ── Why these need Mongo ──────────────────────────────────────────────────
 * Every rule here lives in a QUERY: an aggregation expression that must agree
 * with its JS twin, a filter the approvals grid used to drop, a status filter
 * that stops a sent invoice being rewritten, a unique index that makes "one
 * contamination report per job" hold when two replays land at once. The
 * service suites fake these repositories, and a fake accepts any filter it is
 * handed — the blind spot `charge-approval.integration.test.ts` describes.
 */

const MONGO_URL = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const TEST_DB = 'plastago_exception_evidence_test';

let reachable = false;

beforeAll(async () => {
  try {
    await mongoose.connect(MONGO_URL, { dbName: TEST_DB, serverSelectionTimeoutMS: 2000 });
    // The one-report-per-job rule IS this index; build it before anything races it.
    await ContaminationReportModel.init();
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
  await Promise.all([
    AccountModel.deleteMany({}),
    JobModel.deleteMany({}),
    JobChargeModel.deleteMany({}),
    JobPhotoModel.deleteMany({}),
    FutileReviewModel.deleteMany({}),
    ContaminationReportModel.deleteMany({}),
    InvoiceModel.deleteMany({}),
    InvoiceLineModel.deleteMany({}),
  ]);
});

const DRIVER_A = new mongoose.Types.ObjectId();
const DRIVER_B = new mongoose.Types.ObjectId();

async function seedAccount(poPolicy: 'required-before-invoice' | 'not-required') {
  const _id = new mongoose.Types.ObjectId();
  // `code` is unique, so each seeded account needs its own.
  await AccountModel.collection.insertOne({
    _id,
    code: `T${_id.toHexString().slice(-6)}`,
    name: `Builder ${poPolicy}`,
    poPolicy,
  });
  return _id;
}

async function seedJob(input: {
  accountId: mongoose.Types.ObjectId;
  jobNumber: number;
  status: string;
  driverId?: mongoose.Types.ObjectId;
}) {
  const _id = new mongoose.Types.ObjectId();
  await JobModel.collection.insertOne({
    _id,
    jobNumber: input.jobNumber,
    status: input.status,
    brandId: 'plastago',
    accountId: input.accountId,
    accountName: 'Clarendon Homes',
    builderName: 'Clarendon Homes',
    siteName: `Lot ${String(input.jobNumber)}`,
    suburb: 'Oran Park',
    zoneId: new mongoose.Types.ObjectId(),
    driverId: input.driverId ?? DRIVER_A,
    driverName: 'Troy Holm',
    readyDate: '2026-09-18',
    expectedAreaM2: 500,
    onSiteMinutes: null,
  });
  return _id;
}

async function seedCharge(input: {
  jobId: mongoose.Types.ObjectId;
  code: ChargeCode;
  amount: string;
  source?: 'driver' | 'office' | 'system';
  approvalState?: 'pending' | 'approved' | 'rejected';
  raisedAt?: Date;
  note?: string | null;
}) {
  const charge = await JobChargeModel.create({
    jobId: input.jobId,
    code: input.code,
    description: input.code,
    quantity: 1,
    unitRate: mongoose.Types.Decimal128.fromString(input.amount),
    amount: mongoose.Types.Decimal128.fromString(input.amount),
    source: input.source ?? 'driver',
    approvalState: input.approvalState ?? 'pending',
    raisedBy: 'Troy Holm',
    raisedAt: input.raisedAt ?? new Date(),
    photoCount: 0,
    note: input.note ?? null,
  });
  return charge._id;
}

async function seedPhoto(jobId: mongoose.Types.ObjectId, slot: string | null, caption: string) {
  await JobPhotoModel.create({ jobId, slot, caption, takenAt: new Date() });
}

/* ── The rule, spelled twice ──────────────────────────────────────────────── */

describe('which report a photo belongs to', () => {
  /*
   * ⚠️ The same rule, spelled once in JS and once as an aggregation. If these
   * drift, the phone shows one set of evidence and the office counts another.
   */
  it('is decided the same way by the pipeline and by the phone', async ({ skip }) => {
    if (!reachable) skip();

    const jobId = new mongoose.Types.ObjectId();
    const cases = [
      { slot: 'front-of-site', caption: 'Front of site' },
      { slot: null, caption: 'Extra photo' },
      { slot: 'futile', caption: 'Could not collect — evidence' },
      { slot: 'contamination', caption: 'Contamination — evidence' },
      // Taken before the slot tag existed: the caption is all there is.
      { slot: null, caption: 'Could not collect — evidence' },
      { slot: null, caption: 'Contamination — evidence' },
      // A tagged photo is what its tag says, whatever its caption.
      { slot: 'futile', caption: 'Extra photo' },
      // A real slot beats a legacy caption.
      { slot: 'pile-before', caption: 'Contamination — evidence' },
    ];

    for (const photo of cases) await seedPhoto(jobId, photo.slot, photo.caption);
    // Older than the field itself: no `slot` path at all.
    await JobPhotoModel.collection.insertOne({
      jobId,
      caption: 'Could not collect — evidence',
      takenAt: new Date(),
    });

    const rows = await JobPhotoModel.aggregate<{
      slot?: string | null;
      caption: string;
      purpose: string;
    }>([
      { $match: { jobId } },
      {
        $project: {
          slot: 1,
          caption: 1,
          purpose: photoPurposeExpressions.PHOTO_PURPOSE_EXPR,
        },
      },
    ]);

    expect(rows).toHaveLength(cases.length + 1);
    for (const row of rows) {
      expect(row.purpose, `${String(row.slot)} / ${row.caption}`).toBe(photoPurpose(row));
    }
  });

  it('picks a charge’s evidence the same way in both places', async ({ skip }) => {
    if (!reachable) skip();

    // Any one document, to run the expressions against.
    await seedPhoto(new mongoose.Types.ObjectId(), null, 'Extra photo');

    const codes = [
      'contamination',
      'futile-pickup',
      'extra-bags',
      'extra-load-time',
      'service-fee',
    ];
    const [row] = await JobPhotoModel.aggregate<Record<string, string>>([
      { $limit: 1 },
      {
        $project: Object.fromEntries(
          codes.map((code) => [code, photoPurposeExpressions.chargeEvidencePurposeExpr(code)]),
        ),
      },
    ]);

    for (const code of codes) expect(row?.[code], code).toBe(evidencePurposeForCharge(code));
  });
});

/* ── The approvals grid ──────────────────────────────────────────────────── */

describe('the approvals grid, against a real database', () => {
  async function seedQueue() {
    const poAccount = await seedAccount('required-before-invoice');
    const freeAccount = await seedAccount('not-required');

    const finished = await seedJob({
      accountId: poAccount,
      jobNumber: 61_501,
      status: 'completed',
    });
    const underWay = await seedJob({
      accountId: freeAccount,
      jobNumber: 61_502,
      status: 'arrived',
      driverId: DRIVER_B,
    });

    // The checklist shots and one contamination photo on the finished job.
    await seedPhoto(finished, 'front-of-site', 'Front of site');
    await seedPhoto(finished, 'pile-before', 'Pile before');
    await seedPhoto(finished, 'contamination', 'Contamination — evidence');

    const contamination = await seedCharge({
      jobId: finished,
      code: 'contamination',
      amount: '90.00',
    });
    const extraBags = await seedCharge({ jobId: underWay, code: 'extra-bags', amount: '60.00' });
    const old = await seedCharge({
      jobId: underWay,
      code: 'extra-load-time',
      amount: '45.00',
      raisedAt: new Date(Date.now() - 40 * 86_400_000),
    });

    return { contamination, extraBags, old };
  }

  const page = { page: 1, pageSize: 20 };
  const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id).sort();

  /*
   * ⚠️ REGRESSION. The row counted every photo on the job, so a contamination
   * charge read "3 photos" off the five-shot checklist — two of which show
   * nothing about the contamination.
   */
  it('counts each charge’s own evidence, not every photo on the job', async ({ skip }) => {
    if (!reachable) skip();
    const seeded = await seedQueue();

    const { data } = await queueRepository.approvalList(page);
    const byId = new Map(data.map((row) => [row.id, row]));

    expect(byId.get(seeded.contamination.toHexString())?.photoCount).toBe(1);
    expect(byId.get(seeded.extraBags.toHexString())?.photoCount).toBe(0);
    expect(byId.get(seeded.contamination.toHexString())?.jobFinished).toBe(true);
    expect(byId.get(seeded.extraBags.toHexString())?.jobFinished).toBe(false);
  });

  /* Every one of these used to be stripped by the query schema and ignored. */
  it('applies every filter the grid offers', async ({ skip }) => {
    if (!reachable) skip();
    const seeded = await seedQueue();

    expect(
      ids((await queueRepository.approvalList({ ...page, code: 'contamination' })).data),
    ).toEqual([seeded.contamination.toHexString()]);
    expect(ids((await queueRepository.approvalList({ ...page, po: 'required' })).data)).toEqual([
      seeded.contamination.toHexString(),
    ]);
    expect(ids((await queueRepository.approvalList({ ...page, po: 'not-required' })).data)).toEqual(
      ids([{ id: seeded.extraBags.toHexString() }, { id: seeded.old.toHexString() }]),
    );
    expect(
      ids((await queueRepository.approvalList({ ...page, driver: DRIVER_B.toHexString() })).data),
    ).toEqual(ids([{ id: seeded.extraBags.toHexString() }, { id: seeded.old.toHexString() }]));
    expect(
      ids((await queueRepository.approvalList({ ...page, evidence: 'with-photos' })).data),
    ).toEqual([seeded.contamination.toHexString()]);
    expect(
      (await queueRepository.approvalList({ ...page, evidence: 'no-photos' })).meta.total,
    ).toBe(2);
    expect(ids((await queueRepository.approvalList({ ...page, age: 'over-month' })).data)).toEqual([
      seeded.old.toHexString(),
    ]);
  });

  it('sorts by the column the office clicked', async ({ skip }) => {
    if (!reachable) skip();
    await seedQueue();

    const { data } = await queueRepository.approvalList({ ...page, sort: '-amountExGst' });

    expect(data.map((row) => row.amountExGst)).toEqual(['90.00', '60.00', '45.00']);
  });

  it('shows the contamination photo, and only it, when deciding the charge', async ({ skip }) => {
    if (!reachable) skip();
    const seeded = await seedQueue();

    const detail = await queueRepository.approvalGet(seeded.contamination.toHexString());

    expect(detail?.photos.map((photo) => photo.caption)).toEqual(['Contamination — evidence']);
  });
});

/* ── The futile review ───────────────────────────────────────────────────── */

describe('the futile review, against a real database', () => {
  it('shows what stopped the pickup, not the rest of the job', async ({ skip }) => {
    if (!reachable) skip();

    const account = await seedAccount('not-required');
    const jobId = await seedJob({ accountId: account, jobNumber: 61_601, status: 'futile' });
    await seedPhoto(jobId, 'front-of-site', 'Front of site');
    await seedPhoto(jobId, 'futile', 'Could not collect — evidence');
    // From before the tag existed — still the futile evidence.
    await seedPhoto(jobId, null, 'Could not collect — evidence');

    const review = await FutileReviewModel.create({
      jobId,
      reason: 'access-blocked',
      note: 'Gate padlocked',
      markedAt: new Date(),
      outcome: 'pending',
    });

    const detail = await queueRepository.futileGet(review._id.toHexString(), '120.00');
    const list = await queueRepository.futileList({ page: 1, pageSize: 20 }, '120.00');

    expect(detail?.photos).toHaveLength(2);
    expect(detail?.photos.every((photo) => photo.caption === 'Could not collect — evidence')).toBe(
      true,
    );
    expect(list.data[0]?.photoCount).toBe(2);
  });
});

/* ── One contamination report per job ────────────────────────────────────── */

describe('the contamination report, against a real database', () => {
  const report = (type: 'timber' | 'metal') => ({
    type,
    extent: 'heavy' as const,
    note: null,
    reportedAt: new Date('2026-09-24T01:00:00.000Z'),
    reportedByUserId: DRIVER_A.toHexString(),
    reportedByName: 'Troy Holm',
    latitude: null,
    longitude: null,
  });

  /*
   * ⚠️ Two replays of one queued report landing together. The unique index is
   * the rule; without it both would win and the job would carry two reports.
   */
  it('lets exactly one of two simultaneous reports win', async ({ skip }) => {
    if (!reachable) skip();
    const jobId = new mongoose.Types.ObjectId().toHexString();

    const results = await Promise.all([
      driverRepository.recordContaminationReport({ jobId, ...report('timber') }),
      driverRepository.recordContaminationReport({ jobId, ...report('metal') }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await ContaminationReportModel.countDocuments({})).toBe(1);
  });

  it('reads a report made before the record existed from its charge', async ({ skip }) => {
    if (!reachable) skip();
    const account = await seedAccount('not-required');
    const jobId = await seedJob({ accountId: account, jobNumber: 61_701, status: 'arrived' });
    await seedCharge({
      jobId,
      code: 'contamination',
      amount: '90.00',
      raisedAt: new Date('2026-09-23T15:57:43.000Z'),
      note: 'timber · heavy — Offcuts right through',
    });

    const found = await driverRepository.findContaminationReport(jobId.toHexString());

    expect(found).toMatchObject({ legacy: true, type: 'timber', extent: 'heavy' });
    expect(found?.reportedAt.toISOString()).toBe('2026-09-23T15:57:43.000Z');
  });
});

/* ── The billing writes ──────────────────────────────────────────────────── */

describe('rewriting an invoice, against a real database', () => {
  async function seedInvoice(status: 'draft' | 'awaiting-po' | 'sent') {
    return invoiceRepository.create({
      invoiceNumber: 104_000 + Math.floor(Math.random() * 1_000_000),
      kind: 'base',
      status,
      accountId: new mongoose.Types.ObjectId().toHexString(),
      accountName: 'Acacia Living',
      brandId: 'plastago',
      jobId: new mongoose.Types.ObjectId().toHexString(),
      jobNumber: 61_305,
      poNumber: 'PTEST-24SEP-02',
      issuedOn: '2026-09-24',
      dueOn: '2026-10-01',
      paymentTermsDays: 7,
      subtotalExGst: '930.00',
      gst: '93.00',
      totalIncGst: '1023.00',
      templateName: 'Standard',
      notes: '',
      lines: [
        {
          description: 'Service fee — Wollongong',
          quantity: 1,
          unitRate: '500.00',
          amount: '500.00',
          raisedBy: null,
          sourceChargeId: new mongoose.Types.ObjectId().toHexString(),
        },
      ],
    });
  }

  const FEE_ONLY = {
    subtotalExGst: '120.00',
    gst: '12.00',
    totalIncGst: '132.00',
    lines: [
      {
        description: 'Futile pickup',
        quantity: 1,
        unitRate: '120.00',
        amount: '120.00',
        raisedBy: 'Troy Holm',
        sourceChargeId: new mongoose.Types.ObjectId().toHexString(),
      },
    ],
  };

  it('rewrites an unsent invoice’s lines and totals', async ({ skip }) => {
    if (!reachable) skip();
    const invoice = await seedInvoice('draft');

    const updated = await invoiceRepository.replaceLines(invoice.id, FEE_ONLY);
    const [row] = await invoiceRepository.forJob(invoice.jobId ?? '');

    expect(updated?.subtotalExGst).toBe('120.00');
    expect(row?.lines).toEqual([
      expect.objectContaining({ description: 'Futile pickup', amount: '120.00' }),
    ]);
  });

  /* A sent invoice is a document a builder is holding. It must never change. */
  it('never rewrites or removes one that has gone out', async ({ skip }) => {
    if (!reachable) skip();
    const invoice = await seedInvoice('sent');

    expect(await invoiceRepository.replaceLines(invoice.id, FEE_ONLY)).toBeNull();
    expect(await invoiceRepository.deleteUnsent(invoice.id)).toBe(false);

    const [row] = await invoiceRepository.forJob(invoice.jobId ?? '');
    expect(row?.lines[0]?.description).toBe('Service fee — Wollongong');
  });

  it('removes an unsent invoice and its lines together', async ({ skip }) => {
    if (!reachable) skip();
    const invoice = await seedInvoice('awaiting-po');

    expect(await invoiceRepository.deleteUnsent(invoice.id)).toBe(true);
    expect(await InvoiceModel.countDocuments({})).toBe(0);
    expect(await InvoiceLineModel.countDocuments({})).toBe(0);
  });
});
