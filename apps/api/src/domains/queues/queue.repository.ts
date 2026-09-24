import type { QueueAge } from './queue.schemas.js';
import {
  EVIDENCE_PHOTO_CAPTIONS,
  EVIDENCE_PHOTO_SLOTS,
  evidencePurposeForCharge,
  photoPurpose,
  type ChangeRequestItem,
  type AwaitingPoItem,
  type ChargeApprovalDetail,
  type ChargeApprovalItem,
  type ChargeApprovalState,
  type ExceptionReason,
  type FutileOutcome,
  type FutileReview,
  type FutileReviewItem,
  type PageMeta,
  type PhotoPurpose,
  type QueueCounts,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { UNKNOWN_ZONE_LABEL, zoneLabels } from '../settings/zone-lookup.js';
import { startOfToday } from '../../lib/business-day.js';
import { fromDecimal128 } from '../../lib/money.js';
import { AccountModel, ContactModel } from '../accounts/account.model.js';
import { InvoiceLineModel, InvoiceModel } from '../invoices/invoice.model.js';
import { toJobPhotoViews } from '../jobs/job-photo.view.js';
import {
  JOB_CHARGES_COLLECTION,
  JobChargeModel,
  JobModel,
  JobPhotoModel,
} from '../jobs/job.model.js';
/*
 * Read from the queues domain, written by the portal. The collection is the
 * seam between the two: the customer raises the request, the office works it.
 */
import { ChangeRequestModel } from '../portal/portal.model.js';
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

/**
 * The charge code a futile pickup raises (M2.6 · M6.5).
 *
 * Exported so the service's fallback price lookup and this file's join cannot
 * drift apart — they must name the same row in the price list or the queue
 * would fall back to the price of something else entirely.
 */
export const FUTILE_CHARGE_CODE = 'futile-pickup';

/**
 * Joins the `futile-pickup` charge this job actually carries.
 *
 * ── Why the queue may not read the price list ─────────────────────────────
 * The fee is configurable (Settings → Pricing → Additional services), and
 * `raiseChargeOnce` resolves it ONCE — at the moment the driver marks the
 * pickup futile — then freezes it onto the job as a charge line. That frozen
 * figure is what the invoice copies and what the customer pays.
 *
 * This queue used to render the price list's CURRENT value instead, on every
 * row. The two agree until somebody edits the fee, and then every historical
 * row silently restates itself: a review of a pickup charged $120 last month
 * reads $150 beside a job and an invoice that both still say $120. Nothing was
 * mis-billed, but the screen the office decides on stopped matching the money.
 *
 * ⚠️ The charge's `approvalState` comes back with it, and a REJECTED one reads
 * as $0.00. Every driver-raised charge starts `pending` — the futile fee
 * included — so it goes through the approvals queue, and the office can reject
 * it as a goodwill waiver. The lookup used to ignore the state, so a waived fee
 * went on showing $120 here beside a job and an invoice that charged nothing.
 * Not filtered out in the `$match`, because a missing charge falls back to
 * today's price (see `toFutileItem`) — that would put the $120 straight back.
 *
 * `raiseChargeOnce` refuses to raise a second one, so `futileCharge` holds at
 * most one element and there is nothing to disambiguate.
 */
const FUTILE_CHARGE_LOOKUP = {
  $lookup: {
    from: JOB_CHARGES_COLLECTION,
    localField: 'jobId',
    foreignField: 'jobId',
    as: 'futileCharge',
    pipeline: [
      { $match: { code: FUTILE_CHARGE_CODE } },
      { $project: { _id: 0, amount: 1, approvalState: 1 } },
    ],
  },
} satisfies mongoose.PipelineStage;

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

/**
 * The approvals queue's own query — everything a list takes, plus the decision.
 *
 * `'any'` means actioned and not, matching the futile queue's default label.
 * Omitted means `pending`, which is what the queue is for.
 */
export interface ApprovalListQuery extends QueueListQuery {
  approvalState?: 'pending' | 'approved' | 'rejected' | 'any' | undefined;
  code?: ChargeApprovalItem['code'] | undefined;
  driver?: string | undefined;
  po?: 'required' | 'not-required' | undefined;
  evidence?: 'with-photos' | 'no-photos' | undefined;
  age?: QueueAge | undefined;
}

/** The awaiting-PO queue's query — the shared one plus its own facets. */
export interface AwaitingPoListQuery extends QueueListQuery {
  chased?: 'yes' | 'no' | undefined;
  age?: QueueAge | undefined;
}

/** A job is finished — and billable — once it is completed, closed by the office, or futile. */
const FINISHED_JOB_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'admin-complete',
  'futile',
]);

