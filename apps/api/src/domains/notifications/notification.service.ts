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
  type NotificationRecipient,
  type RaiseNotificationInput,
} from './notification.repository.js';

const log = logger.child({ module: 'notifications' });

/** The three office roles — everybody with the queues and the prices. */
const OFFICE_ROLES: readonly Role[] = ['super-admin', 'operations', 'office-staff'];

/**
 * Who a staff alert is for, by what they can DO about it.
 *
 * ── Why an alert is not simply "the office" any more ──────────────────────
 * Because the office is four roles that open different screens. The allocator
 * plans the runs a futile pickup or an unroadworthy truck upsets, and was told
 * about none of it; office staff were told about trucks and enquiries and then
 * shown "Forbidden" by the link, because they cannot open the fleet or lead
 * screens. Each audience below is the set of roles that can open the screen
 * the alert links to — keep it in step with `apps/web/.../permissions.ts`.
 */
export type StaffAudience = 'office' | 'dispatch' | 'planning' | 'fleet' | 'sales';

const AUDIENCE_ROLES: Record<StaffAudience, readonly Role[]> = {
  /** Money and customer conversations. Never the allocator, who sees no prices. */
  office: OFFICE_ROLES,
  /** A job, a site, a driver — the operational news the allocator plans around. */
  dispatch: [...OFFICE_ROLES, 'allocator'],
  /** "Re-plan this" — the roles that can open the dispatch board (`dispatch:manage`). */
  planning: ['super-admin', 'operations', 'allocator'],
  /** Trucks. The roles that can open the vehicle screens (`vehicles:manage`). */
  fleet: ['super-admin', 'operations', 'allocator'],
  /** Enquiries. The roles that can open the lead queue (`leads:manage`). */
  sales: ['super-admin', 'operations'],
};

/**
 * An allocator with no office role as well. They cannot open the queues, so an
 * alert that links there sends them somewhere they can go instead.
 */
