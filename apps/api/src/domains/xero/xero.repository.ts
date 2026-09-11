import mongoose from 'mongoose';
import { InvoiceModel } from '../invoices/invoice.model.js';
import { XeroConnectionModel, XeroOAuthStateModel } from './xero.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 *
 * ⚠️ Nothing here decrypts. The sealed token strings pass through untouched
 * and `xero.service.ts` opens them, so the set of places a plaintext refresh
 * token can exist stays as small as it can be — and so a `.lean()` row logged
 * during debugging cannot contain one.
 */

/** The singleton's fixed key. Mirrors `settings`. */
const SINGLETON = 'singleton';

export interface XeroConnectionRow {
  tenantId: string;
  connectionId: string;
  tenantName: string;
  accessTokenSealed: string;
  refreshTokenSealed: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  status: 'connected' | 'needs-reconnect';
  statusMessage: string | null;
  connectedByName: string;
  connectedAt: Date;
  lastRefreshAt: Date | null;
}

export interface SaveConnectionInput {
  tenantId: string;
  connectionId: string;
  tenantName: string;
  accessTokenSealed: string;
  refreshTokenSealed: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  connectedByUserId: string;
  connectedByName: string;
}

/** One invoice, flattened to exactly what a Xero push needs. */
export interface PushableInvoice {
  id: string;
  invoiceNumber: number;
  accountId: string;
  status: string;
  poNumber: string | null;
  /**
   * Plain `YYYY-MM-DD`, carried through as a string on purpose.
   *
   * An invoice date is a calendar day, and Xero wants exactly this format.
   * Parsing it into a `Date` here and formatting it back would round-trip a
   * Sydney calendar day through UTC — which lands an invoice raised after 10am
   * AEST on the previous day in Xero. See `lib/business-day.ts`.
   */
  issuedOn: string | null;
  dueOn: string | null;
  xeroInvoiceId: string | null;
}