/**
 * `photoPurpose` (in `@plastago/shared`) as an aggregation expression, over a
 * `jobphotos` document.
 *
 * ⚠️ Two spellings of ONE rule — the JS one for photos already in hand, this
 * one for counting and filtering inside a pipeline, where the evidence filter
 * has to run before the page is cut. They are held to each other by
 * `photo-purpose.integration.test.ts`; change one and that test says so.
 */
const PHOTO_PURPOSE_EXPR = {
  $switch: {
    branches: [
      { case: { $eq: ['$slot', EVIDENCE_PHOTO_SLOTS.futile] }, then: 'futile' },
      { case: { $eq: ['$slot', EVIDENCE_PHOTO_SLOTS.contamination] }, then: 'contamination' },
      {
        case: {
          $and: [
            { $eq: [{ $ifNull: ['$slot', null] }, null] },
            { $eq: ['$caption', EVIDENCE_PHOTO_CAPTIONS.futile] },
          ],
        },
        then: 'futile',
      },
      {
        case: {
          $and: [
            { $eq: [{ $ifNull: ['$slot', null] }, null] },
            { $eq: ['$caption', EVIDENCE_PHOTO_CAPTIONS.contamination] },
          ],
        },
        then: 'contamination',
      },
    ],
    default: 'job',
  },
} as const;

/** `evidencePurposeForCharge` as an expression over a charge code. Same pairing as above. */
function chargeEvidencePurposeExpr(code: string): Record<string, unknown> {
  return {
    $switch: {
      branches: [
        { case: { $eq: [code, 'contamination'] }, then: 'contamination' },
        { case: { $eq: [code, FUTILE_CHARGE_CODE] }, then: 'futile' },
      ],
      default: 'job',
    },
  };
}

/** Exported for the test that holds the two spellings of the rule together. */
export const photoPurposeExpressions = { PHOTO_PURPOSE_EXPR, chargeEvidencePurposeExpr };

export interface QueueListQuery {
  page: number;
  pageSize: number;
  sort?: string | undefined;
  q?: string | undefined;
  account?: string | undefined;
  /** Rows older than this many days — how the office finds what is rotting. */
  agedOverDays?: number | undefined;
}

/** The futile queue's query — the shared one plus its own facets. */
export interface FutileListQuery extends QueueListQuery {
  outcome?: 'pending' | 'rescheduled' | 'cancelled' | 'any' | undefined;
  reason?: ExceptionReason | undefined;
  driver?: string | undefined;
  zoneId?: string | undefined;
  age?: QueueAge | undefined;
}

/**
 * The "Waiting" filter, as a `markedAt` bound.
 *
 * ⚠️ Today is the SYDNEY day, not a UTC one. A review marked at 9am Sydney is
 * the previous date in UTC for most of the working day, so a UTC midnight would
 * drop the morning's rows out of "Today" — on a queue whose whole point is what
 * came in today.
 */
function ageWindow(age: QueueAge | undefined): Record<string, Date> {
  if (age === undefined) return {};

  const now = Date.now();
  const week = new Date(now - 7 * 86_400_000);

  switch (age) {
    case 'today':
      return { $gte: startOfToday() };
    case 'this-week':
      return { $gte: week };
    case 'over-week':
      return { $lte: week };
    case 'over-month':
      return { $lte: new Date(now - 30 * 86_400_000) };
  }
}

