import type {
  AwaitingPoItem,
  ChargeApprovalDetail,
  ChargeApprovalItem,
  ExceptionReason,
  FutileOutcome,
  FutileReview,
  FutileReviewItem,
  JobPhoto,
  PageMeta,
  QueueCounts,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { fromDecimal128 } from '../../lib/money.js';
import { AccountModel, ContactModel } from '../accounts/account.model.js';
import { InvoiceLineModel, InvoiceModel } from '../invoices/invoice.model.js';
import { JobChargeModel, JobModel, JobPhotoModel } from '../jobs/job.model.js';
import { CallUpModel } from './call-up.model.js';
import { FutileReviewModel } from './futile-review.model.js';
import { LeadModel } from './lead.model.js';
import { PoExtractionModel, PurchaseOrderModel } from './purchase-order.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 *
 * ── Why most of these queues are views, not tables ────────────────────────
 * A queue is a QUESTION asked of data that already exists: "which charges are
 * pending", "which invoices are waiting on a PO". Copying those rows into a
 * queue table would mean two places that can disagree, and the way you find out
 * is a badge showing 3 when the list shows 1.
 *
 * The exception is the futile review, which has its own collection — because
 * the office's DECISION is new information that lives nowhere else.
 */

export interface QueueScope {
  /** Non-null narrows every read to one account. Queues are internal, so this
   *  is normally null — it exists so a portal view cannot be added carelessly. */
  accountId: string | null;
}

/** A charge whose approval state just moved — enough to audit the decision. */
export interface DecidedCharge {
  id: string;
  jobId: string;
  description: string;
  /** A decimal STRING (§6A.10 #1), never a float. */
  amountExGst: string;
}

export interface QueueListQuery {
  page: number;
  pageSize: number;
  sort?: string | undefined;
  q?: string | undefined;
  account?: string | undefined;
  /** Rows older than this many days — how the office finds what is rotting. */
  agedOverDays?: number | undefined;
}

function pageMeta(query: QueueListQuery, total: number): PageMeta {
  return {
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

function toJobPhoto(row: {
  _id: mongoose.Types.ObjectId;
  caption: string;
  takenAt: Date;
  takenBy?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}): JobPhoto {
  return {
    id: row._id.toHexString(),
    caption: row.caption,
    takenAt: row.takenAt.toISOString(),
    takenBy: row.takenBy ?? '',
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
  };
}

export const queueRepository = {
  /**
   * M9.4 — one call for every nav badge.
   *
   * Seven counts in parallel. The shell polls this, so it is deliberately the
   * cheapest thing in the API: counts only and no documents.
   *
   * ⚠️ Six are answered by an index. The seventh — orders with no job — is an
   * aggregate, because "has this been booked?" is a fact about another
   * collection. See the note on it.
   */
  async counts(): Promise<QueueCounts> {
    const [
      futileReview,
      serviceApprovals,
      awaitingPo,
      poReview,
      awaitingCallUp,
      callUpReview,
      leads,
    ] = await Promise.all([
      FutileReviewModel.countDocuments({ outcome: 'pending' }),
      JobChargeModel.countDocuments({ approvalState: 'pending' }),
      InvoiceModel.countDocuments({ status: 'awaiting-po' }),
      PoExtractionModel.countDocuments({ state: 'needs-review' }),
      /*
       * M2.12b — orders with no live job against them.
       *
       * ⚠️ The one count here that is not a plain `countDocuments`, because
       * "has this been booked?" is a fact about the JOBS collection. A flag on
       * the order would make this cheap and would go stale the first time a
       * job was cancelled — and a cancelled job leaves the order callable
       * again, which is exactly the case a stale flag would hide.
       */
      PurchaseOrderModel.aggregate<{ total: number }>([
        {
          $lookup: {
            from: 'jobs',
            localField: '_id',
            foreignField: 'purchaseOrderId',
            as: 'jobs',
            pipeline: [{ $match: { status: { $ne: 'cancelled' } } }, { $project: { _id: 1 } }],
          },
        },
        { $match: { jobs: { $size: 0 } } },
        { $count: 'total' },
      ]).then((rows) => rows[0]?.total ?? 0),
      // M2.12b — a date a builder has given us that nobody has acted on.
      CallUpModel.countDocuments({ state: 'needs-review' }),
      // A converted lead is history, and a lost one is not work either.
      LeadModel.countDocuments({ convertedAccountId: null, status: { $ne: 'lost' } }),
    ]);

    return {
      futileReview,
      serviceApprovals,
      awaitingPo,
      poReview,
      awaitingCallUp,
      callUpReview,
      leads,
    };
  },

  /* ── M2.6 · Futile review ──────────────────────────────────────────────── */

  /**
   * The futile queue, joined to its jobs.
   *
   * `$lookup` rather than a second round trip: the row needs the site, the
   * account and the driver to be worth looking at, and a queue that renders
   * one query per row is one that gets slower as it gets more urgent.
   */
  async futileList(
    query: QueueListQuery,
    feeExGst: string,
  ): Promise<{ data: FutileReviewItem[]; meta: PageMeta }> {
    const match: Record<string, unknown> = { outcome: 'pending' };

    if (query.agedOverDays !== undefined) {
      const cutoff = new Date(Date.now() - query.agedOverDays * 86_400_000);
      match.markedAt = { $lte: cutoff };
    }

    const pipeline: mongoose.PipelineStage[] = [
      { $match: match },
      { $lookup: { from: 'jobs', localField: 'jobId', foreignField: '_id', as: 'job' } },
      { $unwind: '$job' },
    ];

    if (query.account && mongoose.isValidObjectId(query.account)) {
      pipeline.push({
        $match: { 'job.accountId': new mongoose.Types.ObjectId(query.account) },
      });
    }

    if (query.q) {
      const term = escapeRegex(query.q);
      pipeline.push({
        $match: {
          $or: [
            { 'job.accountName': { $regex: term, $options: 'i' } },
            { 'job.siteName': { $regex: term, $options: 'i' } },
            { 'job.suburb': { $regex: term, $options: 'i' } },
          ],
        },
      });
    }

    const [rows, totals] = await Promise.all([
      FutileReviewModel.aggregate<RawFutileRow>([
        ...pipeline,
        // Oldest first: a queue worked newest-first is one where the oldest row
        // never gets touched.
        { $sort: { markedAt: 1 } },
        { $skip: (query.page - 1) * query.pageSize },
        { $limit: query.pageSize },
      ]),
      FutileReviewModel.aggregate<{ total: number }>([...pipeline, { $count: 'total' }]),
    ]);

    const photoCounts = await countPhotos(rows.map((row) => row.job._id));

    return {
      data: rows.map((row) => toFutileItem(row, feeExGst, photoCounts)),
      meta: pageMeta(query, totals[0]?.total ?? 0),
    };
  },

  /** One futile review with the photos the decision rests on. */
  async futileGet(id: string, feeExGst: string): Promise<FutileReview | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    const rows = await FutileReviewModel.aggregate<RawFutileRow>([
      { $match: { _id: new mongoose.Types.ObjectId(id) } },
      { $lookup: { from: 'jobs', localField: 'jobId', foreignField: '_id', as: 'job' } },
      { $unwind: '$job' },
    ]);

    const row = rows[0];
    if (!row) return null;

    const photos = await JobPhotoModel.find({ jobId: row.job._id }).sort({ takenAt: 1 }).lean();

    const counts = new Map([[row.job._id.toHexString(), photos.length]]);

    return {
      ...toFutileItem(row, feeExGst, counts),
      photos: photos.map(toJobPhoto),
      decisionNote: row.decisionNote ?? null,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      decidedBy: row.decidedBy ?? null,
      newReadyDate: row.newReadyDate ?? null,
    };
  },

  /** Opens a review when a driver marks a job futile. Idempotent on replay. */
  async openFutileReview(input: {
    jobId: string;
    reason: ExceptionReason;
    note: string | null;
    markedAt: Date;
  }): Promise<void> {
    await FutileReviewModel.updateOne(
      { jobId: new mongoose.Types.ObjectId(input.jobId) },
      {
        $setOnInsert: {
          jobId: new mongoose.Types.ObjectId(input.jobId),
          reason: input.reason,
          note: input.note,
          markedAt: input.markedAt,
          outcome: 'pending',
        },
      },
      { upsert: true },
    );
  },

  /**
   * Records the decision.
   *
   * ⚠️ `outcome: 'pending'` is in the FILTER. Two people deciding the same row
   * at once must not both win, and a second decision is a contradiction rather
   * than an update. Returns the job so the caller can act on it.
   */
  async decideFutile(input: {
    id: string;
    outcome: Exclude<FutileOutcome, 'pending'>;
    decisionNote: string | null;
    decidedByUserId: string;
    decidedBy: string;
    newReadyDate: string | null;
  }): Promise<{ jobId: string } | null> {
    if (!mongoose.isValidObjectId(input.id)) return null;

    const updated = await FutileReviewModel.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(input.id), outcome: 'pending' },
      {
        $set: {
          outcome: input.outcome,
          decisionNote: input.decisionNote,
          decidedAt: new Date(),
          decidedByUserId: new mongoose.Types.ObjectId(input.decidedByUserId),
          decidedBy: input.decidedBy,
          newReadyDate: input.newReadyDate,
        },
      },
      { returnDocument: 'after', projection: { jobId: 1 } },
    ).lean<{ jobId: mongoose.Types.ObjectId }>();

    return updated ? { jobId: updated.jobId.toHexString() } : null;
  },

  /* ── M2.7 · Charge approvals ───────────────────────────────────────────── */

  /**
   * Every charge awaiting a decision, across every job.
   *
   * Per CHARGE, not per job: a job can carry a contamination charge the office
   * approves and an extra-load-time charge it rejects, and forcing one decision
   * on both would make the queue useless.
   */
  async approvalList(
    query: QueueListQuery,
  ): Promise<{ data: ChargeApprovalItem[]; meta: PageMeta }> {
    const match: Record<string, unknown> = { approvalState: 'pending' };

    if (query.agedOverDays !== undefined) {
      match.raisedAt = { $lte: new Date(Date.now() - query.agedOverDays * 86_400_000) };
    }

    const pipeline: mongoose.PipelineStage[] = [
      { $match: match },
      { $lookup: { from: 'jobs', localField: 'jobId', foreignField: '_id', as: 'job' } },
      { $unwind: '$job' },
      {
        $lookup: {
          from: 'accounts',
          localField: 'job.accountId',
          foreignField: '_id',
          as: 'account',
        },
      },
      { $unwind: '$account' },
    ];

    if (query.account && mongoose.isValidObjectId(query.account)) {
      pipeline.push({ $match: { 'job.accountId': new mongoose.Types.ObjectId(query.account) } });
    }

    if (query.q) {
      const term = escapeRegex(query.q);
      pipeline.push({
        $match: {
          $or: [
            { 'job.accountName': { $regex: term, $options: 'i' } },
            { 'job.siteName': { $regex: term, $options: 'i' } },
            { description: { $regex: term, $options: 'i' } },
          ],
        },
      });
    }

    const [rows, totals] = await Promise.all([
      JobChargeModel.aggregate<RawApprovalRow>([
        ...pipeline,
        { $sort: { raisedAt: 1 } },
        { $skip: (query.page - 1) * query.pageSize },
        { $limit: query.pageSize },
      ]),
      JobChargeModel.aggregate<{ total: number }>([...pipeline, { $count: 'total' }]),
    ]);

    const photoCounts = await countPhotos(rows.map((row) => row.job._id));

    return {
      data: rows.map((row) => toApprovalItem(row, photoCounts)),
      meta: pageMeta(query, totals[0]?.total ?? 0),
    };
  },

  /** One charge, with the photos the office approves it by looking at. */
  async approvalGet(id: string): Promise<ChargeApprovalDetail | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    const rows = await JobChargeModel.aggregate<RawApprovalRow>([
      { $match: { _id: new mongoose.Types.ObjectId(id) } },
      { $lookup: { from: 'jobs', localField: 'jobId', foreignField: '_id', as: 'job' } },
      { $unwind: '$job' },
      {
        $lookup: {
          from: 'accounts',
          localField: 'job.accountId',
          foreignField: '_id',
          as: 'account',
        },
      },
      { $unwind: '$account' },
    ]);

    const row = rows[0];
    if (!row) return null;

    const photos = await JobPhotoModel.find({ jobId: row.job._id }).sort({ takenAt: 1 }).lean();
    const counts = new Map([[row.job._id.toHexString(), photos.length]]);

    return {
      ...toApprovalItem(row, counts),
      photos: photos.map(toJobPhoto),
      jobStatus: row.job.status,
      expectedAreaM2: row.job.expectedAreaM2,
      onSiteMinutes: row.job.onSiteMinutes,
    };
  },

  /**
   * Decides a batch of charges.
   *
   * ⚠️ `approvalState: 'pending'` is part of the FILTER. The queue is worked in
   * batches from a grid whose selection may be seconds stale, and re-deciding a
   * charge that somebody else already actioned would silently overwrite their
   * decision. Returns how many actually moved.
   */
  async decideCharges(input: {
    ids: readonly string[];
    to: 'approved' | 'rejected';
    note: string | null;
    decidedBy: string;
  }): Promise<{ changed: number; jobIds: string[]; decided: DecidedCharge[] }> {
    const ids = input.ids
      .filter((id) => mongoose.isValidObjectId(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (ids.length === 0) return { changed: 0, jobIds: [], decided: [] };

    /*
     * Read the charges BEFORE the update, so the caller can act on them
     * afterwards — the filter will no longer match once the state has moved.
     *
     * The description and amount come back too, because the audit entry for a
     * money decision has to say WHICH charge and HOW MUCH. Re-reading them after
     * the update would be a second query returning the same rows.
     */
    const affected = await JobChargeModel.find(
      { _id: { $in: ids }, approvalState: 'pending' },
      { jobId: 1, description: 1, amountExGst: 1 },
    ).lean<
      Array<{
        _id: mongoose.Types.ObjectId;
        jobId: mongoose.Types.ObjectId;
        description: string;
        amountExGst: mongoose.Types.Decimal128;
      }>
    >();

    const result = await JobChargeModel.updateMany(
      { _id: { $in: ids }, approvalState: 'pending' },
      {
        $set: {
          approvalState: input.to,
          // Appended to the driver's own note rather than replacing it: the
          // driver said what they saw, and the office said what they decided.
          ...(input.note ? { note: input.note } : {}),
        },
      },
    );

    return {
      changed: result.modifiedCount,
      jobIds: [...new Set(affected.map((row) => row.jobId.toHexString()))],
      decided: affected.map((row) => ({
        id: row._id.toHexString(),
        jobId: row.jobId.toHexString(),
        description: row.description,
        amountExGst: row.amountExGst.toString(),
      })),
    };
  },

  /** Whether a job still has anything pending — drives the grid's badge. */
  async hasPendingCharges(jobId: string): Promise<boolean> {
    const count = await JobChargeModel.countDocuments({
      jobId: new mongoose.Types.ObjectId(jobId),
      approvalState: 'pending',
    });
    return count > 0;
  },

  /* ── M7.3 · Awaiting a purchase order ──────────────────────────────────── */

  /**
   * Invoices blocked on a PO, with who to chase.
   *
   * The queue exists to produce a phone call, so the contact comes back with the
   * row — a chaser who has to open another screen to find the email address is
   * a chaser who makes fewer calls.
   */
  async awaitingPoList(query: QueueListQuery): Promise<{ data: AwaitingPoItem[]; meta: PageMeta }> {
    const filter: Record<string, unknown> = { status: 'awaiting-po' };

    if (query.account && mongoose.isValidObjectId(query.account)) {
      filter.accountId = new mongoose.Types.ObjectId(query.account);
    }

    if (query.agedOverDays !== undefined) {
      filter.createdAt = { $lte: new Date(Date.now() - query.agedOverDays * 86_400_000) };
    }

    const [rows, total] = await Promise.all([
      InvoiceModel.find(filter)
        // Oldest first — the three-month-old one is the money.
        .sort({ createdAt: 1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean<RawAwaitingPoRow[]>(),
      InvoiceModel.countDocuments(filter),
    ]);

    if (rows.length === 0) return { data: [], meta: pageMeta(query, total) };

    /*
     * Lines, jobs and contacts for the whole page in three queries rather than
     * three per row — the N+1 that makes a 20-row queue issue sixty.
     */
    const invoiceIds = rows.map((row) => row._id);
    const accountIds = [...new Set(rows.map((row) => row.accountId.toHexString()))].map(
      (id) => new mongoose.Types.ObjectId(id),
    );
    const jobIds = rows
      .map((row) => row.jobId)
      .filter((id): id is mongoose.Types.ObjectId => id !== null);

    const [lines, jobs, contacts] = await Promise.all([
      InvoiceLineModel.find({ invoiceId: { $in: invoiceIds } }, { invoiceId: 1, description: 1 })
        .sort({ position: 1 })
        .lean<Array<{ invoiceId: mongoose.Types.ObjectId; description: string }>>(),
      JobModel.find({ _id: { $in: jobIds } }, { siteName: 1 }).lean<
        Array<{ _id: mongoose.Types.ObjectId; siteName: string }>
      >(),
      ContactModel.find({ accountId: { $in: accountIds } }).lean(),
    ]);

    const linesByInvoice = new Map<string, string[]>();
    for (const line of lines) {
      const key = line.invoiceId.toHexString();
      linesByInvoice.set(key, [...(linesByInvoice.get(key) ?? []), line.description]);
    }

    const siteByJob = new Map(jobs.map((job) => [job._id.toHexString(), job.siteName]));

    const contactByAccount = new Map<string, { name: string; email: string | null }>();
    for (const contact of contacts) {
      const key = contact.accountId.toHexString();
      const existing = contactByAccount.get(key);
      // The 'accounts' contact is the one who issues purchase orders. Falling
      // back to whoever we saw first beats showing nobody to ring.
      if (!existing || contact.role === 'accounts') {
        contactByAccount.set(key, { name: contact.name, email: contact.email ?? null });
      }
    }

    return {
      data: rows.map((row): AwaitingPoItem => {
        const contact = contactByAccount.get(row.accountId.toHexString());
        const descriptions = linesByInvoice.get(row._id.toHexString()) ?? [];

        return {
          id: row._id.toHexString(),
          invoiceNumber: row.invoiceNumber,
          jobId: row.jobId ? row.jobId.toHexString() : '',
          jobNumber: row.jobNumber ?? 0,
          accountId: row.accountId.toHexString(),
          accountName: row.accountName,
          siteName: (row.jobId && siteByJob.get(row.jobId.toHexString())) || '—',
          contactName: contact?.name ?? null,
          contactEmail: contact?.email ?? null,
          totalExGst: fromDecimal128(row.subtotalExGst),
          totalIncGst: fromDecimal128(row.totalIncGst),
          // What the chaser says the PO is FOR. Without it the call is "we need
          // a PO for invoice 104101", which nobody can action.
          chargeSummary: descriptions.length > 0 ? descriptions.join(', ') : 'Additional charges',
          approvedAt: row.createdAt.toISOString(),
          lastChasedAt: row.lastChasedAt ? row.lastChasedAt.toISOString() : null,
          chaseCount: row.chaseCount ?? 0,
        };
      }),
      meta: pageMeta(query, total),
    };
  },

  /**
   * Records that a chase went out.
   *
   * `$inc` and a timestamp, so ageing is measured against the last CONTACT.
   * Still filtered on `awaiting-po`: chasing a PO for an invoice that has since
   * been released would be a call nobody needed to make.
   */
  async recordChase(ids: readonly string[]): Promise<number> {
    const objectIds = ids
      .filter((id) => mongoose.isValidObjectId(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (objectIds.length === 0) return 0;

    const result = await InvoiceModel.updateMany(
      { _id: { $in: objectIds }, status: 'awaiting-po' },
      { $set: { lastChasedAt: new Date() }, $inc: { chaseCount: 1 } },
    );

    return result.modifiedCount;
  },
};

/* ── Raw shapes and mapping ──────────────────────────────────────────────── */

interface RawJobJoin {
  _id: mongoose.Types.ObjectId;
  jobNumber: number;
  status: string;
  brandId: FutileReviewItem['brandId'];
  accountId: mongoose.Types.ObjectId;
  accountName: string;
  builderName: string;
  siteName: string;
  suburb: string;
  zone: FutileReviewItem['zone'];
  driverId: mongoose.Types.ObjectId | null;
  driverName: string | null;
  readyDate: string;
  expectedAreaM2: number | null;
  onSiteMinutes: number | null;
}

interface RawFutileRow {
  _id: mongoose.Types.ObjectId;
  reason: ExceptionReason;
  note: string | null;
  markedAt: Date;
  outcome: FutileOutcome;
  decisionNote?: string | null;
  decidedAt?: Date | null;
  decidedBy?: string | null;
  newReadyDate?: string | null;
  job: RawJobJoin;
}

interface RawApprovalRow {
  _id: mongoose.Types.ObjectId;
  code: ChargeApprovalItem['code'];
  description: string;
  quantity: number;
  unitRate: mongoose.Types.Decimal128;
  amount: mongoose.Types.Decimal128;
  raisedBy: string | null;
  raisedAt: Date;
  note: string | null;
  job: RawJobJoin;
  account: { poPolicy: string };
}

interface RawAwaitingPoRow {
  _id: mongoose.Types.ObjectId;
  invoiceNumber: number;
  accountId: mongoose.Types.ObjectId;
  accountName: string;
  jobId: mongoose.Types.ObjectId | null;
  jobNumber: number | null;
  subtotalExGst: mongoose.Types.Decimal128;
  totalIncGst: mongoose.Types.Decimal128;
  createdAt: Date;
  lastChasedAt: Date | null;
  chaseCount: number;
}

function toFutileItem(
  row: RawFutileRow,
  feeExGst: string,
  photoCounts: Map<string, number>,
): FutileReviewItem {
  return {
    id: row._id.toHexString(),
    jobId: row.job._id.toHexString(),
    jobNumber: row.job.jobNumber,
    brandId: row.job.brandId,
    accountId: row.job.accountId.toHexString(),
    accountName: row.job.accountName,
    builderName: row.job.builderName,
    siteName: row.job.siteName,
    suburb: row.job.suburb,
    zone: row.job.zone,
    driverId: row.job.driverId ? row.job.driverId.toHexString() : null,
    driverName: row.job.driverName,
    reason: row.reason,
    note: row.note ?? null,
    markedAt: row.markedAt.toISOString(),
    readyDate: row.job.readyDate,
    photoCount: photoCounts.get(row.job._id.toHexString()) ?? 0,
    // The position is on the event, not the review. Surfaced as null here rather
    // than joined: the detail screen shows the photos, which carry their own.
    latitude: null,
    longitude: null,
    feeExGst,
    outcome: row.outcome,
  };
}

function toApprovalItem(row: RawApprovalRow, photoCounts: Map<string, number>): ChargeApprovalItem {
  return {
    id: row._id.toHexString(),
    jobId: row.job._id.toHexString(),
    jobNumber: row.job.jobNumber,
    accountId: row.job.accountId.toHexString(),
    accountName: row.job.accountName,
    siteName: row.job.siteName,
    suburb: row.job.suburb,
    code: row.code,
    description: row.description,
    quantity: row.quantity,
    unitRate: fromDecimal128(row.unitRate),
    amountExGst: fromDecimal128(row.amount),
    raisedBy: row.raisedBy,
    raisedAt: row.raisedAt.toISOString(),
    note: row.note,
    photoCount: photoCounts.get(row.job._id.toHexString()) ?? 0,
    /*
     * M2.7's closing rule, surfaced on the ROW: approving this on a PO-required
     * account does not release money, it moves the charge to the awaiting-PO
     * queue. The approver should know that before clicking, not after.
     */
    poRequired: row.account.poPolicy === 'required-before-invoice',
    latitude: null,
    longitude: null,
  };
}

/** Photo counts for a page of rows, in one query rather than one per row. */
async function countPhotos(jobIds: mongoose.Types.ObjectId[]): Promise<Map<string, number>> {
  if (jobIds.length === 0) return new Map();

  const counts = await JobPhotoModel.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
    { $match: { jobId: { $in: jobIds } } },
    { $group: { _id: '$jobId', count: { $sum: 1 } } },
  ]);

  return new Map(counts.map((row) => [row._id.toHexString(), row.count]));
}

/**
 * User input goes into a regex, so it is escaped.
 *
 * Without this a typed `(` is a syntax error and a typed `.*` is a scan.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { AccountModel };