export const xeroRepository = {
  /* ── The connection ──────────────────────────────────────────────────── */

  async findConnection(): Promise<XeroConnectionRow | null> {
    const row = await XeroConnectionModel.findById(SINGLETON).lean();
    if (!row) return null;

    return {
      tenantId: row.tenantId,
      connectionId: row.connectionId,
      tenantName: row.tenantName,
      accessTokenSealed: row.accessTokenSealed,
      refreshTokenSealed: row.refreshTokenSealed,
      accessExpiresAt: row.accessExpiresAt,
      refreshExpiresAt: row.refreshExpiresAt,
      status: row.status,
      statusMessage: row.statusMessage ?? null,
      connectedByName: row.connectedByName,
      connectedAt: row.connectedAt,
      lastRefreshAt: row.lastRefreshAt ?? null,
    };
  },

  /**
   * Writes the connection, replacing whatever was there.
   *
   * An upsert rather than a create: reconnecting is the normal repair for
   * every failure mode in this integration, and a reconnect that failed
   * because a stale row already existed would make the one recovery path the
   * page offers the one thing that does not work.
   */
  async saveConnection(input: SaveConnectionInput): Promise<void> {
    await XeroConnectionModel.updateOne(
      { _id: SINGLETON },
      {
        $set: {
          tenantId: input.tenantId,
          connectionId: input.connectionId,
          tenantName: input.tenantName,
          accessTokenSealed: input.accessTokenSealed,
          refreshTokenSealed: input.refreshTokenSealed,
          accessExpiresAt: input.accessExpiresAt,
          refreshExpiresAt: input.refreshExpiresAt,
          connectedByUserId: new mongoose.Types.ObjectId(input.connectedByUserId),
          connectedByName: input.connectedByName,
          connectedAt: new Date(),
          status: 'connected',
          statusMessage: null,
          lastRefreshAt: null,
        },
      },
      { upsert: true },
    );
  },

  /**
   * Stores a rotated token pair.
   *
   * ⚠️ Separate from `saveConnection` on purpose. A refresh must NOT touch
   * `connectedBy` or `connectedAt` — those record who authorised the
   * connection, and a background refresh overwriting them would credit the
   * grant to whichever request happened to trigger the renewal, or to nobody.
   */
  async updateTokens(input: {
    accessTokenSealed: string;
    refreshTokenSealed: string;
    accessExpiresAt: Date;
    refreshExpiresAt: Date;
  }): Promise<void> {
    await XeroConnectionModel.updateOne(
      { _id: SINGLETON },
      {
        $set: {
          accessTokenSealed: input.accessTokenSealed,
          refreshTokenSealed: input.refreshTokenSealed,
          accessExpiresAt: input.accessExpiresAt,
          refreshExpiresAt: input.refreshExpiresAt,
          lastRefreshAt: new Date(),
          status: 'connected',
          statusMessage: null,
        },
      },
    );
  },

  /**
   * Flags the connection as unusable without deleting it.
   *
   * The row is kept so the page can still name the organisation and say when
   * it was connected. Deleting it would replace a specific, actionable message
   * — "Xero revoked this on the 3rd, reconnect" — with a bare Connect button
   * that looks like it was never set up.
   */
  async markNeedsReconnect(message: string): Promise<void> {
    await XeroConnectionModel.updateOne(
      { _id: SINGLETON },
      { $set: { status: 'needs-reconnect', statusMessage: message } },
    );
  },

  async deleteConnection(): Promise<void> {
    await XeroConnectionModel.deleteOne({ _id: SINGLETON });
  },

  /* ── The OAuth handshake ─────────────────────────────────────────────── */

  async createState(input: {
    state: string;
    startedByUserId: string;
    startedByName: string;
    expiresAt: Date;
  }): Promise<void> {
    await XeroOAuthStateModel.create({
      state: input.state,
      startedByUserId: new mongoose.Types.ObjectId(input.startedByUserId),
      startedByName: input.startedByName,
      expiresAt: input.expiresAt,
    });
  },

  /**
   * Reads and destroys one state in a single operation.
   *
   * ⚠️ `findOneAndDelete`, not find-then-delete. It makes the state
   * single-use atomically, so two callbacks arriving with the same value —
   * a double-clicked Allow button, or a replayed URL — cannot both succeed.
   * Find-then-delete has a window between the two calls where they can.
   */
  async consumeState(state: string): Promise<{ userId: string; name: string; expiresAt: Date } | null> {
    const row = await XeroOAuthStateModel.findOneAndDelete({ state }).lean();
    if (!row) return null;

    return {
      userId: row.startedByUserId.toHexString(),
      name: row.startedByName,
      expiresAt: row.expiresAt,
    };
  },

  /* ── Invoices, for the push and the payment sweep ────────────────────── */

  /**
   * One invoice's push-relevant fields.
   *
   * Deliberately NOT `invoiceRepository.findById`: that one applies a caller's
   * scope, and the sweep runs with no caller at all. Passing a synthetic
   * "system" scope into a scoped read is how row-level security quietly stops
   * meaning anything, so this reads the narrow projection it actually needs.
   */
  async findPushable(id: string): Promise<PushableInvoice | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    const row = await InvoiceModel.findById(new mongoose.Types.ObjectId(id)).lean();
    if (!row) return null;

    return toPushable(row);
  },

  /**
   * Invoices that are in Xero and might have been paid since we last looked.
   *
   * Bounded by `limit` because this feeds a batched read against a rate-limited
   * API — an unbounded sweep on a busy month would exhaust the daily allowance
   * in one pass and take the invoice push down with it.
   */
  async findAwaitingPayment(limit: number): Promise<PushableInvoice[]> {
    const rows = await InvoiceModel.find({
      xeroState: 'synced',
      xeroInvoiceId: { $ne: null },
      // `paid` is terminal and `draft`/`awaiting-po` were never pushed.
      status: { $in: ['sent', 'overdue'] },
    })
      .sort({ xeroLastSyncAt: 1 })
      .limit(limit)
      .lean();

    return rows.map(toPushable);
  },

  /** Marks an invoice paid once Xero says it is. */
  async markPaid(id: string, paidAt: Date): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;

    const result = await InvoiceModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { status: 'paid', paidAt, xeroLastSyncAt: new Date() } },
    );

    return result.matchedCount === 1;
  },

  /**
   * Stamps the sweep's own timestamp on an invoice Xero says is still unpaid.
   *
   * Without this the sort in `findAwaitingPayment` never advances and the same
   * few invoices are re-read every sweep while the rest are never reached.
   */
  async touchSynced(ids: readonly string[]): Promise<void> {
    const objectIds = ids
      .filter((id) => mongoose.isValidObjectId(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (objectIds.length === 0) return;

    await InvoiceModel.updateMany(
      { _id: { $in: objectIds } },
      { $set: { xeroLastSyncAt: new Date() } },
    );
  },
};

interface RawPushable {
  _id: mongoose.Types.ObjectId;
  invoiceNumber: number;
  accountId: mongoose.Types.ObjectId;
  status: string;
  poNumber?: string | null;
  issuedOn?: string | null;
  dueOn?: string | null;
  xeroInvoiceId?: string | null;
}

function toPushable(row: RawPushable): PushableInvoice {
  return {
    id: row._id.toHexString(),
    invoiceNumber: row.invoiceNumber,
    accountId: row.accountId.toHexString(),
    status: row.status,
    poNumber: row.poNumber ?? null,
    issuedOn: row.issuedOn ?? null,
    dueOn: row.dueOn ?? null,
    xeroInvoiceId: row.xeroInvoiceId ?? null,
  };
}