function pageMeta(query: QueueListQuery, total: number): PageMeta {
  return {
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

/*
 * Photo rows are mapped by `toJobPhotoViews` (../jobs/job-photo.view.ts), which
 * signs a read URL for each one. This file used to carry its own copy that
 * dropped the storage key, so both decision screens showed the office a caption
 * and a grey box on charges they were about to make billable.
 */

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
    query: FutileListQuery,
    feeExGst: string,
  ): Promise<{ data: FutileReviewItem[]; meta: PageMeta }> {
    /*
     * Pending unless asked otherwise. This used to be hardcoded, so the
     * "Decision" filter could be set to Rescheduled and the grid would answer
     * with the pending rows anyway — the office could never see what had been
     * decided, on the one screen that decides it.
     */
    const match: Record<string, unknown> = {};
    const outcome = query.outcome ?? 'pending';
    if (outcome !== 'any') match.outcome = outcome;

    if (query.reason !== undefined) match.reason = query.reason;

    /*
     * Age. `agedOverDays` stays supported because other callers pass it, but
     * the filter bar speaks in windows — and two of them have a near edge that
     * a single "older than" bound cannot express.
     */
    const ageBound = ageWindow(query.age);
    const agedOver =
      query.agedOverDays === undefined
        ? undefined
        : { $lte: new Date(Date.now() - query.agedOverDays * 86_400_000) };

    const markedAt = { ...ageBound, ...agedOver };
    if (Object.keys(markedAt).length > 0) match.markedAt = markedAt;

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

    /*
     * Driver and zone live on the JOB, so they have to be matched after the
     * lookup rather than in the first `$match` — which is why they were easy to
     * leave out and why the two dropdowns did nothing.
     */
    if (query.driver && mongoose.isValidObjectId(query.driver)) {
      pipeline.push({
        $match: { 'job.driverId': new mongoose.Types.ObjectId(query.driver) },
      });
    }

    if (query.zoneId && mongoose.isValidObjectId(query.zoneId)) {
      pipeline.push({
        $match: { 'job.zoneId': new mongoose.Types.ObjectId(query.zoneId) },
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
            ...jobNumberMatch(term),
            { 'job.driverName': { $regex: term, $options: 'i' } },
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
        // ⚠️ AFTER the page is cut, not before. The fee is display data, so it
        // is joined for the twenty rows being shown rather than for every
        // futile pickup that ever matched the filter.
        FUTILE_CHARGE_LOOKUP,
      ]),
      FutileReviewModel.aggregate<{ total: number }>([...pipeline, { $count: 'total' }]),
    ]);

    const [photoCounts, zones] = await Promise.all([
      // The photos of what stopped the pickup, not every shot on the job.
      countEvidencePhotos(
        rows.map((row) => row.job._id),
        'futile',
      ),
      zoneLabels(),
    ]);

    return {
      data: rows.map((row) => toFutileItem(row, feeExGst, photoCounts, zones)),
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
      FUTILE_CHARGE_LOOKUP,
    ]);

    const row = rows[0];
    if (!row) return null;

    /*
     * The photos the driver took ON the could-not-collect screen — what the
     * decision rests on. This used to be every photo on the job, so the office
     * judged a locked gate from a "pile before" shot of a pickup that never got
     * that far.
     */
    const photos = (
      await JobPhotoModel.find({ jobId: row.job._id }).sort({ takenAt: 1 }).lean()
    ).filter((photo) => photoPurpose(photo) === 'futile');

    const counts = new Map([[row.job._id.toHexString(), photos.length]]);

    return {
      ...toFutileItem(row, feeExGst, counts, await zoneLabels()),
      photos: await toJobPhotoViews(photos),
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
    /** M4.2 — where the driver stood. Null when the phone had no fix. */
    latitude: number | null;
    longitude: number | null;
  }): Promise<void> {
    await FutileReviewModel.updateOne(
      { jobId: new mongoose.Types.ObjectId(input.jobId) },
      {
        /*
         * `$setOnInsert`, so a replayed offline report does not overwrite the
         * first one's position with a later, wronger fix — the driver has
         * usually left the site by the time the queue drains.
         */
        $setOnInsert: {
          jobId: new mongoose.Types.ObjectId(input.jobId),
          reason: input.reason,
          note: input.note,
          markedAt: input.markedAt,
          latitude: input.latitude,
          longitude: input.longitude,
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
    query: ApprovalListQuery,
  ): Promise<{ data: ChargeApprovalItem[]; meta: PageMeta }> {
    /*
     * ── Why the state is a parameter and not a constant ───────────────────
     * It used to be hard-coded to `pending`, which made approving a charge
     * erase it from the only screen that lists charges: no filter here offered
     * a decision, so "what did we approve last week, and on what evidence?" had
     * no answer short of opening each job. That question gets asked precisely
     * when a builder is disputing money already committed.
     *
     * `pending` remains the DEFAULT, because this is a worklist first and the
     * nav badge counts the same thing — and because the table supports bulk
     * approve, where silently including already-decided rows would be a poor
     * idea. Asking for the others is now possible; it is just not the default.
     */
    const match: Record<string, unknown> =
      query.approvalState === 'any'
        ? { approvalState: { $in: ['pending', 'approved', 'rejected'] } }
        : { approvalState: query.approvalState ?? 'pending' };

    if (query.code !== undefined) match.code = query.code;

    // The "Waiting" filter speaks in windows; `agedOverDays` stays for other callers.
    const raisedAt = {
      ...ageWindow(query.age),
      ...(query.agedOverDays === undefined
        ? {}
        : { $lte: new Date(Date.now() - query.agedOverDays * 86_400_000) }),
    };
    if (Object.keys(raisedAt).length > 0) match.raisedAt = raisedAt;

    /*
     * "Raised by" lists drivers, and a driver raises charges from the phone on
     * their own job — so it is the job's driver on a driver-raised charge.
     */
    if (query.driver && mongoose.isValidObjectId(query.driver)) match.source = 'driver';

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

    if (query.driver && mongoose.isValidObjectId(query.driver)) {
      pipeline.push({ $match: { 'job.driverId': new mongoose.Types.ObjectId(query.driver) } });
    }

    if (query.po !== undefined) {
      pipeline.push({
        $match: {
          'account.poPolicy':
            query.po === 'required'
              ? 'required-before-invoice'
              : { $ne: 'required-before-invoice' },
        },
      });
    }

    if (query.q) {
      const term = escapeRegex(query.q);
      pipeline.push({
        $match: {
          $or: [
            { 'job.accountName': { $regex: term, $options: 'i' } },
            { 'job.siteName': { $regex: term, $options: 'i' } },
            { description: { $regex: term, $options: 'i' } },
            ...jobNumberMatch(term),
            { raisedBy: { $regex: term, $options: 'i' } },
          ],
        },
      });
    }

    /*
     * The evidence count, per CHARGE: a contamination charge counts the
     * contamination photos, a futile fee the futile ones, anything else the
     * ordinary job photos. It used to count every photo on the job, so a charge
     * with no photo of its own read "5 photos" off the five-shot checklist.
     *
     * Before the page is cut when the Evidence filter needs it; otherwise only
     * for the rows being shown.
     */
    const evidence: mongoose.PipelineStage[] = [
      {
        $lookup: {
          from: 'jobphotos',
          let: { jobId: '$jobId', code: '$code' },
          pipeline: [
            { $match: { $expr: { $eq: ['$jobId', '$$jobId'] } } },
            { $project: { purpose: PHOTO_PURPOSE_EXPR } },
            { $match: { $expr: { $eq: ['$purpose', chargeEvidencePurposeExpr('$$code')] } } },
            { $count: 'count' },
          ],
          as: 'evidence',
        },
      },
      { $addFields: { evidenceCount: { $ifNull: [{ $first: '$evidence.count' }, 0] } } },
    ];

    if (query.evidence !== undefined) {
      pipeline.push(...evidence, {
        $match: { evidenceCount: query.evidence === 'with-photos' ? { $gt: 0 } : 0 },
      });
    }

    const [rows, totals] = await Promise.all([
      JobChargeModel.aggregate<RawApprovalRow & { evidenceCount: number }>([
        ...pipeline,
        { $sort: approvalSort(query.sort) },
        { $skip: (query.page - 1) * query.pageSize },
        { $limit: query.pageSize },
        ...(query.evidence === undefined ? evidence : []),
      ]),
      JobChargeModel.aggregate<{ total: number }>([...pipeline, { $count: 'total' }]),
    ]);

    return {
      data: rows.map((row) => toApprovalItem(row, row.evidenceCount)),
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

    /*
     * The photos of THIS charge's evidence — a contamination charge is approved
     * by looking at the contamination, not at every shot on the job. See
     * `evidencePurposeForCharge`.
     */
    const purpose = evidencePurposeForCharge(row.code);
    const photos = (
      await JobPhotoModel.find({ jobId: row.job._id }).sort({ takenAt: 1 }).lean()
    ).filter((photo) => photoPurpose(photo) === purpose);

    return {
      ...toApprovalItem(row, photos.length),
      photos: await toJobPhotoViews(photos),
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
    /*
     * ⚠️ The projected field is `amount`. It used to ask for `amountExGst`,
     * which the schema does not define — so Mongo returned nothing for it and
     * the `.toString()` below threw. The throw happened AFTER `updateMany`,
     * so the charge was approved and the office was shown "Something went
     * wrong": they pressed Approve again, got "None of those charges could be
     * decided", and had no way to tell that the money was already live.
     */
    const affected = await JobChargeModel.find(
      { _id: { $in: ids }, approvalState: 'pending' },
      { jobId: 1, description: 1, amount: 1 },
    ).lean<
      Array<{
        _id: mongoose.Types.ObjectId;
        jobId: mongoose.Types.ObjectId;
        description: string;
        amount: mongoose.Types.Decimal128;
      }>
    >();

    const result = await JobChargeModel.updateMany(
      { _id: { $in: ids }, approvalState: 'pending' },
      {
        $set: {
          approvalState: input.to,
          /*
           * The office's reason goes in its OWN field. The comment here used to
           * claim the note was appended to the driver's; the code `$set` it
           * straight over the top, so a rejection erased the driver’s account of
           * what was in the load — the evidence the charge rests on.
           */
          ...(input.note ? { decisionNote: input.note } : {}),
          decidedBy: input.decidedBy,
          decidedAt: new Date(),
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
        amountExGst: row.amount.toString(),
      })),
    };
  },

  /* ── M5.4 · Change requests from the portal ───────────────────────────── */

  /**
   * Everything still open, oldest first.
   *
   * Oldest first for the same reason the futile queue is: a worklist sorted
   * newest-first is one where the oldest row is never touched — and the oldest
   * row here is a customer who has been waiting longest for an answer they were
   * told was coming.
   */
  async changeRequestList(
    query: QueueListQuery,
  ): Promise<{ data: ChangeRequestItem[]; meta: PageMeta }> {
    const match: Record<string, unknown> = { state: 'open' };

    if (query.agedOverDays !== undefined) {
      const cutoff = new Date(Date.now() - query.agedOverDays * 86_400_000);
      match.requestedAt = { $lte: cutoff };
    }

    if (query.account && mongoose.isValidObjectId(query.account)) {
      match.accountId = new mongoose.Types.ObjectId(query.account);
    }

    const pipeline: mongoose.PipelineStage[] = [
      { $match: match },
      { $lookup: { from: 'jobs', localField: 'jobId', foreignField: '_id', as: 'job' } },
      { $unwind: '$job' },
    ];

    if (query.q) {
      const term = escapeRegex(query.q);
      pipeline.push({
        $match: {
          $or: [
            { 'job.accountName': { $regex: term, $options: 'i' } },
            { 'job.siteName': { $regex: term, $options: 'i' } },
            { 'job.suburb': { $regex: term, $options: 'i' } },
            ...jobNumberMatch(term),
            { requestedByName: { $regex: term, $options: 'i' } },
          ],
        },
      });
    }

    const [rows, totals] = await Promise.all([
      ChangeRequestModel.aggregate<RawChangeRequestRow>([
        ...pipeline,
        { $sort: { requestedAt: 1 } },
        { $skip: (query.page - 1) * query.pageSize },
        { $limit: query.pageSize },
      ]),
      ChangeRequestModel.aggregate<{ total: number }>([...pipeline, { $count: 'total' }]),
    ]);

    return {
      data: rows.map(toChangeRequestItem),
      meta: pageMeta(query, totals[0]?.total ?? 0),
    };
  },

  /**
   * Close one out.
   *
   * Guarded on `state: open` so two people working the queue cannot both answer
   * the same request — the second gets `false` and a conflict, rather than
   * silently overwriting the first decision and its author.
   */
  async decideChangeRequest(input: {
    id: string;
    outcome: 'actioned' | 'declined';
    note: string | null;
    decidedBy: string;
  }): Promise<{
    jobId: string;
    jobNumber: number;
    accountId: string;
    /** Who besides the administrators may see the pickup — and so be told. */
    bookedByUserId: string | null;
  } | null> {
    if (!mongoose.isValidObjectId(input.id)) return null;

    const row = await ChangeRequestModel.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(input.id), state: 'open' },
      {
        $set: {
          state: input.outcome,
          resolvedAt: new Date(),
          resolvedBy: input.decidedBy,
          resolutionNote: input.note,
        },
      },
      { new: true },
    ).lean<{ jobId: mongoose.Types.ObjectId; accountId: mongoose.Types.ObjectId }>();

    if (!row) return null;

    const job = await JobModel.findById(row.jobId, { jobNumber: 1, bookedByUserId: 1 }).lean<{
      jobNumber: number;
      bookedByUserId?: mongoose.Types.ObjectId | null;
    }>();

    return {
      jobId: row.jobId.toHexString(),
      jobNumber: job?.jobNumber ?? 0,
      accountId: row.accountId.toHexString(),
      bookedByUserId: job?.bookedByUserId ? job.bookedByUserId.toHexString() : null,
    };
  },

  /** Drives the nav badge, beside the other queue counts. */
  async openChangeRequestCount(): Promise<number> {
    return ChangeRequestModel.countDocuments({ state: 'open' });
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
  async awaitingPoList(
    query: AwaitingPoListQuery,
  ): Promise<{ data: AwaitingPoItem[]; meta: PageMeta }> {
    const filter: Record<string, unknown> = { status: 'awaiting-po' };

    if (query.account && mongoose.isValidObjectId(query.account)) {
      filter.accountId = new mongoose.Types.ObjectId(query.account);
    }

    /*
     * "Waiting" and "Chased" were drawn in this screen's filter bar and dropped
     * by the query schema, so both did nothing. An invoice older than the
     * chase-count field has none, which is "never chased" — `null` matches it.
     */
    const createdAt = {
      ...ageWindow(query.age),
      ...(query.agedOverDays === undefined
        ? {}
        : { $lte: new Date(Date.now() - query.agedOverDays * 86_400_000) }),
    };
    if (Object.keys(createdAt).length > 0) filter.createdAt = createdAt;

    if (query.chased === 'yes') filter.chaseCount = { $gt: 0 };
    if (query.chased === 'no') filter.chaseCount = { $in: [0, null] };

    /*
     * The search box on this screen did nothing at all.
     *
     * It offered "invoice, job, customer or contact" and `query.q` was never
     * read, so every term — nonsense included — returned the whole queue. On a
     * chase list twenty-one rows long that is not a small thing: the box is how
     * somebody finds the invoice a builder has just rung about.
     *
     * The contact lives on `contacts`, not on the invoice, so a contact search
     * resolves to account ids first. One extra query, and only on a real term.
     */
    if (query.q) {
      const term = escapeRegex(query.q);
      const or: Record<string, unknown>[] = [
        { accountName: { $regex: term, $options: "i" } },
      ];

      // `invoiceNumber` and `jobNumber` are numbers; a regex would never match.
      if (/^\d+$/.test(query.q.trim())) {
        const asNumber = Number(query.q.trim());
        or.push({ invoiceNumber: asNumber }, { jobNumber: asNumber });
      }

      const contactRows = await ContactModel.find(
        { name: { $regex: term, $options: "i" } },
        { accountId: 1 },
      ).lean<Array<{ accountId: mongoose.Types.ObjectId }>>();

      if (contactRows.length > 0) {
        or.push({ accountId: { $in: contactRows.map((row) => row.accountId) } });
      }

      filter.$or = or;
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
   * The chosen invoices still waiting on a purchase order, with who to ask.
   *
   * For "Send reminder": each comes with what the PO is FOR (its lines) and the
   * account's billing contacts — `accounts`-role contacts with an email and
   * email notices on. Nobody else: a request for a purchase order that lands
   * with the site foreman is a request nobody raises.
   */
  async awaitingPoForChase(ids: readonly string[]): Promise<
    Array<{
      id: string;
      invoiceNumber: number;
      accountId: string;
      accountName: string;
      jobId: string | null;
      jobNumber: number | null;
      siteName: string | null;
      totalIncGst: string;
      chargeSummary: string;
      chaseCount: number;
      billingContacts: Array<{ id: string; name: string; email: string }>;
    }>
  > {
    const objectIds = ids
      .filter((id) => mongoose.isValidObjectId(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (objectIds.length === 0) return [];

    const rows = await InvoiceModel.find({ _id: { $in: objectIds }, status: 'awaiting-po' }).lean<
      RawAwaitingPoRow[]
    >();

    if (rows.length === 0) return [];

    const jobIds = rows
      .map((row) => row.jobId)
      .filter((id): id is mongoose.Types.ObjectId => id !== null);

    const [lines, jobs, contacts] = await Promise.all([
      InvoiceLineModel.find(
        { invoiceId: { $in: rows.map((row) => row._id) } },
        { invoiceId: 1, description: 1 },
      )
        .sort({ position: 1 })
        .lean<Array<{ invoiceId: mongoose.Types.ObjectId; description: string }>>(),
      JobModel.find({ _id: { $in: jobIds } }, { siteName: 1 }).lean<
        Array<{ _id: mongoose.Types.ObjectId; siteName: string }>
      >(),
      ContactModel.find({
        accountId: { $in: [...new Set(rows.map((row) => row.accountId.toHexString()))].map(
          (id) => new mongoose.Types.ObjectId(id),
        ) },
        role: 'accounts',
        email: { $nin: [null, ''] },
        notifyByEmail: true,
      }).lean(),
    ]);

    const linesByInvoice = new Map<string, string[]>();
    for (const line of lines) {
      const key = line.invoiceId.toHexString();
      linesByInvoice.set(key, [...(linesByInvoice.get(key) ?? []), line.description]);
    }

    const siteByJob = new Map(jobs.map((job) => [job._id.toHexString(), job.siteName]));

    const contactsByAccount = new Map<string, Array<{ id: string; name: string; email: string }>>();
    for (const contact of contacts) {
      if (!contact.email) continue;
      const key = contact.accountId.toHexString();
      contactsByAccount.set(key, [
        ...(contactsByAccount.get(key) ?? []),
        { id: contact._id.toHexString(), name: contact.name, email: contact.email },
      ]);
    }

    return rows.map((row) => {
      const descriptions = linesByInvoice.get(row._id.toHexString()) ?? [];

      return {
        id: row._id.toHexString(),
        invoiceNumber: row.invoiceNumber,
        accountId: row.accountId.toHexString(),
        accountName: row.accountName,
        jobId: row.jobId ? row.jobId.toHexString() : null,
        jobNumber: row.jobNumber ?? null,
        siteName: (row.jobId && siteByJob.get(row.jobId.toHexString())) || null,
        totalIncGst: fromDecimal128(row.totalIncGst),
        chargeSummary: descriptions.length > 0 ? descriptions.join(', ') : 'Additional charges',
        chaseCount: row.chaseCount ?? 0,
        billingContacts: contactsByAccount.get(row.accountId.toHexString()) ?? [],
      };
    });
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
  /* The job stores an id; the queue shows the zone's current name. */
  zoneId: mongoose.Types.ObjectId;
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
  latitude?: number | null;
  longitude?: number | null;
  outcome: FutileOutcome;
  decisionNote?: string | null;
  decidedAt?: Date | null;
  decidedBy?: string | null;
  newReadyDate?: string | null;
  job: RawJobJoin;
  /**
   * The fee this job was ACTUALLY charged, joined by `FUTILE_CHARGE_LOOKUP`.
   *
   * Empty where the charge could not be found — see the note on the lookup.
   */
  futileCharge?: Array<{
    amount: mongoose.Types.Decimal128;
    approvalState?: ChargeApprovalState | null;
  }>;
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
  latitude?: number | null;
  longitude?: number | null;
  approvalState: ChargeApprovalItem['approvalState'];
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
  zones: ReadonlyMap<string, string>,
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
    zoneId: row.job.zoneId.toString(),
    zoneLabel: zones.get(row.job.zoneId.toString()) ?? UNKNOWN_ZONE_LABEL,
    driverId: row.job.driverId ? row.job.driverId.toHexString() : null,
    driverName: row.job.driverName,
    reason: row.reason,
    note: row.note ?? null,
    markedAt: row.markedAt.toISOString(),
    readyDate: row.job.readyDate,
    photoCount: photoCounts.get(row.job._id.toHexString()) ?? 0,
    /*
     * The driver's own fix, now that the review stores one.
     *
     * This was hard-coded null, on the argument that the photos carry their own
     * position — which they do, but the row and the dialog both offer a
     * "Position when marked" field, and that field read "Not captured" on every
     * futile ever reviewed. The screen the driver fills in says their position
     * is part of what makes the $120 stand up; telling the office it was never
     * taken is the opposite of that.
     *
     * Still null for reviews opened before the field existed, which is honest:
     * that position really was thrown away.
     */
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    /*
     * What this job was charged, not what a futile costs today — see
     * `FUTILE_CHARGE_LOOKUP`. The argument is the fallback, for a review whose
     * charge line is missing: one opened before the charge existed, or a job
     * whose charges were cleared. Showing today's price there is better than
     * showing nothing, and it is what every row used to do.
     *
     * A charge the office REJECTED was waived, and nothing is charged for it.
     */
    feeExGst: row.futileCharge?.[0]
      ? row.futileCharge[0].approvalState === 'rejected'
        ? '0.00'
        : fromDecimal128(row.futileCharge[0].amount)
      : feeExGst,
    outcome: row.outcome,
  };
}

interface RawChangeRequestRow {
  _id: mongoose.Types.ObjectId;
  kind: 'reschedule' | 'cancel' | 'other';
  requestedDate: string | null;
  note: string;
  requestedByName: string;
  requestedAt: Date;
  job: {
    _id: mongoose.Types.ObjectId;
    jobNumber: number;
    accountId: mongoose.Types.ObjectId;
    accountName: string;
    siteName: string;
    suburb: string;
    status: ChangeRequestItem['status'];
    driverName: string | null;
    readyDate: string;
  };
}

function toChangeRequestItem(row: RawChangeRequestRow): ChangeRequestItem {
  return {
    id: row._id.toHexString(),
    jobId: row.job._id.toHexString(),
    jobNumber: row.job.jobNumber,
    accountId: row.job.accountId.toHexString(),
    accountName: row.job.accountName,
    siteName: row.job.siteName,
    suburb: row.job.suburb,
    status: row.job.status,
    driverName: row.job.driverName,
    readyDate: row.job.readyDate,
    kind: row.kind,
    requestedDate: row.requestedDate,
    note: row.note,
    requestedByName: row.requestedByName,
    requestedAt: row.requestedAt.toISOString(),
  };
}

function toApprovalItem(row: RawApprovalRow, evidenceCount: number): ChargeApprovalItem {
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
    // Photos of this charge's evidence — see `evidencePurposeForCharge`.
    photoCount: evidenceCount,
    /*
     * M2.7's closing rule, surfaced on the ROW: approving this on a PO-required
     * account does not release money, it bills the charge on an invoice that
     * waits in the awaiting-PO queue. The approver should know that before
     * clicking, not after.
     */
    poRequired: row.account.poPolicy === 'required-before-invoice',
    // Approving bills a finished job at once; one still under way is billed with the job.
    jobFinished: FINISHED_JOB_STATUSES.has(row.job.status),
    /*
     * Where the driver was standing, now that the charge stores it. Hard-coded
     * null before, so "Position when raised" said "Not captured" on every charge
     * — including ones raised with a perfectly good fix, on the screen that told
     * the driver their position is what makes the charge stand up.
     */
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    approvalState: row.approvalState,
  };
}

/**
 * Evidence photo counts for a page of rows, in one query rather than one per
 * row — only the photos that are evidence of `purpose` (see `photoPurpose`).
 */
async function countEvidencePhotos(
  jobIds: mongoose.Types.ObjectId[],
  purpose: PhotoPurpose,
): Promise<Map<string, number>> {
  if (jobIds.length === 0) return new Map();

  const counts = await JobPhotoModel.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
    { $match: { jobId: { $in: jobIds } } },
    { $project: { jobId: 1, purpose: PHOTO_PURPOSE_EXPR } },
    { $match: { purpose } },
    { $group: { _id: '$jobId', count: { $sum: 1 } } },
  ]);

  return new Map(counts.map((row) => [row._id.toHexString(), row.count]));
}

/**
 * The approvals grid's column sort.
 *
 * An allow-list, not a pass-through: `sort` arrives from a querystring, and an
 * arbitrary field name handed to Mongo sorts by anything in the document. The
 * headers offered these four, and every click on them used to be ignored —
 * the grid stayed oldest-first whatever it said. `_id` breaks ties, so paging
 * through equal values neither repeats nor skips a row.
 */
const APPROVAL_SORTS: Record<string, string> = {
  jobNumber: 'job.jobNumber',
  accountName: 'job.accountName',
  raisedAt: 'raisedAt',
  amountExGst: 'amount',
};

function approvalSort(sort: string | undefined): Record<string, 1 | -1> {
  const key = sort?.replace(/^-/, '') ?? '';
  const field = APPROVAL_SORTS[key];
  if (!field) return { raisedAt: 1, _id: 1 };
  return { [field]: sort?.startsWith('-') ? -1 : 1, _id: 1 };
}

/**
 * User input goes into a regex, so it is escaped.
 *
 * Without this a typed `(` is a syntax error and a typed `.*` is a scan.
 */
/**
 * Match a job number typed into a search box.
 *
 * `jobNumber` is a NUMBER, so the `$regex` clauses beside it could never match
 * it — which is why every queue whose placeholder said "Search job number…"
 * returned nothing for the one thing people are most likely to type. Converted
 * for the comparison, so a partial ("613") works as well as the whole number.
 *
 * Only when the term contains a digit: running `$toString` across every row
 * for a search like "Clarendon" would be work that cannot match anything.
 */
function jobNumberMatch(term: string): Record<string, unknown>[] {
  if (!/\d/.test(term)) return [];

  return [
    {
      $expr: {
        $regexMatch: {
          input: { $toString: { $ifNull: ['$job.jobNumber', ''] } },
          regex: term,
        },
      },
    },
  ];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { AccountModel };