function isOnlyAllocator(recipient: NotificationRecipient): boolean {
  const roles = recipient.roles ?? [];
  return roles.includes('allocator') && !roles.some((role) => OFFICE_ROLES.includes(role));
}

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
    /*
     * Two audiences. The queues hold money and are worked from screens only
     * the office can open; the fleet reminders go to whoever can open a
     * vehicle — which includes the allocator and excludes office staff.
     */
    const [recipients, fleetRecipients] = await Promise.all([
      notificationRepository.officeRecipients(AUDIENCE_ROLES.office),
      notificationRepository.officeRecipients(AUDIENCE_ROLES.fleet),
    ]);

    if (recipients.length === 0 && fleetRecipients.length === 0) {
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
    }

    // Trucks go to the people who can open a vehicle — see `AUDIENCE_ROLES.fleet`.
    for (const recipient of fleetRecipients) {
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
        fleetRecipients: fleetRecipients.length,
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
   * M8.3 — asks every site with a truck booked for tomorrow whether it will be
   * ready.
   *
   * ⚠️ "Booked for tomorrow" means ON A RUN DATED TOMORROW — the day a truck is
   * actually going. It used to mean the job's `targetDate`, which is the SLA
   * deadline (ready date + five business days): a job on tomorrow's run with a
   * later deadline was never asked, and a job with no truck at all was asked
   * about "tomorrow's pickup". See `jobRepository.dueForReadinessReminder`.
   *
   * Run every hour through the afternoon (`scheduler.service.ts`), so a job the
   * allocator puts on tomorrow's run at 5 pm is still asked. Each site is asked
   * once per truck day — the send is keyed on the job and the run date.
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
   * Raises one notification for the portal users who can see ONE job — the
   * account's administrators and the site supervisor who booked it.
   *
   * ── Why customers get an inbox at all ─────────────────────────────────────
   * Because email is where a pickup update goes to die. A site supervisor who
   * opens the portal to book the next job should see that yesterday's was
   * completed without having found the email.
   *
   * ── Why not everybody on the account ──────────────────────────────────────
   * That is what this used to be, and it told every supervisor about every
   * pickup. A supervisor sees only the pickups they booked (M1.5), so the
   * notice showed them a job the portal refuses to open for them. See
   * `notificationRepository.jobAudience`.
   *
   * ⚠️ Swallowed, like the two below. All three are side effects of somebody
   * else's work — a booking, a completed job, a message, a driver reporting an
   * unsafe site. If raising the notification threw, it would take that work
   * down with it. The inbox is the least important thing in each transaction.
   *
   * Returns who was notified, so a caller sending an email alongside reaches
   * the same people — and nobody when the raise failed.
   */
  async notifyJobAudience(input: {
    accountId: string;
    bookedByUserId: string | null;
    category: Notification['category'];
    severity: Notification['severity'];
    title: string;
    body: string;
    href: string;
    subjectKey: string;
    jobId?: string | null;
    jobNumber?: number | null;
  }): Promise<NotificationRecipient[]> {
    const { accountId, bookedByUserId, ...notification } = input;

    try {
      const recipients = await notificationRepository.jobAudience(accountId, bookedByUserId);
      await raiseFor(recipients, notification);
      return recipients;
    } catch (error) {
      log.error(
        { err: error, accountId, subjectKey: input.subjectKey },
        'could not notify the job’s customer users',
      );
      return [];
    }
  },

  /**
   * Raises one notification for the account's customer administrators only.
   *
   * For anything about money. A site supervisor never sees a price or an
   * invoice (M1.5), so an invoice notice that reached them put an amount in
   * their inbox that the portal will not show them anywhere else.
   */
  async notifyAccountAdministrators(input: {
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
  }): Promise<NotificationRecipient[]> {
    const { accountId, ...notification } = input;

    // Swallowed for the same reason as `notifyJobAudience` — see the note there.
    try {
      const recipients = await notificationRepository.accountAdministrators(accountId);
      await raiseFor(recipients, notification);
      return recipients;
    } catch (error) {
      log.error(
        { err: error, accountId, subjectKey: input.subjectKey },
        'could not notify the account administrators',
      );
      return [];
    }
  },

  /**
   * Raises one notification for each member of staff in `audience` — by
   * default the three office roles. See `AUDIENCE_ROLES` for who is in each.
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
    /** Who is told. Omitted means `office`. */
    audience?: StaffAudience;
    /**
     * Where an allocator-only recipient is sent instead of `href`, when `href`
     * is a screen they cannot open — the queues need a capability they lack.
     */
    allocatorHref?: string;
    /** Whoever caused this. Told nothing: they know, they just did it. */
    exceptUserId?: string | null;
  }): Promise<NotificationRecipient[]> {
    const { audience = 'office', allocatorHref, exceptUserId, ...notification } = input;

    // Swallowed for the same reason as `notifyJobAudience` — see the note there.
    try {
      const recipients = (
        await notificationRepository.officeRecipients(AUDIENCE_ROLES[audience])
      ).filter((recipient) => !exceptUserId || recipient.id !== exceptUserId);

      await Promise.all(
        recipients.map((recipient) => {
          const allocatorOnly = isOnlyAllocator(recipient);

          return notificationRepository.raise({
            ...notification,
            userId: recipient.id,
            href: allocatorOnly && allocatorHref ? allocatorHref : notification.href,
            // The allocator is never shown what a job is worth (M1.5).
            valueExGst: allocatorOnly ? null : (notification.valueExGst ?? null),
          });
        }),
      );

      return recipients;
    } catch (error) {
      log.error({ err: error, subjectKey: input.subjectKey, audience }, 'could not notify the office');
      return [];
    }
  },
};

/** One row per recipient, raised together. */
async function raiseFor(
  recipients: readonly NotificationRecipient[],
  notification: Omit<RaiseNotificationInput, 'userId'>,
): Promise<void> {
  await Promise.all(
    recipients.map((recipient) =>
      notificationRepository.raise({ ...notification, userId: recipient.id }),
    ),
  );
}

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
