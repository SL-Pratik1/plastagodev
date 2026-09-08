import type { Notification, NotificationSummary, PageMeta, Role } from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { queueRepository } from '../queues/queue.repository.js';
import { vehicleRepository } from '../fleet/vehicle.repository.js';
import { userRepository } from '../users/user.repository.js';
import {
  notificationRepository,
  type ListNotificationsQuery,
} from './notification.repository.js';

const log = logger.child({ module: 'notifications' });

/**
 * The internal notification centre (M8.7) and the sweep that fills it.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * One futile pickup has sat unactioned in TransVirtual since 28 August 2025 —
 * a year, at $120. Nobody looked, because nothing chased. So the sweep below
 * runs over every queue that holds money and raises a notification for anything
 * that has been sitting too long.
 *
 * ⚠️ The hardest rule here is restraint. A centre where everything is urgent
 * trains people to ignore it, so `urgent` is reserved for things that STOP
 * work — an unroadworthy truck, a driver who walked off a site. Everything else
 * is `action` at most, and each notification is raised once per subject rather
 * than every night.
 */

export interface Caller {
  userId: string;
  name: string;
  roles: readonly Role[];
}

/** How long something sits before it is worth interrupting somebody about. */
const AGE_THRESHOLDS = {
  /** A customer is waiting for a call about a pickup that did not happen. */
  futileReview: 2,
  /** A driver is waiting to know whether their report was believed. */
  chargeApproval: 3,
  /** Matt's three months start here. */
  awaitingPo: 7,
  /** §6A.8 — a phone that has not drained its queue. */
  stuckSyncActions: 5,
  /** M9.8 — the registration that grounds a truck legally. */
  expiryDays: 30,
} as const;

