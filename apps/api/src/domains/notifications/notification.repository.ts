import type {
  Notification,
  NotificationCategory,
  NotificationSeverity,
  NotificationSummary,
  PageMeta,
  Role,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { fromDecimal128, toDecimal128 } from '../../lib/money.js';
import { UserModel } from '../auth/auth.model.js';
import {
  NotificationModel,
  OutboundMessageModel,
  ScheduledRunModel,
} from './notification.model.js';

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

/** Somebody a notification is raised for. The email is for the message that may follow it. */
export interface NotificationRecipient {
  id: string;
  name: string;
  email: string | null;
  /**
   * Every role they hold. Carried for staff so one alert can link each person
   * to a screen THEY can open — an allocator cannot open the queues.
   */
  roles?: readonly Role[];
}

/** Who `officeRecipients` means when it is not told — the three office roles. */
const DEFAULT_OFFICE_ROLES: readonly Role[] = ['super-admin', 'operations', 'office-staff'];

interface RawRecipient {
  _id: mongoose.Types.ObjectId;
  name: string;
  email?: string | null;
  roles?: Role[];
}

function toRecipient(row: RawRecipient): NotificationRecipient {
  return {
    id: row._id.toHexString(),
    name: row.name,
    email: row.email ?? null,
    ...(row.roles ? { roles: row.roles } : {}),
  };
}

/**
 * Active customer administrators on the account, plus — when named — the one
 * site supervisor who booked the job. See `jobAudience`.
 */
async function customerRecipients(
  accountId: string,
  bookedByUserId: string | null,
): Promise<NotificationRecipient[]> {
  if (!mongoose.isValidObjectId(accountId)) return [];

  const booker =
    bookedByUserId !== null && mongoose.isValidObjectId(bookedByUserId)
      ? [
          {
            _id: new mongoose.Types.ObjectId(bookedByUserId),
            roles: { $in: ['customer-site-supervisor' as const] },
          },
        ]
      : [];

  const rows = await UserModel.find(
    {
      status: 'active',
      accountId: new mongoose.Types.ObjectId(accountId),
      $or: [{ roles: { $in: ['customer-administrator' as const] } }, ...booker],
    },
    { name: 1, email: 1 },
  ).lean<RawRecipient[]>();

  return rows.map(toRecipient);
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

  /**
   * Active staff holding any of `roles` — by default the three office roles.
   *
   * The roles are handed back with each person because some alerts link
   * different people to different screens: see `notifyOffice`.
   */
  async officeRecipients(
    roles: readonly Role[] = DEFAULT_OFFICE_ROLES,
  ): Promise<NotificationRecipient[]> {
    const rows = await UserModel.find(
      { status: 'active', roles: { $in: [...roles] } },
      { name: 1, email: 1, roles: 1 },
    ).lean<RawRecipient[]>();

    return rows.map(toRecipient);
  },

  /**
   * How to reach one member of staff directly — a driver, for a text about a
   * job on their run. Null when they no longer exist or cannot sign in.
   */
  async staffContact(
    userId: string,
  ): Promise<{ id: string; name: string; email: string | null; mobile: string | null } | null> {
    if (!mongoose.isValidObjectId(userId)) return null;

    const row = await UserModel.findOne(
      { _id: new mongoose.Types.ObjectId(userId), status: { $ne: 'suspended' } },
      { name: 1, email: 1, phoneNumber: 1 },
    ).lean<{
      _id: mongoose.Types.ObjectId;
      name: string;
      email?: string | null;
      phoneNumber?: string | null;
    }>();

    if (!row) return null;

    return {
      id: row._id.toHexString(),
      name: row.name,
      email: row.email ?? null,
      mobile: row.phoneNumber ?? null,
    };
  },

  /* ── The schedule's own record (see `ScheduledRunModel`) ───────────────── */

  /**
   * Claims one occurrence of a scheduled task. True means "you run it".
   *
   * ⚠️ The insert IS the lock, for the reason `claimSend` gives: two processes
   * checking first would both see nothing and both run. A failed attempt, or
   * one abandoned mid-run (the process died), is taken over rather than left
   * to block the slot — but only a few times, so a task that fails every time
   * stops being retried every five minutes all day.
   */
  async claimScheduledRun(task: string, slot: string, now: Date = new Date()): Promise<boolean> {
    try {
      await ScheduledRunModel.create({ task, slot, state: 'running', attempts: 1, claimedAt: now });
      return true;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;

      const abandonedBefore = new Date(now.getTime() - ABANDONED_AFTER_MS);
      const taken = await ScheduledRunModel.updateOne(
        {
          task,
          slot,
          attempts: { $lt: MAX_SCHEDULED_ATTEMPTS },
          $or: [{ state: 'failed' }, { state: 'running', claimedAt: { $lt: abandonedBefore } }],
        },
        { $set: { state: 'running', claimedAt: now, finishedAt: null }, $inc: { attempts: 1 } },
      ).exec();

      return taken.modifiedCount > 0;
    }
  },

  /** Records how a claimed run ended. */
  async finishScheduledRun(
    task: string,
    slot: string,
    state: 'done' | 'failed',
    detail: string | null,
  ): Promise<void> {
    await ScheduledRunModel.updateOne(
      { task, slot },
      { $set: { state, detail, finishedAt: new Date() } },
    ).exec();
  },

  /**
   * The portal users who can SEE one job: every customer administrator on the
   * account, plus the site supervisor who booked it.
   *
   * ── Why there is no "everyone on the account" list any more ──────────────
   * There was one, and every customer notice used it — so every supervisor on
   * an account was told about every pickup: "Pickup booked — Lot 88", "Invoice
   * INV-1042 — $245.52". A site supervisor sees only the pickups they booked
   * (M1.5), and never a price. Each notice put a site, and sometimes an amount,
   * in front of people the portal itself refuses to show it to, with a link that
   * 404s for them. A job's notice goes to this audience; anything about money
   * goes to `accountAdministrators`.
   *
   * ⚠️ Filtered to customer roles as well as the account. A staff record
   * carrying an `accountId` would otherwise be handed a notification written for
   * the customer's eyes, which is the same disclosure in the other direction.
   */
  async jobAudience(
    accountId: string,
    bookedByUserId: string | null,
  ): Promise<NotificationRecipient[]> {
    return customerRecipients(accountId, bookedByUserId);
  },

  /**
   * The account's customer administrators — the only portal users who may see
   * invoices and prices (M1.5).
   */
  async accountAdministrators(accountId: string): Promise<NotificationRecipient[]> {
    return customerRecipients(accountId, null);
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

  /**
   * Whether this subject has already gone out SUCCESSFULLY on this channel.
   *
   * ⚠️ `outcome: 'sent'` is part of the filter deliberately. A row recording a
   * failure means the customer did NOT get the message, so treating it as
   * "already sent" would turn one mail-server hiccup into a reminder that never
   * arrives — and nobody would ever find out, because the log would say we had
   * dealt with it.
   */
  async alreadySent(subjectKey: string, channel: 'email' | 'sms'): Promise<boolean> {
    return (
      (await OutboundMessageModel.countDocuments({ subjectKey, channel, outcome: 'sent' })) > 0
    );
  },

  /**
   * Claims the right to send, before sending.
   *
   * ── Why claim first rather than record afterwards ──────────────────────────
   * Two workers running the same sweep would both read "not sent yet", both
   * send, and the customer would get the message twice. The unique index on
   * `(subjectKey, channel)` is the only thing that can arbitrate that, and it
   * can only arbitrate a write — so the write happens first and the loser of
   * the race sends nothing.
   *
   * A previous FAILURE is not a claim: its row is taken over and retried, which
   * is what makes a transient provider outage recoverable rather than
   * permanent. The caller must follow up with `markSendOutcome` when the
   * provider answers, so a row that says `sent` means the provider accepted it.
   */
  async claimSend(input: {
    event: string;
    channel: 'email' | 'sms';
    toMasked: string;
    subject: string;
    accountId: string | null;
    jobId: string | null;
    invoiceId: string | null;
    subjectKey: string;
  }): Promise<boolean> {
    const document = {
      event: input.event,
      channel: input.channel,
      toMasked: input.toMasked,
      subject: input.subject,
      accountId: input.accountId ? new mongoose.Types.ObjectId(input.accountId) : null,
      jobId: input.jobId ? new mongoose.Types.ObjectId(input.jobId) : null,
      invoiceId: input.invoiceId ? new mongoose.Types.ObjectId(input.invoiceId) : null,
      sentAt: new Date(),
      outcome: 'sent' as const,
      detail: null,
      subjectKey: input.subjectKey,
    };

    try {
      await OutboundMessageModel.create(document);
      return true;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;

      /*
       * Somebody holds the row. Take it over only if their attempt did not
       * reach the recipient — an `outcome: 'sent'` row is a genuine duplicate
       * and must stay untouched.
       */
      const taken = await OutboundMessageModel.updateOne(
        { subjectKey: input.subjectKey, channel: input.channel, outcome: { $ne: 'sent' } },
        { $set: document },
      ).exec();

      return taken.modifiedCount > 0;
    }
  },

  /** Records what the provider actually did with a claimed send. */
  async markSendOutcome(
    subjectKey: string,
    channel: 'email' | 'sms',
    outcome: 'sent' | 'failed' | 'skipped',
    detail: string | null,
  ): Promise<void> {
    await OutboundMessageModel.updateOne(
      { subjectKey, channel },
      { $set: { outcome, detail } },
    ).exec();
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

/** A scheduled slot is tried this many times at most — a broken task is not retried all day. */
const MAX_SCHEDULED_ATTEMPTS = 3;

/**
 * A run still "running" after this long was abandoned — the process died under
 * it. Far longer than any real run: the sweep and the reminders take seconds.
 */
const ABANDONED_AFTER_MS = 30 * 60_000;

/** Mongo's duplicate-key error, whatever wrapper it arrives in. */
function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: number }).code === 11_000
  );
}
