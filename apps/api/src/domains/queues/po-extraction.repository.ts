import type {
  ExtractedField,
  MatchCandidate,
  PageMeta,
  PoExtraction,
  PoExtractionItem,
  PoReviewReason,
  PoReviewState,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { fromDecimal128, toDecimal128 } from '../../lib/money.js';
import { PoExtractionModel, PurchaseOrderModel } from './purchase-order.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 */

export interface ListExtractionsQuery {
  page: number;
  pageSize: number;
  q?: string | undefined;
  state?: PoReviewState | undefined;
  reason?: PoReviewReason | undefined;
  agedOverDays?: number | undefined;
}

/** What an extractor posts. Every field is a claim, none of it is trusted. */
export interface IngestExtractionInput {
  /**
   * The extractor's own id, when the row came from the vendor pipeline (I6).
   *
   * Absent on a row posted by hand. See the warning on the model — this is the
   * idempotency key that stops a retried callback queueing one purchase order
   * twice.
   */
  externalId?: string | undefined;
  fromAddress: string;
  subject: string;
  receivedAt: Date;
  attachmentName: string;
  pageCount: number;
  storageKey: string | null;
  documentText: string;
  poNumber: string | null;
  amountExGst: string | null;
  extractedAreaM2: number | null;
  extractedBagAllowance: number | null;
  extractedSiteAddress: string | null;
  extractedLotNumber: string | null;
  extractedSupervisorName: string | null;
  extractedSupervisorMobile: string | null;
  fields: ExtractedField[];
  suggestedAccountId: string | null;
  suggestedAccountName: string | null;
  suggestedJobId: string | null;
  suggestedJobNumber: number | null;
  accountCandidates: MatchCandidate[];
  jobCandidates: MatchCandidate[];
  overallConfidence: number;
  reason: PoReviewReason;
}

export interface ConfirmedPurchaseOrderInput {
  poNumber: string;
  accountId: string;
  accountName: string;
  receivedAt: Date;
  lotNumber: string | null;
  addressLine: string | null;
  suburb: string | null;
  postcode: string | null;
  expectedAreaM2: number | null;
  bagAllowance: number | null;
  siteSupervisorName: string | null;
  siteSupervisorMobile: string | null;
  amountExGst: string | null;
  storageKey: string | null;
  extractionId: string;
  createdByName: string;
}

interface RawExtraction {
  _id: mongoose.Types.ObjectId;
  fromAddress: string;
  subject: string;
  receivedAt: Date;
  attachmentName: string;
  pageCount: number;
  documentText: string;
  poNumber: string | null;
  amountExGst: mongoose.Types.Decimal128 | null;
  extractedAreaM2: number | null;
  extractedBagAllowance: number | null;
  extractedSiteAddress: string | null;
  extractedLotNumber: string | null;
  extractedSupervisorName: string | null;
  extractedSupervisorMobile: string | null;
  fields: ExtractedField[];
  suggestedAccountId: mongoose.Types.ObjectId | null;
  suggestedAccountName: string | null;
  suggestedJobId: mongoose.Types.ObjectId | null;
  suggestedJobNumber: number | null;
  accountCandidates: MatchCandidate[];
  jobCandidates: MatchCandidate[];
  overallConfidence: number;
  reason: PoReviewReason;
  state: PoReviewState;
  reviewedAt: Date | null;
  reviewedBy: string | null;
}

function toItem(row: RawExtraction): PoExtractionItem {
  return {
    id: row._id.toHexString(),
    fromAddress: row.fromAddress,
    subject: row.subject,
    receivedAt: row.receivedAt.toISOString(),
    attachmentName: row.attachmentName,
    pageCount: row.pageCount,
    poNumber: row.poNumber,
    suggestedAccountId: row.suggestedAccountId ? row.suggestedAccountId.toHexString() : null,
    suggestedAccountName: row.suggestedAccountName,
    suggestedJobId: row.suggestedJobId ? row.suggestedJobId.toHexString() : null,
    suggestedJobNumber: row.suggestedJobNumber,
    amountExGst: row.amountExGst ? fromDecimal128(row.amountExGst) : null,
    extractedAreaM2: row.extractedAreaM2,
    extractedBagAllowance: row.extractedBagAllowance,
    extractedSiteAddress: row.extractedSiteAddress,
    extractedLotNumber: row.extractedLotNumber,
    extractedSupervisorName: row.extractedSupervisorName,
    extractedSupervisorMobile: row.extractedSupervisorMobile,
    overallConfidence: row.overallConfidence,
    reason: row.reason,
    state: row.state,
  };
}

export const poExtractionRepository = {
  async list(
    query: ListExtractionsQuery,
  ): Promise<{ data: PoExtractionItem[]; meta: PageMeta }> {
    // The queue means "needs review" unless a state is named explicitly —
    // otherwise every confirmed order from the past year is in the worklist.
    const filter: Record<string, unknown> = { state: query.state ?? 'needs-review' };

    if (query.reason) filter.reason = query.reason;

    if (query.agedOverDays !== undefined) {
      filter.receivedAt = { $lte: new Date(Date.now() - query.agedOverDays * 86_400_000) };
    }

    if (query.q) {
      const term = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { subject: { $regex: term, $options: 'i' } },
        { fromAddress: { $regex: term, $options: 'i' } },
        { poNumber: { $regex: term, $options: 'i' } },
        { suggestedAccountName: { $regex: term, $options: 'i' } },
      ];
    }

    const [rows, total] = await Promise.all([
      PoExtractionModel.find(filter)
        // Oldest first — a PO sitting unreviewed is an invoice that cannot go out.
        .sort({ receivedAt: 1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean<RawExtraction[]>(),
      PoExtractionModel.countDocuments(filter),
    ]);

    return {
      data: rows.map(toItem),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  },

  async findById(id: string): Promise<PoExtraction | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    const row = await PoExtractionModel.findById(id).lean<RawExtraction>();
    if (!row) return null;

    return {
      ...toItem(row),
      /*
       * Always null here, and filled in by the service.
       *
       * Minting a presigned URL is a storage concern with an expiry attached,
       * and a repository that returned one would hand every caller a credential
       * whether it needed it or not. `poReviewService.get` overrides this with
       * a fresh link; the storage key itself never leaves that boundary.
       */
      documentUrl: null,
      documentText: row.documentText,
      fields: row.fields,
      accountCandidates: row.accountCandidates,
      jobCandidates: row.jobCandidates,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      reviewedBy: row.reviewedBy,
    };
  },

  async ingest(input: IngestExtractionInput): Promise<string> {
    const created = await PoExtractionModel.create({
      ...input,
      // Explicit rather than relying on the spread: `undefined` and `null` mean
      // the same thing to Mongoose here, but only one of them is what the
      // partial unique index expects to see.
      externalId: input.externalId ?? null,
      amountExGst: input.amountExGst === null ? null : toDecimal128(input.amountExGst),
      suggestedAccountId: input.suggestedAccountId
        ? new mongoose.Types.ObjectId(input.suggestedAccountId)
        : null,
      suggestedJobId: input.suggestedJobId
        ? new mongoose.Types.ObjectId(input.suggestedJobId)
        : null,
      // Always starts in the queue. See the warning on the model — an extraction
      // does not become a purchase order because a model was confident.
      state: 'needs-review',
    });

    return created._id.toHexString();
  },

  /**
   * The queue row for one extractor document, if it is already here.
   *
   * Returns the id rather than a boolean so the caller can report which row the
   * duplicate callback referred to — "already queued as X" is actionable in a
   * log; "true" is not.
   */
  async findByExternalId(externalId: string): Promise<string | null> {
    const row = await PoExtractionModel.findOne(
      { externalId: externalId.trim() },
      { _id: 1 },
    ).lean<{ _id: mongoose.Types.ObjectId }>();

    return row ? row._id.toHexString() : null;
  },

  /** Whether this PO number is already on a confirmed order for that account. */
  async isDuplicate(accountId: string, poNumber: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(accountId)) return false;

    const count = await PurchaseOrderModel.countDocuments({
      accountId: new mongoose.Types.ObjectId(accountId),
      poNumber: poNumber.trim(),
    });

    return count > 0;
  },

  /**
   * Confirms an extraction into a real purchase order.
   *
   * ⚠️ `state: 'needs-review'` is part of the FILTER on the extraction. Two
   * people reviewing the same document would otherwise create two purchase
   * orders for one builder order — and the unique index on
   * `(accountId, poNumber)` would fail the second one with a database error
   * rather than an explanation.
   */
  async confirm(input: {
    extractionId: string;
    order: ConfirmedPurchaseOrderInput;
    correctedFields: string[];
    reviewedByUserId: string;
    reviewedBy: string;
  }): Promise<{ purchaseOrderId: string } | null> {
    if (!mongoose.isValidObjectId(input.extractionId)) return null;

    // Claim the row FIRST. If this does not match, somebody else already
    // reviewed it and no order is created.
    const claimed = await PoExtractionModel.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(input.extractionId), state: 'needs-review' },
      {
        $set: {
          state: 'confirmed',
          reviewedAt: new Date(),
          reviewedByUserId: new mongoose.Types.ObjectId(input.reviewedByUserId),
          reviewedBy: input.reviewedBy,
          // The accuracy metric. See the warning on `correctedFields`.
          correctedFields: input.correctedFields,
        },
      },
      { returnDocument: 'after', projection: { _id: 1 } },
    ).lean<{ _id: mongoose.Types.ObjectId }>();

    if (!claimed) return null;

    const order = await PurchaseOrderModel.create({
      ...input.order,
      accountId: new mongoose.Types.ObjectId(input.order.accountId),
      amountExGst:
        input.order.amountExGst === null ? null : toDecimal128(input.order.amountExGst),
      extractionId: claimed._id,
    });

    await PoExtractionModel.updateOne(
      { _id: claimed._id },
      { $set: { purchaseOrderId: order._id } },
    );

    return { purchaseOrderId: order._id.toHexString() };
  },

  /** Releases a claimed extraction when the order could not be written. */
  async releaseClaim(extractionId: string): Promise<void> {
    if (!mongoose.isValidObjectId(extractionId)) return;

    await PoExtractionModel.updateOne(
      { _id: new mongoose.Types.ObjectId(extractionId) },
      {
        $set: { state: 'needs-review', reviewedAt: null, reviewedBy: null },
        $unset: { purchaseOrderId: '' },
      },
    );
  },

  async reject(input: {
    id: string;
    note: string;
    reviewedByUserId: string;
    reviewedBy: string;
  }): Promise<boolean> {
    if (!mongoose.isValidObjectId(input.id)) return false;

    const result = await PoExtractionModel.updateOne(
      { _id: new mongoose.Types.ObjectId(input.id), state: 'needs-review' },
      {
        $set: {
          state: 'rejected',
          rejectionNote: input.note,
          reviewedAt: new Date(),
          reviewedByUserId: new mongoose.Types.ObjectId(input.reviewedByUserId),
          reviewedBy: input.reviewedBy,
        },
      },
    );

    return result.matchedCount === 1;
  },

  /** The nav badge. */
  async countNeedingReview(): Promise<number> {
    return PoExtractionModel.countDocuments({ state: 'needs-review' });
  },

  findStorageKey,
};

/**
 * The stored original's key.
 *
 * Separate from `findById` because the key must never reach a client — the
 * service exchanges it for a short-lived URL and returns that instead.
 */
export async function findStorageKey(id: string): Promise<string | null> {
  if (!mongoose.isValidObjectId(id)) return null;

  const row = await PoExtractionModel.findById(id, { storageKey: 1 }).lean<{
    storageKey: string | null;
  }>();

  return row?.storageKey ?? null;
}