export const notificationService = {
  async list(
    query: ListNotificationsQuery,
    caller: Caller,
  ): Promise<{ data: Notification[]; meta: PageMeta }> {
    // No route takes a user id — a caller reads their own inbox and no other.
    return notificationRepository.list(caller.userId, query);
  },

  async summary(caller: Caller): Promise<NotificationSummary> {
    return notificationRepository.summary(caller.userId);
  },

  async markRead(ids: readonly string[], caller: Caller): Promise<number> {
    if (ids.length === 0) throw AppError.validation('Select at least one notification');

    return notificationRepository.markRead(caller.userId, ids);
  },

  async markAllRead(caller: Caller): Promise<number> {
    return notificationRepository.markAllRead(caller.userId);
  },

  /**
   * M8.7 — the sweep that chases.
   *
   * Runs on a schedule and is safe to run repeatedly: every notification is
   * keyed by its subject, so a queue still holding the same row tomorrow
   * refreshes the existing message rather than adding another.
   *
   * ── Why it raises per ROW and not one summary line ────────────────────────
   * Because "3 futile reviews are overdue" is not actionable — it does not say
   * which, and somebody has to open the queue and work out what changed. A
   * notification naming the job, the customer and the amount can be acted on
   * from the inbox.
   */
  async runQueueSweep(): Promise<{ raised: number }> {
    const recipients = await notificationRepository.officeRecipients();

    if (recipients.length === 0) {
      // Nobody to tell is worth saying out loud: a silent sweep looks like a
      // working one.
      log.warn('queue sweep found no active office users to notify');
      return { raised: 0 };
    }

    const [futile, approvals, awaitingPo, expiring, stuckDevices] = await Promise.all([
      queueRepository.futileList(
        { page: 1, pageSize: 20, agedOverDays: AGE_THRESHOLDS.futileReview },
        '0.00',
      ),
      queueRepository.approvalList({
        page: 1,
        pageSize: 20,
        agedOverDays: AGE_THRESHOLDS.chargeApproval,
      }),
      queueRepository.awaitingPoList({
        page: 1,
        pageSize: 20,
        agedOverDays: AGE_THRESHOLDS.awaitingPo,
      }),
      vehicleRepository.expiringSoon(AGE_THRESHOLDS.expiryDays),
      userRepository.stuckDevices(AGE_THRESHOLDS.stuckSyncActions),
    ]);

    let raised = 0;

    for (const recipient of recipients) {
      for (const review of futile.data) {
        await notificationRepository.raise({
          userId: recipient.id,
          category: 'queue',
          // `action`, not `urgent` — the truck already left. Somebody has to
          // ring the customer, which is a today job, not a stop-work one.
          severity: 'action',
          title: `Futile pickup #${String(review.jobNumber)} still needs a decision`,
          body: `${review.accountName} at ${review.siteName}. Marked futile ${daysAgo(review.markedAt)} — reschedule or cancel.`,
          href: `/queues/futile/${review.id}`,
          subjectKey: `futile-review:${review.id}`,
          valueExGst: review.feeExGst,
          jobId: review.jobId,
          jobNumber: review.jobNumber,
        });
        raised += 1;
      }

      for (const charge of approvals.data) {
        await notificationRepository.raise({
          userId: recipient.id,
          category: 'queue',
          severity: 'action',
          title: `${charge.description} on #${String(charge.jobNumber)} awaits approval`,
          body: `${charge.accountName}. Raised by ${charge.raisedBy ?? 'a driver'} ${daysAgo(charge.raisedAt)}${charge.poRequired ? ' — approving moves it to the awaiting-PO queue.' : '.'}`,
          href: `/queues/approvals/${charge.id}`,
          subjectKey: `charge-approval:${charge.id}`,
          // The amount IS the argument for looking at it.
          valueExGst: charge.amountExGst,
          jobId: charge.jobId,
          jobNumber: charge.jobNumber,
        });
        raised += 1;
      }

      for (const invoice of awaitingPo.data) {
        await notificationRepository.raise({
          userId: recipient.id,
          category: 'invoice',
          severity: 'action',
          title: `Invoice ${String(invoice.invoiceNumber)} is still waiting on a PO`,
          body: `${invoice.accountName} — ${invoice.chargeSummary}. ${
            invoice.lastChasedAt
              ? `Last chased ${daysAgo(invoice.lastChasedAt)} (${String(invoice.chaseCount)}×).`
              : 'Never chased.'
          }`,
          href: `/queues/awaiting-po`,
          subjectKey: `awaiting-po:${invoice.id}`,
          valueExGst: invoice.totalExGst,
          jobId: invoice.jobId || null,
          jobNumber: invoice.jobNumber || null,
        });
        raised += 1;
      }

      for (const vehicle of expiring) {
        const overdue = vehicle.dueOn < todayIso();

        await notificationRepository.raise({
          userId: recipient.id,
          category: 'system',
          /*
           * ⚠️ An EXPIRED registration is urgent: the truck cannot legally be
           * driven, and finding out on the morning of a run is finding out too
           * late. A service due next week is not.
           */
          severity: overdue && vehicle.kind === 'registration' ? 'urgent' : 'action',
          title: `${vehicle.rego} ${vehicle.kind} ${overdue ? 'has expired' : 'is due'}`,
          body: `${vehicle.label} — ${vehicle.kind} ${overdue ? 'expired' : 'due'} ${vehicle.dueOn}.`,
          href: `/fleet/${vehicle.id}`,
          subjectKey: `vehicle-${vehicle.kind}:${vehicle.id}:${vehicle.dueOn}`,
        });
        raised += 1;
      }

      /*
       * §6A.8 — there is no error-tracking vendor, so a stuck offline queue has
       * to be visible in the product. A driver's phone holding fourteen unsent
       * actions since Tuesday is invisible otherwise.
       */
      for (const device of stuckDevices) {
        await notificationRepository.raise({
          userId: recipient.id,
          category: 'sync',
          severity: 'action',
          title: `${device.label} has ${String(device.pendingSyncActions)} unsent actions`,
          body: `Last synced ${device.lastSyncAt ? daysAgo(device.lastSyncAt.toISOString()) : 'never'}. The driver may be out of signal, or the app may be stuck.`,
          href: `/users/${device.userId}`,
          subjectKey: `stuck-sync:${device.userId}`,
        });
        raised += 1;
      }
    }

    log.info(
      {
        recipients: recipients.length,
        futile: futile.data.length,
        approvals: approvals.data.length,
        awaitingPo: awaitingPo.data.length,
        expiring: expiring.length,
        stuckDevices: stuckDevices.length,
        raised,
      },
      'queue sweep complete',
    );

    return { raised };
  },

  /**
   * Raises one notification for every office user.
   *
   * Used by the domains that need to interrupt somebody immediately rather than
   * waiting for the sweep — a driver judging a site unsafe, an unroadworthy
   * truck.
   */
  async notifyOffice(input: {
    category: Notification['category'];
    severity: Notification['severity'];
    title: string;
    body: string;
    href: string;
    subjectKey: string;
    valueExGst?: string | null;
    jobId?: string | null;
    jobNumber?: number | null;
  }): Promise<void> {
    const recipients = await notificationRepository.officeRecipients();

    await Promise.all(
      recipients.map((recipient) =>
        notificationRepository.raise({ ...input, userId: recipient.id }),
      ),
    );
  },
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * "3 days ago" — how long it has been sitting.
 *
 * The age is the argument for acting, so it is spelled out rather than left as
 * a date somebody has to subtract in their head.
 */
function daysAgo(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);

  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${String(days)} days ago`;
  if (days < 60) return `${String(Math.floor(days / 7))} weeks ago`;
  return `${String(Math.floor(days / 30))} months ago`;
}

function todayIso(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}
