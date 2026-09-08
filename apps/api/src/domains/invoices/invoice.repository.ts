import type {
  BrandId,
  Invoice,
  InvoiceKind,
  InvoiceLine,
  InvoiceListItem,
  InvoiceStatus,
  PageMeta,
  XeroSyncState,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { fromDecimal128, toDecimal128 } from '../../lib/money.js';
import { InvoiceLineModel, InvoiceModel } from './invoice.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 *
 * ── Where the access boundary is enforced ─────────────────────────────────
 * Every read takes an `InvoiceScope` and folds it into the FILTER. A customer
 * must never see another account's invoice, and an invoice carries what they
 * pay — so a row out of scope is never loaded, and cannot leak through a count,
 * a total or a sort.
 */

export interface InvoiceScope {
  /** Non-null narrows every read to one account. */
  accountId: string | null;
}

export interface ListInvoicesQuery {
  page: number;
  pageSize: number;
  sort?: string | undefined;
  q?: string | undefined;
  status?: InvoiceStatus | undefined;
  kind?: InvoiceKind | undefined;
  account?: string | undefined;
  brandId?: BrandId | undefined;
  xeroState?: XeroSyncState | undefined;
  issuedWindow?: string | undefined;
}

export interface CreateInvoiceInput {
  invoiceNumber: number;
  kind: InvoiceKind;
  status: InvoiceStatus;
  accountId: string;
  accountName: string;
  brandId: BrandId;
  jobId: string | null;
  jobNumber: number | null;
  poNumber: string | null;
  issuedOn: string | null;
  dueOn: string | null;
  paymentTermsDays: number;
  subtotalExGst: string;
  gst: string;
  totalIncGst: string;
  templateName: string;
  notes: string;
  lines: Array<{
    description: string;
    quantity: number;
    unitRate: string;
    amount: string;
    raisedBy: string | null;
    sourceChargeId: string | null;
  }>;
}

interface RawInvoice {
  _id: mongoose.Types.ObjectId;
  invoiceNumber: number;
  kind: InvoiceKind;
  status: InvoiceStatus;
  accountId: mongoose.Types.ObjectId;
  accountName: string;
  brandId: BrandId;
  jobId: mongoose.Types.ObjectId | null;
  jobNumber: number | null;
  poNumber: string | null;
  issuedOn: string | null;
  dueOn: string | null;
  sentAt: Date | null;
  paidAt: Date | null;
  paymentTermsDays: number;
  subtotalExGst: mongoose.Types.Decimal128;
  gst: mongoose.Types.Decimal128;
  totalIncGst: mongoose.Types.Decimal128;
  templateName: string;
  notes: string;
  xeroState: XeroSyncState;
  xeroLastSyncAt: Date | null;
  xeroMessage: string | null;
}

/**
 * Sort fields a caller may name.
 *
 * An allow-list, not a pass-through: `sort` arrives from a querystring, and
 * handing an arbitrary string to Mongo lets a caller sort by any field in the
 * document.
 */
const SORTABLE: Record<string, string> = {
  invoiceNumber: 'invoiceNumber',
  accountName: 'accountName',
  status: 'status',
  issuedOn: 'issuedOn',
  dueOn: 'dueOn',
  totalIncGst: 'totalIncGst',
  createdAt: 'createdAt',
};

interface InvoiceFilter {
  _id?: mongoose.Types.ObjectId | { $in: mongoose.Types.ObjectId[] };
  accountId?: mongoose.Types.ObjectId;
  status?: InvoiceStatus | { $in: InvoiceStatus[] };
  kind?: InvoiceKind;
  brandId?: BrandId;
  xeroState?: XeroSyncState;
  jobId?: mongoose.Types.ObjectId;
  issuedOn?: { $gte?: string; $lte?: string };
  poNumber?: { $nin: Array<string | null> };
  $text?: { $search: string };
}

export const invoiceRepository = {
  async list(
    query: ListInvoicesQuery,
    scope: InvoiceScope,
  ): Promise<{ data: InvoiceListItem[]; meta: PageMeta }> {
    const filter = buildFilter(query, scope);

    const sortKey = query.sort?.replace(/^-/, '') ?? '';
    const direction: 1 | -1 = query.sort?.startsWith('-') ? -1 : 1;
    const sortField = SORTABLE[sortKey];

    /*
     * Newest invoice first by default: the office works from the top, and an
     * invoice list ordered by anything else reads as stale. Mongo's natural
     * order is not an order anyone can predict.
     */
    const sort: Record<string, 1 | -1 | { $meta: 'textScore' }> = sortField
      ? { [sortField]: direction }
      : query.q
        ? { score: { $meta: 'textScore' } }
        : { invoiceNumber: -1 };

    const projection = query.q && !sortField ? { score: { $meta: 'textScore' } } : {};

    const [rows, total] = await Promise.all([
      InvoiceModel.find(filter, projection)
        .sort(sort)
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean<RawInvoice[]>(),
      InvoiceModel.countDocuments(filter),
    ]);

    return {
      data: rows.map(toListItem),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  },

  /** One invoice with its lines. Null when it does not exist or is out of scope. */
  async findById(id: string, scope: InvoiceScope): Promise<Invoice | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    const filter: InvoiceFilter = { _id: new mongoose.Types.ObjectId(id) };
    applyScope(filter, scope);

    const row = await InvoiceModel.findOne(filter).lean<RawInvoice>();
    if (!row) return null;

    const lines = await InvoiceLineModel.find({ invoiceId: row._id }).sort({ position: 1 }).lean();

    return {
      ...toListItem(row),
      lines: lines.map(
        (line): InvoiceLine => ({
          id: line._id.toHexString(),
          description: line.description,
          quantity: line.quantity,
          unitRate: fromDecimal128(line.unitRate),
          amount: fromDecimal128(line.amount),
          raisedBy: line.raisedBy ?? null,
        }),
      ),
      templateName: row.templateName,
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
      xeroState: row.xeroState,
      xeroLastSyncAt: row.xeroLastSyncAt ? row.xeroLastSyncAt.toISOString() : null,
      xeroMessage: row.xeroMessage,
      paymentTermsDays: row.paymentTermsDays,
      notes: row.notes,
    };
  },

  /**
   * Writes an invoice and its lines.
   *
   * The invoice is written FIRST so a failure part-way leaves an invoice with
   * no lines rather than orphaned lines pointing at nothing — the former is
   * visible and fixable, the latter is invisible.
   */
  async create(input: CreateInvoiceInput): Promise<InvoiceListItem> {
    const created = await InvoiceModel.create({
      invoiceNumber: input.invoiceNumber,
      kind: input.kind,
      status: input.status,
      accountId: new mongoose.Types.ObjectId(input.accountId),
      accountName: input.accountName,
      brandId: input.brandId,
      jobId: input.jobId ? new mongoose.Types.ObjectId(input.jobId) : null,
      jobNumber: input.jobNumber,
      poNumber: input.poNumber,
      issuedOn: input.issuedOn,
      dueOn: input.dueOn,
      paymentTermsDays: input.paymentTermsDays,
      subtotalExGst: toDecimal128(input.subtotalExGst),
      gst: toDecimal128(input.gst),
      totalIncGst: toDecimal128(input.totalIncGst),
      templateName: input.templateName,
      notes: input.notes,
      xeroState: 'not-synced',
    });

    if (input.lines.length > 0) {
      await InvoiceLineModel.insertMany(
        input.lines.map((line, position) => ({
          invoiceId: created._id,
          description: line.description,
          quantity: line.quantity,
          unitRate: toDecimal128(line.unitRate),
          amount: toDecimal128(line.amount),
          raisedBy: line.raisedBy,
          sourceChargeId: line.sourceChargeId
            ? new mongoose.Types.ObjectId(line.sourceChargeId)
            : null,
          position,
        })),
      );
    }

    return toListItem(created.toObject() as unknown as RawInvoice);
  },

  /** Removes an invoice and its lines. Compensation for a failed create. */
  async deleteCascade(invoiceId: string): Promise<void> {
    if (!mongoose.isValidObjectId(invoiceId)) return;
    const _id = new mongoose.Types.ObjectId(invoiceId);

    await Promise.all([
      InvoiceModel.deleteOne({ _id }),
      InvoiceLineModel.deleteMany({ invoiceId: _id }),
    ]);
  },

  /** Which kinds already exist for a job — the duplicate-billing guard. */
  async kindsForJob(jobId: string): Promise<InvoiceKind[]> {
    if (!mongoose.isValidObjectId(jobId)) return [];

    const rows = await InvoiceModel.find(
      { jobId: new mongoose.Types.ObjectId(jobId) },
      { kind: 1 },
    ).lean<Array<{ kind: InvoiceKind }>>();

    return rows.map((row) => row.kind);
  },

  /**
   * Moves invoices from one set of statuses to another, in bulk.
   *
   * ⚠️ `fromStatuses` is part of the FILTER, not checked beforehand. Bulk
   * actions arrive from a grid where the selection may be seconds stale, and
   * sending an invoice that has moved to `awaiting-po` in the meantime is
   * exactly what the queue exists to prevent. Returns how many actually moved.
   */
  async transitionMany(input: {
    ids: readonly string[];
    fromStatuses: InvoiceStatus[];
    to: InvoiceStatus;
    scope: InvoiceScope;
    set?: Record<string, unknown>;
    /** When set, only invoices that already carry a PO are moved. */
    requirePo?: boolean;
  }): Promise<number> {
    const ids = input.ids
      .filter((id) => mongoose.isValidObjectId(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (ids.length === 0) return 0;

    const filter: InvoiceFilter = {
      _id: { $in: ids },
      status: { $in: input.fromStatuses },
    };
    applyScope(filter, input.scope);

    if (input.requirePo) {
      // Approving without a PO would defeat the account's whole PO policy.
      filter.poNumber = { $nin: [null, ''] };
    }

    const result = await InvoiceModel.updateMany(filter, {
      $set: { status: input.to, ...input.set },
    });

    return result.modifiedCount;
  },

  /**
   * M7.3 — records the PO that unblocks an invoice, and releases it.
   *
   * One atomic update, because the PO arriving IS the exit condition from the
   * queue. Storing the number without moving the status would leave the row
   * sitting there with a PO printed beside it, which is how a queue stops being
   * trusted.
   */
  async recordPo(
    id: string,
    poNumber: string,
    scope: InvoiceScope,
  ): Promise<{ matched: boolean; jobId: string | null }> {
    if (!mongoose.isValidObjectId(id)) return { matched: false, jobId: null };

    const filter: InvoiceFilter = { _id: new mongoose.Types.ObjectId(id) };
    applyScope(filter, scope);

    const updated = await InvoiceModel.findOneAndUpdate(
      filter,
      [
        {
          $set: {
            poNumber,
            /*
             * `draft`, not `sent`: the PO unblocks the invoice, it does not post
             * it. Sending stays a deliberate act (M7.7). An invoice that was
             * never awaiting a PO keeps whatever status it had — recording a PO
             * on a sent invoice must not un-send it.
             */
            status: {
              $cond: [{ $eq: ['$status', 'awaiting-po'] }, 'draft', '$status'],
            },
          },
        },
      ],
      { returnDocument: 'after', projection: { jobId: 1 }, updatePipeline: true },
    ).lean<{ jobId: mongoose.Types.ObjectId | null }>();

    if (!updated) return { matched: false, jobId: null };
    return { matched: true, jobId: updated.jobId ? updated.jobId.toHexString() : null };
  },

  async recordXeroResult(input: {
    id: string;
    state: XeroSyncState;
    message: string | null;
    xeroInvoiceId?: string | null;
  }): Promise<boolean> {
    if (!mongoose.isValidObjectId(input.id)) return false;

    const result = await InvoiceModel.updateOne(
      { _id: new mongoose.Types.ObjectId(input.id) },
      {
        $set: {
          xeroState: input.state,
          xeroMessage: input.message,
          xeroLastSyncAt: new Date(),
          ...(input.xeroInvoiceId === undefined ? {} : { xeroInvoiceId: input.xeroInvoiceId }),
        },
      },
    );

    return result.matchedCount === 1;
  },

  /** Ids that exist and are in scope, for a bulk action's own reporting. */
  async existingIds(ids: readonly string[], scope: InvoiceScope): Promise<string[]> {
    const objectIds = ids
      .filter((id) => mongoose.isValidObjectId(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (objectIds.length === 0) return [];

    const filter: InvoiceFilter = { _id: { $in: objectIds } };
    applyScope(filter, scope);

    const rows = await InvoiceModel.find(filter, { _id: 1 }).lean<
      Array<{ _id: mongoose.Types.ObjectId }>
    >();

    return rows.map((row) => row._id.toHexString());
  },
};

/* ── Mapping ─────────────────────────────────────────────────────────────── */

function toListItem(row: RawInvoice): InvoiceListItem {
  return {
    id: row._id.toHexString(),
    invoiceNumber: row.invoiceNumber,
    kind: row.kind,
    status: row.status,
    brandId: row.brandId,
    accountId: row.accountId.toHexString(),
    accountName: row.accountName,
    jobId: row.jobId ? row.jobId.toHexString() : null,
    jobNumber: row.jobNumber,
    poNumber: row.poNumber,
    issuedOn: row.issuedOn,
    dueOn: row.dueOn,
    subtotalExGst: fromDecimal128(row.subtotalExGst),
    gst: fromDecimal128(row.gst),
    totalIncGst: fromDecimal128(row.totalIncGst),
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
  };
}

/* ── Filtering ───────────────────────────────────────────────────────────── */

/**
 * Folds the caller's scope into a filter.
 *
 * Applied LAST so a facet cannot overwrite it — `account` below is deliberately
 * ignored when a scope pins the account, because a customer nominating another
 * account's id must not widen their own view.
 */
function applyScope(filter: InvoiceFilter, scope: InvoiceScope): void {
  if (scope.accountId !== null) {
    filter.accountId = new mongoose.Types.ObjectId(scope.accountId);
  }
}

function buildFilter(query: ListInvoicesQuery, scope: InvoiceScope): InvoiceFilter {
  const filter: InvoiceFilter = {};

  if (query.q) filter.$text = { $search: query.q };
  if (query.status) filter.status = query.status;
  if (query.kind) filter.kind = query.kind;
  if (query.brandId) filter.brandId = query.brandId;
  if (query.xeroState) filter.xeroState = query.xeroState;

  if (query.account && mongoose.isValidObjectId(query.account)) {
    filter.accountId = new mongoose.Types.ObjectId(query.account);
  }

  if (query.issuedWindow) {
    const window = resolveWindow(query.issuedWindow);
    if (window) filter.issuedOn = window;
  }

  applyScope(filter, scope);
  return filter;
}

function today(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}

function shiftDays(days: number): string {
  const now = new Date();
  now.setDate(now.getDate() + days);
  return now.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}

/** Relative windows, matching how the office phrases a filter. */
function resolveWindow(window: string): { $gte?: string; $lte?: string } | null {
  switch (window) {
    case 'today':
      return { $gte: today(), $lte: today() };
    case 'last-7':
      return { $gte: shiftDays(-7), $lte: today() };
    case 'last-30':
      return { $gte: shiftDays(-30), $lte: today() };
    case 'last-90':
      return { $gte: shiftDays(-90), $lte: today() };
    default:
      return null;
  }
}
