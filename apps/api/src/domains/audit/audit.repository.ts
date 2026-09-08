import type {
  AuditAction,
  AuditChange,
  AuditEntity,
  AuditEntry,
  PageMeta,
  Role,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { startOfToday } from '../../lib/business-day.js';
import { AuditEntryModel } from './audit.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 *
 * ⚠️ Notice what is missing: there is no update, no delete, and no upsert. That
 * is the whole point of M1.6, and it is enforced here by omission as well as by
 * the middleware in the model — two independent barriers, because the cost of
 * getting this wrong is a log nobody can rely on in the one argument it exists
 * to settle.
 */

export interface ListAuditQuery {
  page: number;
  pageSize: number;
  sort?: string | undefined;
  q?: string | undefined;
  actor?: string | undefined;
  action?: AuditAction | undefined;
  entity?: AuditEntity | undefined;
  entityId?: string | undefined;
  /** Relative windows, matching the screen's own filter chips. */
  window?: 'today' | 'last-24h' | 'last-7d' | 'last-30d' | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export interface RecordAuditInput {
  at?: Date;
  actorId: string | null;
  actorName: string;
  actorRole: Role | null;
  action: AuditAction;
  entity: AuditEntity;
  entityId: string | null;
  entityLabel: string;
  summary: string;
  changes?: AuditChange[];
  href?: string;
  device?: string | null;
  source?: 'application' | 'change-stream';
}

interface RawEntry {
  _id: mongoose.Types.ObjectId;
  at: Date;
  actorId: mongoose.Types.ObjectId | null;
  actorName: string;
  actorRole: Role | null;
  action: AuditAction;
  entity: AuditEntity;
  entityId: mongoose.Types.ObjectId | null;
  entityLabel: string;
  summary: string;
  changes: Array<{ field: string; from: string | null; to: string | null }>;
  href: string;
  device: string | null;
}

/** Only these may be sorted on. An open sort is an unindexed scan waiting. */
const SORTABLE: Record<string, string> = {
  at: 'at',
  actorName: 'actorName',
  entity: 'entity',
  action: 'action',
};

export const auditRepository = {
  /**
   * Appends one entry. The only write in this domain.
   *
   * ── Why it never throws ───────────────────────────────────────────────────
   * It does throw, and callers must not let it escape. Failing to WRITE the
   * audit row must not fail the action being audited — refusing to complete a
   * job because the log was briefly unreachable trades a small accountability
   * gap for an operational outage, which is the wrong way round. The service
   * wraps this and logs loudly; see `audit.service.ts`.
   */
  async record(input: RecordAuditInput): Promise<AuditEntry> {
    const created = await AuditEntryModel.create({
      at: input.at ?? new Date(),
      actorId: toObjectId(input.actorId),
      actorName: input.actorName,
      actorRole: input.actorRole,
      action: input.action,
      entity: input.entity,
      entityId: toObjectId(input.entityId),
      entityLabel: input.entityLabel,
      summary: input.summary,
      changes: input.changes ?? [],
      href: input.href ?? '',
      device: input.device ?? null,
      source: input.source ?? 'application',
    });

    return toEntry(created.toObject() as RawEntry);
  },

  async list(query: ListAuditQuery): Promise<{ data: AuditEntry[]; meta: PageMeta }> {
    const filter = buildFilter(query);

    const sortKey = query.sort?.replace(/^-/, '') ?? '';
    const sortField = SORTABLE[sortKey];
    const direction: 1 | -1 = query.sort?.startsWith('-') ? -1 : 1;

    /*
     * Newest first by default, and `at` descending as the tiebreak on every
     * other sort. An audit log is read backwards from now, and two entries with
     * the same actor name must not swap places between page 1 and page 2 —
     * which is exactly what an unstable sort does to a paged grid.
     */
    const sort: Record<string, 1 | -1> = sortField
      ? sortField === 'at'
        ? { at: direction, _id: direction }
        : { [sortField]: direction, at: -1, _id: -1 }
      : { at: -1, _id: -1 };

    const [rows, total] = await Promise.all([
      AuditEntryModel.find(filter)
        .sort(sort)
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean<RawEntry[]>(),
      AuditEntryModel.countDocuments(filter),
    ]);

    return {
      data: rows.map(toEntry),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  },

  async findById(id: string): Promise<AuditEntry | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    const row = await AuditEntryModel.findById(id).lean<RawEntry>();

    return row ? toEntry(row) : null;
  },

  /**
   * Has the application already claimed a change to this entity, at about this
   * time?
   *
   * Used only by the change-stream backstop, to avoid recording a second,
   * actor-less copy of something a service already logged properly.
   *
   * ⚠️ This is a heuristic and is documented as one. Two writes to the same
   * document inside the window, only one of them recorded, will look covered.
   * That is an acceptable miss for a mechanism whose job is "notice database
   * activity nobody claimed" — the alternative, threading a correlation id from
   * every service call through the oplog, buys precision the backstop does not
   * need at the cost of touching every write in the system.
   */
  async hasRecentEntry(
    entity: AuditEntity,
    entityId: string | null,
    at: Date,
    windowMs: number,
  ): Promise<boolean> {
    const found = await AuditEntryModel.exists({
      entity,
      entityId: toObjectId(entityId),
      source: 'application',
      at: { $gte: new Date(at.getTime() - windowMs), $lte: new Date(at.getTime() + windowMs) },
    });

    return found !== null;
  },

  /** Diagnostics: how much of the log is unattributed. */
  async countBySource(): Promise<{ application: number; changeStream: number }> {
    const rows = await AuditEntryModel.aggregate<{ _id: string; count: number }>([
      { $group: { _id: '$source', count: { $sum: 1 } } },
    ]);

    const bySource = new Map(rows.map((row) => [row._id, row.count]));

    return {
      application: bySource.get('application') ?? 0,
      changeStream: bySource.get('change-stream') ?? 0,
    };
  },
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function buildFilter(query: ListAuditQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {};

  if (query.action) filter.action = query.action;
  if (query.entity) filter.entity = query.entity;

  if (query.actor && mongoose.isValidObjectId(query.actor)) {
    filter.actorId = new mongoose.Types.ObjectId(query.actor);
  }

  if (query.entityId && mongoose.isValidObjectId(query.entityId)) {
    filter.entityId = new mongoose.Types.ObjectId(query.entityId);
  }

  const range = timeRange(query);
  if (range) filter.at = range;

  if (query.q) {
    const term = escapeRegex(query.q);
    /*
     * Searched across the three FROZEN text fields. Deliberately not across
     * `changes` — "19 Aug" appears in a hundred rows as a target date, and a
     * search that matches everything is a search nobody uses twice.
     */
    filter.$or = [
      { actorName: { $regex: term, $options: 'i' } },
      { entityLabel: { $regex: term, $options: 'i' } },
      { summary: { $regex: term, $options: 'i' } },
    ];
  }

  return filter;
}

/**
 * The window chips, plus an explicit from/to.
 *
 * `today` is the SYDNEY day (see `lib/business-day.ts`) — an audit log that
 * starts "today" at 10am local is one an administrator cannot use in the
 * morning, which is when an overnight question gets asked.
 */
function timeRange(query: ListAuditQuery): Record<string, Date> | null {
  const bounds: Record<string, Date> = {};

  if (query.window) {
    const now = Date.now();
    const hours: Record<string, number> = { 'last-24h': 24, 'last-7d': 168, 'last-30d': 720 };

    if (query.window === 'today') {
      bounds.$gte = startOfToday();
    } else {
      const span = hours[query.window];
      if (span !== undefined) bounds.$gte = new Date(now - span * 3_600_000);
    }
  }

  // An explicit range wins over a chip: it is the more specific request.
  if (query.from) {
    const from = new Date(query.from);
    if (!Number.isNaN(from.getTime())) bounds.$gte = from;
  }

  if (query.to) {
    const to = new Date(query.to);
    if (!Number.isNaN(to.getTime())) bounds.$lte = to;
  }

  return Object.keys(bounds).length > 0 ? bounds : null;
}

function toEntry(row: RawEntry): AuditEntry {
  return {
    id: row._id.toHexString(),
    at: row.at.toISOString(),
    actorId: row.actorId ? row.actorId.toHexString() : null,
    actorName: row.actorName,
    actorRole: row.actorRole,
    action: row.action,
    entity: row.entity,
    entityId: row.entityId ? row.entityId.toHexString() : null,
    entityLabel: row.entityLabel,
    summary: row.summary,
    changes: row.changes.map((change) => ({
      field: change.field,
      from: change.from,
      to: change.to,
    })),
    href: row.href,
    device: row.device,
  };
}

function toObjectId(value: string | null): mongoose.Types.ObjectId | null {
  if (!value || !mongoose.isValidObjectId(value)) return null;
  return new mongoose.Types.ObjectId(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

