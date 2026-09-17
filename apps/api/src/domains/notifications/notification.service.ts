import type { Notification, NotificationSummary, PageMeta, Role } from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { todayInSydney } from '../../lib/business-day.js';
import { jobRepository } from '../jobs/job.repository.js';
import { queueRepository } from '../queues/queue.repository.js';
import { vehicleRepository } from '../fleet/vehicle.repository.js';
import { jobNotices } from './job-notices.service.js';
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

    const [futile, approvals, awaitingPo, expiring] = await Promise.all([
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
    ]);

    let raised = 0;

    /*
     * ⚠️ Every `href` below is an OFFICE route and must carry the `/admin`
     * prefix the console is mounted under.
     *
     * They did not, and every link in the notification centre was therefore a
     * 404: `/queues/futile`, `/queues/approvals`, `/invoices`, `/dispatch`,
     * `/users/:id` — none of those exist, the console lives at `/admin/*`. One
     * was worse than a missing prefix: `/fleet/:id` names a section that has
     * never existed, the route is `/admin/vehicles/:id`.
     *
     * The model's own rule is that "every notification must be actionable. One
     * that tells somebody a problem exists without saying where to fix it is a
     * notification they learn to dismiss" — and a dead link is exactly that,
     * with the added insult of looking like the product is broken.
     *
     * Two of these deliberately point at a LIST rather than a row: there is no
     * `queues/futile/:id` or `queues/approvals/:id` route, because both open
     * their detail in a dialog from the list.
     */
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
          href: `/admin/queues/futile`,
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
          href: `/admin/queues/approvals`,
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
          href: `/admin/queues/awaiting-po`,
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
          href: `/admin/vehicles/${vehicle.id}`,
          subjectKey: `vehicle-${vehicle.kind}:${vehicle.id}:${vehicle.dueOn}`,
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
  /**
   * M8.3 — asks every site booked for tomorrow whether it will be ready.
   *
   * ── Why this is the highest-value message in the product ───────────────────
   * A futile pickup costs $120 and a truck slot, and the customer disputes it
   * because nobody warned them. One question the evening before, with a link to
   * move the date, removes the charge and the argument. Matt's own framing was a
   * reply-to-SMS; a tap-through is cheaper and unambiguous (see
   * `notice-messages.ts`).
   *
   * ── Why "tomorrow" is computed in Sydney ──────────────────────────────────
   * Because a reminder that names the wrong day is worse than none, and a UTC
   * day boundary is ten hours out — an evening sweep would ask about today.
   *
   * Safe to run repeatedly: each send is keyed on the job AND its target date,
   * so a second run tonight sends nothing, while a job rescheduled to tomorrow
   * gets its own ask.
   */
  async runReadinessReminders(): Promise<{ asked: number; skipped: number }> {
    const target = tomorrowInSydney();
    const jobs = await jobRepository.dueForReadinessReminder(target);

    let asked = 0;
    let skipped = 0;

    for (const job of jobs) {
      const outcome = await jobNotices.readinessReminder(job);
      if (outcome === 'sent') asked += 1;
      else skipped += 1;
    }

    log.info({ target, jobs: jobs.length, asked, skipped }, 'readiness reminders complete');
    return { asked, skipped };
  },

  /**
   * Raises one notification for every portal user of an account.
   *
   * ── Why customers get an inbox at all ─────────────────────────────────────
   * Because email is where a pickup update goes to die. A site supervisor who
   * opens the portal to book the next job should see that yesterday's was
   * completed, and an invoice that needs a PO should be visible to the person
   * who can supply one — without either of them having found the email.
   *
   * ⚠️ An account with no portal users yet raises nothing, silently. That is
   * correct: the customer has been emailed, and inventing an inbox for somebody
   * who cannot sign in would just accumulate unread rows.
   */
  async notifyAccount(input: {
    accountId: string;
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
    const { accountId, ...notification } = input;

    /*
     * ⚠️ Swallowed, like `notifyOffice` below.
     *
     * Both are side effects of somebody else's work — an invoice being sent, a
     * driver reporting an unsafe site. If raising the notification threw, it
     * would take that work down with it: the invoice would report a failure
     * having already been marked sent, and the driver's report would be lost
     * because the office could not be told about it. The inbox is the least
     * important thing in either transaction.
     */
    try {
      const recipients = await notificationRepository.accountRecipients(accountId);

      await Promise.all(
        recipients.map((recipient) =>
          notificationRepository.raise({ ...notification, userId: recipient.id }),
        ),
      );
    } catch (error) {
      log.error({ err: error, accountId, subjectKey: input.subjectKey }, 'could not notify account');
    }
  },

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
    // Swallowed for the same reason as `notifyAccount` — see the note there.
    try {
      const recipients = await notificationRepository.officeRecipients();

      await Promise.all(
        recipients.map((recipient) =>
          notificationRepository.raise({ ...input, userId: recipient.id }),
        ),
      );
    } catch (error) {
      log.error({ err: error, subjectKey: input.subjectKey }, 'could not notify the office');
    }
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

/**
 * Tomorrow, in Sydney.
 *
 * ⚠️ Derived from the Sydney date rather than from `Date.now() + 86_400_000`.
 * Adding a day to a UTC instant is a day out for anything after 10am UTC, which
 * is most of the working day here — see `lib/business-day.ts`.
 */
function tomorrowInSydney(): string {
  const today = todayInSydney();
  const next = new Date(`${today}T00:00:00+10:00`);
  next.setDate(next.getDate() + 1);

  return next.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}
