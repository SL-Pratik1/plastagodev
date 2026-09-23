import type {
  AwaitingCallUp,
  CallUp,
  CallUpKind,
  CallUpReviewReason,
  CallUpSource,
  CallUpState,
  PageMeta,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { JobModel } from '../jobs/job.model.js';
import { CallUpModel } from './call-up.model.js';
import { PurchaseOrderModel } from './purchase-order.model.js';

/**
 * Reads and writes for call-ups (M2.12b).
 *
 * ── The one rule this file exists to enforce ──────────────────────────────
 * A call-up is recorded BEFORE anything is decided about it. Every write here
 * either stores what arrived or stamps an outcome onto a row that already
 * exists; none of them applies a booking. That work is the service's, and
 * keeping it out of here is what makes an unmatched call-up a queue item rather
 * than a lost email.
 */

interface RawCallUp {
  _id: mongoose.Types.ObjectId;
  purchaseOrderId: mongoose.Types.ObjectId | null;
  poNumber: string;
  accountId: mongoose.Types.ObjectId | null;
  accountName: string | null;
  receivedAt: Date;
  source: CallUpSource;
  kind: CallUpKind;
  readyDate: string | null;
  previousReadyDate: string | null;
  state: CallUpState;
  reason: CallUpReviewReason | null;
  jobId: mongoose.Types.ObjectId | null;
  jobNumber: number | null;
  note: string;
  resolvedAt: Date | null;
  resolvedBy: string | null;
}

function toCallUp(row: RawCallUp): CallUp {
  return {
    id: row._id.toHexString(),
    purchaseOrderId: row.purchaseOrderId ? row.purchaseOrderId.toHexString() : null,
    poNumber: row.poNumber,
    accountId: row.accountId ? row.accountId.toHexString() : null,
    accountName: row.accountName ?? null,
    receivedAt: row.receivedAt.toISOString(),
    source: row.source,
    kind: row.kind,
    readyDate: row.readyDate ?? null,
    previousReadyDate: row.previousReadyDate ?? null,
    state: row.state,
    reason: row.reason ?? null,
    jobId: row.jobId ? row.jobId.toHexString() : null,
    jobNumber: row.jobNumber ?? null,
    note: row.note ?? '',
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolvedBy: row.resolvedBy ?? null,
  };
}

/** The order a call-up refers to, with just enough to book a job from it. */
export interface MatchedOrder {
  id: string;
  poNumber: string;
  accountId: string;
  accountName: string;
  lotNumber: string | null;
  addressLine: string | null;
  suburb: string | null;
  siteSupervisorName: string | null;
  /**
   * ⚠️ Carried because the JOB needs it, not because this queue shows it.
   *
   * The order captured a supervisor mobile at PO review and `book()` then
   * hard-coded the job’s `siteContactMobile` to an empty string — so every job
   * booked from a call-up reached the driver with a name and no number, and
   * the driver app fell back to "No site contact on this job — ring the
   * office". The number was sitting on the order the whole time.
   */
  siteSupervisorMobile: string | null;
  siteSupervisorUserId: string | null;
  /** The job already booked against it, if any. */
  jobId: string | null;
  jobNumber: number | null;
  jobStatus: string | null;
  jobReadyDate: string | null;
}

export const callUpRepository = {
  /**
   * Stores what arrived, whatever it turned out to mean.
   *
   * ⚠️ Returns the existing row on a duplicate external id rather than throwing.
   * The vendor retries a webhook on any non-2xx, so "I have already seen this
   * email" is the normal second call, not an error — and answering it with a
   * 500 makes the vendor retry again, forever.
   */
  async record(input: {
    purchaseOrderId: string | null;
    poNumber: string;
    accountId: string | null;
    accountName: string | null;
    receivedAt: Date;
    source: CallUpSource;
    kind: CallUpKind;
    readyDate: string | null;
    previousReadyDate: string | null;
    state: CallUpState;
    reason: CallUpReviewReason | null;
    jobId: string | null;
    jobNumber: number | null;
    note: string;
    externalId: string | null;
    raisedBy: string | null;
  }): Promise<{ id: string; alreadySeen: boolean }> {
    if (input.externalId) {
      const existing = await CallUpModel.findOne({ externalId: input.externalId }).lean<{
        _id: mongoose.Types.ObjectId;
      }>();
      if (existing) return { id: existing._id.toHexString(), alreadySeen: true };
    }

    const created = await CallUpModel.create({
      purchaseOrderId: input.purchaseOrderId
        ? new mongoose.Types.ObjectId(input.purchaseOrderId)
        : null,
      poNumber: input.poNumber,
      accountId: input.accountId ? new mongoose.Types.ObjectId(input.accountId) : null,
      accountName: input.accountName,
      receivedAt: input.receivedAt,
      source: input.source,
      kind: input.kind,
      readyDate: input.readyDate,
      previousReadyDate: input.previousReadyDate,
      state: input.state,
      reason: input.reason,
      jobId: input.jobId ? new mongoose.Types.ObjectId(input.jobId) : null,
      jobNumber: input.jobNumber,
      note: input.note,
      /*
       * Omitted rather than stored as null — the unique index only covers rows
       * that actually carry a vendor id, and writing a null would put this row
       * back into it. See the note on the index.
       */
      ...(input.externalId ? { externalId: input.externalId } : {}),
      raisedBy: input.raisedBy,
    });

    return { id: created._id.toHexString(), alreadySeen: false };
  },

  /** Stamps the outcome onto a row once the service has acted. */
  async setOutcome(
    id: string,
    outcome: {
      state: CallUpState;
      reason: CallUpReviewReason | null;
      jobId: string | null;
      jobNumber: number | null;
      previousReadyDate?: string | null;
      resolvedBy: string | null;
    },
  ): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;

    const result = await CallUpModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      {
        $set: {
          state: outcome.state,
          reason: outcome.reason,
          jobId: outcome.jobId ? new mongoose.Types.ObjectId(outcome.jobId) : null,
          jobNumber: outcome.jobNumber,
          ...(outcome.previousReadyDate === undefined
            ? {}
            : { previousReadyDate: outcome.previousReadyDate }),
          resolvedAt: outcome.state === 'applied' ? new Date() : null,
          resolvedBy: outcome.resolvedBy,
        },
      },
    );

    return result.matchedCount === 1;
  },

  /**
   * Appends what a reviewer said, keeping what the email said.
   *
   * The original note is the extractor's account of the message; a reviewer's is
   * why it was set aside. Overwriting the first with the second would lose the
   * only record of what actually arrived.
   */
  async appendNote(id: string, note: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(id) || note === '') return false;

    const row = await CallUpModel.findById(id, { note: 1 }).lean<{ note: string }>();
    if (!row) return false;

    const combined = row.note.trim() === '' ? note : `${row.note} · ${note}`;

    const result = await CallUpModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { note: combined.slice(0, 1000) } },
    );

    return result.matchedCount === 1;
  },

  async findById(id: string): Promise<CallUp | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const row = await CallUpModel.findById(id).lean<RawCallUp>();
    return row ? toCallUp(row) : null;
  },

  /** The office queue. Oldest first: a call-up is about a date that is coming. */
  async list(query: {
    state?: CallUpState;
    q?: string | undefined;
    page: number;
    pageSize: number;
  }): Promise<{ data: CallUp[]; meta: PageMeta }> {
    const filter: Record<string, unknown> = {};
    if (query.state) filter.state = query.state;

    /*
     * ⚠️ The screen has always had a search box and nothing read the term.
     *
     * What the office types here is a PO number — this queue is worked from a
     * builder ringing up about one order. The account name and the note are
     * included because the note is where the extractor put the email subject,
     * which is often the only thing that names the site.
     */
    if (query.q) {
      const like = { $regex: escapeRegex(query.q), $options: 'i' };
      filter.$or = [{ poNumber: like }, { accountName: like }, { note: like }];
    }

    const [rows, total] = await Promise.all([
      CallUpModel.find(filter)
        .sort({ receivedAt: 1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean<RawCallUp[]>(),
      CallUpModel.countDocuments(filter),
    ]);

    return {
      data: rows.map(toCallUp),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  },

  async countNeedingReview(): Promise<number> {
    return CallUpModel.countDocuments({ state: 'needs-review' });
  },

  /**
   * The order a call-up names, with whatever job already exists against it.
   *
   * ── Why the job comes back too ────────────────────────────────────────────
   * Because which action is legal depends on it: a new booking for an order
   * that already has a job is a duplicate, and a reschedule for one that has
   * none is premature. Fetching both in one place keeps that decision out of
   * two round trips and out of a race.
   *
   * ⚠️ Matched on the PO number ALONE, deliberately. The account is not part of
   * the key: a call-up email often names only the order number and the address,
   * and requiring the account would fail to match the very emails this exists
   * to read. The number is unique per account, so a collision across accounts
   * is possible in principle — \`findMatches\` returns every hit so the caller can
   * refuse to guess rather than picking one.
   */
  async findMatches(poNumber: string): Promise<MatchedOrder[]> {
    const trimmed = poNumber.trim();
    if (trimmed === '') return [];

    const orders = await PurchaseOrderModel.find({ poNumber: trimmed }).lean<
      Array<{
        _id: mongoose.Types.ObjectId;
        poNumber: string;
        accountId: mongoose.Types.ObjectId;
        accountName: string;
        lotNumber: string | null;
        addressLine: string | null;
        suburb: string | null;
        siteSupervisorName: string | null;
        siteSupervisorMobile: string | null;
        siteSupervisorUserId: mongoose.Types.ObjectId | null;
      }>
    >();

    if (orders.length === 0) return [];

    const jobs = await JobModel.find(
      { purchaseOrderId: { $in: orders.map((order) => order._id) } },
      { purchaseOrderId: 1, jobNumber: 1, status: 1, readyDate: 1 },
    ).lean<
      Array<{
        _id: mongoose.Types.ObjectId;
        purchaseOrderId: mongoose.Types.ObjectId;
        jobNumber: number;
        status: string;
        readyDate: string;
      }>
    >();

    const byOrder = new Map(jobs.map((job) => [job.purchaseOrderId.toHexString(), job]));

    return orders.map((order) => {
      const job = byOrder.get(order._id.toHexString());

      return {
        id: order._id.toHexString(),
        poNumber: order.poNumber,
        accountId: order.accountId.toHexString(),
        accountName: order.accountName,
        lotNumber: order.lotNumber ?? null,
        addressLine: order.addressLine ?? null,
        suburb: order.suburb ?? null,
        siteSupervisorName: order.siteSupervisorName ?? null,
        siteSupervisorMobile: order.siteSupervisorMobile ?? null,
        siteSupervisorUserId: order.siteSupervisorUserId
          ? order.siteSupervisorUserId.toHexString()
          : null,
        jobId: job ? job._id.toHexString() : null,
        jobNumber: job ? job.jobNumber : null,
        jobStatus: job ? job.status : null,
        jobReadyDate: job ? job.readyDate : null,
      };
    });
  },

  /** One order by id, for a call-up raised against a specific order. */
  async findOrder(purchaseOrderId: string): Promise<MatchedOrder | null> {
    if (!mongoose.isValidObjectId(purchaseOrderId)) return null;

    const order = await PurchaseOrderModel.findById(purchaseOrderId).lean<{
      poNumber: string;
    } | null>();
    if (!order) return null;

    const matches = await this.findMatches(order.poNumber);
    return matches.find((match) => match.id === purchaseOrderId) ?? null;
  },

  /**
   * Confirmed orders with no job against them — Matt's *"sitting there
   * waiting"* (21:30).
   *
   * ⚠️ A left join, not a flag on the order. "Has this been booked?" is
   * answered by whether a job points at it, and a duplicated boolean would go
   * stale the first time a job was cancelled.
   */
  async listAwaiting(query: {
    accountId?: string | null;
    q?: string | null;
    page: number;
    pageSize: number;
  }): Promise<{ data: Omit<AwaitingCallUp, 'serviceable'>[]; meta: PageMeta }> {
    const match: Record<string, unknown> = {};
    if (query.accountId) match.accountId = new mongoose.Types.ObjectId(query.accountId);

    /*
     * Anchored nowhere and case-insensitive, because a PO number is quoted in
     * fragments — "79904106" for an order printed "79904106/082". Escaped
     * because the input is a person's, and a stray `(` would otherwise throw a
     * regex error out of a search box.
     */
    const needle = query.q?.trim();
    if (needle) {
      const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      match.$or = [{ poNumber: pattern }, { accountName: pattern }];
    }

    const pipeline: mongoose.PipelineStage[] = [
      { $match: match },
      {
        $lookup: {
          from: 'jobs',
          localField: '_id',
          foreignField: 'purchaseOrderId',
          as: 'jobs',
          /*
           * A cancelled job leaves the order callable again — the builder can
           * re-book work they called off, and Matt's red notices are rare
           * enough that the order should not be stranded when one arrives.
           */
          pipeline: [{ $match: { status: { $ne: 'cancelled' } } }, { $project: { _id: 1 } }],
        },
      },
      { $match: { jobs: { $size: 0 } } },
      { $sort: { receivedAt: 1 } },
    ];

    const [rows, counted] = await Promise.all([
      PurchaseOrderModel.aggregate<{
        _id: mongoose.Types.ObjectId;
        poNumber: string;
        accountId: mongoose.Types.ObjectId;
        accountName: string;
        receivedAt: Date;
        lotNumber: string | null;
        addressLine: string | null;
        suburb: string | null;
        expectedAreaM2: number | null;
        bagAllowance: number | null;
        siteSupervisorName: string | null;
      }>([
        ...pipeline,
        { $skip: (query.page - 1) * query.pageSize },
        { $limit: query.pageSize },
      ]),
      PurchaseOrderModel.aggregate<{ total: number }>([...pipeline, { $count: 'total' }]),
    ]);

    const total = counted[0]?.total ?? 0;

    return {
      data: rows.map((row) => ({
        purchaseOrderId: row._id.toHexString(),
        poNumber: row.poNumber,
        accountId: row.accountId.toHexString(),
        accountName: row.accountName,
        receivedAt: row.receivedAt.toISOString(),
        lotNumber: row.lotNumber ?? null,
        addressLine: row.addressLine ?? null,
        suburb: row.suburb ?? null,
        expectedAreaM2: row.expectedAreaM2 ?? null,
        bagAllowance: row.bagAllowance ?? null,
        siteSupervisorName: row.siteSupervisorName ?? null,
      })),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  },
};

/** Local, as in `queue.repository` — an unescaped `(` from the search box
 *  would otherwise reach Mongo as an invalid expression and 500 the list. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
