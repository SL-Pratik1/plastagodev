import type {
  Notification,
  NotificationCategory,
  NotificationSeverity,
  NotificationSummary,
  PageMeta,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { fromDecimal128, toDecimal128 } from '../../lib/money.js';
import { UserModel } from '../auth/auth.model.js';
import { NotificationModel, OutboundMessageModel } from './notification.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 */

export interface ListNotificationsQuery {
  page: number;
  pageSize: number;
  category?: NotificationCategory | undefined;
  severity?: NotificationSeverity | undefined;
  /** Only what still needs acting on — the default view. */
  unreadOnly?: boolean | undefined;
}

export interface RaiseNotificationInput {
  userId: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  title: string;
  body: string;
  href: string;
  subjectKey: string;
  valueExGst?: string | null;
  jobId?: string | null;
  jobNumber?: number | null;
}

interface RawNotification {
  _id: mongoose.Types.ObjectId;
  category: NotificationCategory;
  severity: NotificationSeverity;
  title: string;
  body: string;
  at: Date;
  readAt: Date | null;
  href: string;
  valueExGst: mongoose.Types.Decimal128 | null;
  jobId: mongoose.Types.ObjectId | null;
  jobNumber: number | null;
}

function toNotification(row: RawNotification): Notification {
  return {
    id: row._id.toHexString(),
    category: row.category,
    severity: row.severity,
    title: row.title,
    body: row.body,
    at: row.at.toISOString(),
    readAt: row.readAt ? row.readAt.toISOString() : null,
    href: row.href,
    valueExGst: row.valueExGst ? fromDecimal128(row.valueExGst) : null,
    jobId: row.jobId ? row.jobId.toHexString() : null,
    jobNumber: row.jobNumber,
  };
}

/** Severity, worst first — the order the inbox is worked in. */
const SEVERITY_RANK: Record<NotificationSeverity, number> = { urgent: 0, action: 1, info: 2 };

export const notificationRepository = {
  /**
   * One person's inbox.
   *
   * ⚠️ `userId` is in the FILTER, always. There is no route that takes one, so
   * a caller can only ever read their own — see the router.
   */
  async list(
    userId: string,
    query: ListNotificationsQuery,
  ): Promise<{ data: Notification[]; meta: PageMeta }> {
    if (!mongoose.isValidObjectId(userId)) {
      return {
        data: [],
        meta: { page: query.page, pageSize: query.pageSize, total: 0, totalPages: 1 },
      };
    }

    const filter: Record<string, unknown> = { userId: new mongoose.Types.ObjectId(userId) };

    if (query.category) filter.category = query.category;
    if (query.severity) filter.severity = query.severity;
    if (query.unreadOnly) filter.readAt = null;

    const [rows, total] = await Promise.all([
      NotificationModel.find(filter)
        .sort({ at: -1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean<RawNotification[]>(),
      NotificationModel.countDocuments(filter),
    ]);

    /*
     * Sorted by severity WITHIN the page rather than in the query.
     *
     * A pure severity sort would bury a fresh urgent item behind a month of old
     * ones; a pure date sort puts an unroadworthy truck below a digest. Newest
     * first from the database, worst first on the page, is the compromise that
     * matches how somebody actually scans an inbox.
     */
    const sorted = [...rows].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
    );

    return {
      data: sorted.map(toNotification),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  },

  /** The badge. Two counts, nothing else — the shell polls this. */
  async summary(userId: string): Promise<NotificationSummary> {
    if (!mongoose.isValidObjectId(userId)) return { unread: 0, urgent: 0 };

    const objectId = new mongoose.Types.ObjectId(userId);

    const [unread, urgent] = await Promise.all([
      NotificationModel.countDocuments({ userId: objectId, readAt: null }),
      NotificationModel.countDocuments({ userId: objectId, readAt: null, severity: 'urgent' }),
    ]);

    return { unread, urgent };
  },

  /**
   * Raises one, or refreshes the existing one for the same subject.
   *
   * ⚠️ Upserted on `(userId, subjectKey)`. A nightly digest that runs twice, or
   * a queue still holding the same row tomorrow, must not produce a second copy
   * — a centre that repeats itself is one nobody reads.
   *
   * `$setOnInsert` on `at` and `readAt`: re-raising updates the WORDING (the
   * count may have changed) but does not resurface something already read, and
   * does not move it to the top of the inbox as though it were new.
   */
  async raise(input: RaiseNotificationInput): Promise<void> {
    if (!mongoose.isValidObjectId(input.userId)) return;

    await NotificationModel.updateOne(
      {
        userId: new mongoose.Types.ObjectId(input.userId),
        subjectKey: input.subjectKey,
      },
      {
        $set: {
          category: input.category,
          severity: input.severity,
          title: input.title,
          body: input.body,
          href: input.href,
          valueExGst:
            input.valueExGst === undefined || input.valueExGst === null
              ? null
              : toDecimal128(input.valueExGst),
          jobId: input.jobId ? new mongoose.Types.ObjectId(input.jobId) : null,
          jobNumber: input.jobNumber ?? null,
        },
        $setOnInsert: {
          userId: new mongoose.Types.ObjectId(input.userId),
          subjectKey: input.subjectKey,
          at: new Date(),
          readAt: null,
        },
      },
      { upsert: true },
    );
  },

  /**
   * Marks a batch read.
   *
   * `readAt: null` is in the filter so a second click does not move the
   * timestamp — when it was read is part of the record.
   */
  async markRead(userId: string, ids: readonly string[]): Promise<number> {
    const objectIds = ids
      .filter((id) => mongoose.isValidObjectId(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (objectIds.length === 0 || !mongoose.isValidObjectId(userId)) return 0;

    const result = await NotificationModel.updateMany(
      {
        _id: { $in: objectIds },
        // Somebody else's notification is not theirs to mark read.
        userId: new mongoose.Types.ObjectId(userId),
        readAt: null,
      },
      { $set: { readAt: new Date() } },
    );

    return result.modifiedCount;
  },

  async markAllRead(userId: string): Promise<number> {
    if (!mongoose.isValidObjectId(userId)) return 0;

    const result = await NotificationModel.updateMany(
      { userId: new mongoose.Types.ObjectId(userId), readAt: null },
      { $set: { readAt: new Date() } },
    );

    return result.modifiedCount;
  },

  /** Everyone who should receive office alerts. */
  async officeRecipients(): Promise<Array<{ id: string; name: string }>> {
    const rows = await UserModel.find(
      {
        status: 'active',
        roles: { $in: ['super-admin', 'operations', 'office-staff'] },
      },
      { name: 1 },
    ).lean<Array<{ _id: mongoose.Types.ObjectId; name: string }>>();

    return rows.map((row) => ({ id: row._id.toHexString(), name: row.name }));
  },

  /* ── M8.1 / M8.2 · the outbound log ────────────────────────────────────── */

  /**
   * Records a send. Returns false when this subject already went out.
   *
   * ⚠️ The de-duplication happens HERE, on a unique index, rather than by the
   * caller checking first — two workers running the same sweep would both pass
   * a check and both send. A reminder sent twice is worse than one sent late:
   * the customer stops reading them.
   */
  async recordSend(input: {
    event: string;
    channel: 'email' | 'sms';
    toMasked: string;
    subject: string;
    accountId: string | null;
    jobId: string | null;
    invoiceId: string | null;
    outcome: 'sent' | 'failed' | 'skipped';
    detail: string | null;
    subjectKey: string;
  }): Promise<boolean> {
    try {
      await OutboundMessageModel.create({
        event: input.event,
        channel: input.channel,
        toMasked: input.toMasked,
        subject: input.subject,
        accountId: input.accountId ? new mongoose.Types.ObjectId(input.accountId) : null,
        jobId: input.jobId ? new mongoose.Types.ObjectId(input.jobId) : null,
        invoiceId: input.invoiceId ? new mongoose.Types.ObjectId(input.invoiceId) : null,
        sentAt: new Date(),
        outcome: input.outcome,
        detail: input.detail,
        subjectKey: input.subjectKey,
      });

      return true;
    } catch (error) {
      // A duplicate key means somebody already sent it — the correct outcome,
      // not an error the caller needs to handle.
      if (isDuplicateKey(error)) return false;
      throw error;
    }
  },

  /** Whether this subject has already gone out on this channel. */
  async alreadySent(subjectKey: string, channel: 'email' | 'sms'): Promise<boolean> {
    return (await OutboundMessageModel.countDocuments({ subjectKey, channel })) > 0;
  },

  /** What went to one customer — the question support actually asks. */
  async sendsForAccount(
    accountId: string,
    limit: number,
  ): Promise<Array<{ event: string; channel: string; toMasked: string; sentAt: Date; outcome: string }>> {
    if (!mongoose.isValidObjectId(accountId)) return [];

    const rows = await OutboundMessageModel.find({
      accountId: new mongoose.Types.ObjectId(accountId),
    })
      .sort({ sentAt: -1 })
      .limit(limit)
      .lean();

    return rows.map((row) => ({
      event: row.event,
      channel: row.channel,
      toMasked: row.toMasked,
      sentAt: row.sentAt,
      outcome: row.outcome,
    }));
  },
};

/** Mongo's duplicate-key error, whatever wrapper it arrives in. */
function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: number }).code === 11_000
  );
}
