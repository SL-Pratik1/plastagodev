import mongoose from 'mongoose';
import { fromDecimal128 } from '../../lib/money.js';
import { PurchaseOrderModel } from './purchase-order.model.js';

/**
 * Reading confirmed purchase orders (M2.12).
 *
 * ── Why this is separate from `po-extraction.repository` ──────────────────
 * They are two aggregates with opposite lifecycles. An extraction is a proposal
 * that is worked once and then closed; a purchase order is a durable record that
 * is read months later when the pickup is finally booked. The extraction
 * repository is written by the review queue and read by nothing else — this one
 * is read by the jobs domain, which has no business seeing the review workflow.
 *
 * Repository layer, so the ONLY file here that touches Mongoose for this
 * collection (§6A.3 #5).
 */

/**
 * A confirmed order, as the booking form needs it.
 *
 * Only the fields that fill in a job. The money, the storage key and the
 * extraction it came from stay out: a person choosing which order a pickup is
 * against does not need the audit trail, and `amountExGst` beside a live quote
 * invites someone to reconcile two figures that are not meant to match.
 */
export interface BookablePurchaseOrder {
  id: string;
  poNumber: string;
  accountId: string;
  accountName: string;
  receivedAt: string;
  lotNumber: string | null;
  addressLine: string | null;
  suburb: string | null;
  postcode: string | null;
  /** ⚠️ Null on a fixed-price order, and that is a real answer. Never zero. */
  expectedAreaM2: number | null;
  bagAllowance: number | null;
  siteSupervisorName: string | null;
  siteSupervisorMobile: string | null;
  /**
   * The supervisor's portal login, where one was provisioned.
   *
   * Carried through to the booking so a job raised against this order can be
   * scoped to them (Matt, 33:57) without matching on a name.
   */
  siteSupervisorUserId: string | null;
  amountExGst: string | null;
}

interface RawOrder {
  _id: mongoose.Types.ObjectId;
  poNumber: string;
  accountId: mongoose.Types.ObjectId;
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
  siteSupervisorUserId: mongoose.Types.ObjectId | null;
  amountExGst: mongoose.Types.Decimal128 | null;
}

function toBookable(row: RawOrder): BookablePurchaseOrder {
  return {
    id: row._id.toHexString(),
    poNumber: row.poNumber,
    accountId: row.accountId.toHexString(),
    accountName: row.accountName,
    receivedAt: row.receivedAt.toISOString(),
    lotNumber: row.lotNumber ?? null,
    addressLine: row.addressLine ?? null,
    suburb: row.suburb ?? null,
    postcode: row.postcode ?? null,
    // Null stays null. See the warning on the interface.
    expectedAreaM2: row.expectedAreaM2 ?? null,
    bagAllowance: row.bagAllowance ?? null,
    siteSupervisorName: row.siteSupervisorName ?? null,
    siteSupervisorMobile: row.siteSupervisorMobile ?? null,
    siteSupervisorUserId: row.siteSupervisorUserId
      ? row.siteSupervisorUserId.toHexString()
      : null,
    amountExGst: row.amountExGst ? fromDecimal128(row.amountExGst) : null,
  };
}

/** How many orders the picker offers. Enough to browse, not enough to page. */
const PICKER_LIMIT = 50;

export const purchaseOrderRepository = {
  /**
   * Records which login the order's named supervisor turned out to be.
   *
   * Written after the order exists rather than as part of it: provisioning a
   * person is a separate act that is allowed to fail, and a purchase order must
   * be confirmable whether or not it succeeded (Matt, 34:52).
   */
  async setSupervisorUser(id: string, userId: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(userId)) return false;

    const result = await PurchaseOrderModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { siteSupervisorUserId: new mongoose.Types.ObjectId(userId) } },
    );

    return result.matchedCount === 1;
  },

  /**
   * One order, scoped to the account it belongs to.
   *
   * ⚠️ `accountId` is part of the FILTER, not checked afterwards. It is what
   * stops a caller booking a job against somebody else's purchase order by
   * pasting its id — and a constraint applied to the query cannot be forgotten
   * the way a subsequent `if` can (§6A.3 #5).
   */
  async findForAccount(id: string, accountId: string): Promise<BookablePurchaseOrder | null> {
    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(accountId)) return null;

    const row = await PurchaseOrderModel.findOne({
      _id: new mongoose.Types.ObjectId(id),
      accountId: new mongoose.Types.ObjectId(accountId),
    }).lean<RawOrder>();

    return row ? toBookable(row) : null;
  },

  /**
   * The orders on one account, newest first.
   *
   * Newest first rather than oldest, unlike every queue in this codebase: this
   * is not a worklist. Somebody booking a pickup is looking for an order that
   * arrived recently, because the work follows the order by months and the
   * oldest ones are usually already done.
   */
  async listForAccount(accountId: string, search?: string): Promise<BookablePurchaseOrder[]> {
    if (!mongoose.isValidObjectId(accountId)) return [];

    const filter: Record<string, unknown> = {
      accountId: new mongoose.Types.ObjectId(accountId),
    };

    if (search) {
      /*
       * Anchored on the PO number, and deliberately not a contains-match: these
       * numbers are long and structured — `79904106/082`, `208918.321.01` — and
       * somebody typing them reads left to right off a document. A leading
       * wildcard would also give up the index.
       */
      const term = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.poNumber = { $regex: `^${term}`, $options: 'i' };
    }

    const rows = await PurchaseOrderModel.find(filter)
      .sort({ receivedAt: -1 })
      .limit(PICKER_LIMIT)
      .lean<RawOrder[]>();

    return rows.map(toBookable);
  },
};
