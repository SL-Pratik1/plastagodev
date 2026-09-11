import type { Job } from '@plastago/shared';
import { logger } from '../../lib/logger.js';
import {
  buildJobBookedEmail,
  buildJobBookedSms,
  buildJobCompletedEmail,
  buildJobCompletedSms,
  buildJobEnRouteEmail,
  buildJobEnRouteSms,
  buildReadinessEmail,
  buildReadinessSms,
} from '../../integrations/notice-messages.js';
import { jobRepository } from '../jobs/job.repository.js';
import { notificationService } from './notification.service.js';
import { outboundService } from './outbound.service.js';

const log = logger.child({ module: 'job-notices' });

/**
 * What the customer is told about their pickup (M8.1 · M8.2 · M8.3).
 *
 * ── Why this is one module and not a call in each service ──────────────────
 * The three moments that matter — booked, on the way, complete — are raised
 * from three different places: the office or the portal books it, the driver's
 * phone moves it, and the driver's phone closes it. Written inline, each would
 * grow its own idea of who the recipient is and what the message says, and the
 * supervisor would get three messages in three different voices about the same
 * job.
 *
 * ── Who gets told ─────────────────────────────────────────────────────────
 * The SITE contact on the job, not the account's billing contact. Matt, 14:16:
 * the site contact is *"often the builder's supervisor, who has no login here"*
 * — which is exactly why these go out as messages rather than only appearing in
 * the portal. The portal notification goes up alongside for the people who do
 * have logins.
 *
 * ⚠️ Every function here is best-effort and never throws. A booking, a status
 * update from a phone on a building site, and a completed job are all things
 * that must stand whether or not a message got out.
 */

/**
 * The job fields a notice needs. Anything wider is not this module's business.
 *
 * Deliberately narrow so the reminder sweep can read a light projection instead
 * of assembling a whole `Job` — charges, events, photos and comments included —
 * for every site it wants to text.
 */
export type NoticeJob = Pick<
  Job,
  | 'id'
  | 'jobNumber'
  | 'siteName'
  | 'accountId'
  | 'accountName'
  | 'targetDate'
  | 'siteContactEmail'
  | 'siteContactMobile'
>;

/** What a completion summary adds: what was actually taken away. */
type CompletedJob = NoticeJob &
  Pick<Job, 'expectedAreaM2' | 'recoveredWeightKg' | 'bagCount' | 'collectedBagCount' | 'photos'>;

/**
 * Runs a notice and swallows whatever it throws.
 *
 * ── Why this wrapper exists at all ────────────────────────────────────────
 * `outboundService` already refuses to throw, but the portal raise beside it
 * and the job read before it can. Without this, a driver standing on a site
 * with one bar of signal could be told their completed job failed — after it
 * had been written, and after the invoice it feeds had become raisable. The
 * message is the least important thing in that transaction.
 */
async function quietly(event: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    log.error({ err: error, event }, 'notice failed');
  }
}

export const jobNotices = {
  /** M8.1 — "your pickup is booked". */
  async booked(job: NoticeJob): Promise<void> {
    return quietly('job-booked', async () => {
      const context = contextFor(job);

      await outboundService.send({
        event: 'job-booked',
        subjectKey: `job-booked:${job.id}`,
        recipient: recipientFor(job),
        email: (to) => buildJobBookedEmail(to, context),
        sms: (to) => buildJobBookedSms(to, context),
        accountId: job.accountId,
        jobId: job.id,
      });

      await notificationService.notifyAccount({
        accountId: job.accountId,
        category: 'queue',
        // `info`: there is nothing to do about a booking that is going to plan.
        severity: 'info',
        title: `Pickup booked — ${job.siteName}`,
        body: `Job #${String(job.jobNumber)} is booked for ${context.when}.`,
        href: `/portal/jobs/${job.id}`,
        subjectKey: `job-booked:${job.id}`,
        jobId: job.id,
        jobNumber: job.jobNumber,
      });
    });
  },

  /**
   * M8.1 — "the driver is on the way".
   *
   * Takes an id rather than a job because the driver app's own read model does
   * not carry the site contact: the phone is told about the stop, not about who
   * to email. Loading the job here keeps that seam intact.
   */
  async enRoute(jobId: string): Promise<void> {
    return quietly('job-en-route', async () => {
      const job = await loadJob(jobId, 'en-route');
      if (!job) return;

      const context = contextFor(job);

      await outboundService.send({
        event: 'job-en-route',
        subjectKey: `job-en-route:${job.id}`,
        recipient: recipientFor(job),
        email: (to) => buildJobEnRouteEmail(to, context),
        sms: (to) => buildJobEnRouteSms(to, context),
        accountId: job.accountId,
        jobId: job.id,
      });
    });
  },

  /** M8.2 · F24 — "it is done, and here is what we took". */
  async completed(jobId: string): Promise<void> {
    return quietly('job-completed', async () => {
      const job = await loadJob(jobId, 'completed');
      if (!job) return;

      const context = {
        ...contextFor(job),
        areaM2: job.expectedAreaM2,
        weightKg: job.recoveredWeightKg,
        /*
         * What the driver actually took, not what the order allowed for — this
         * email says "Recovered". Falls back to the allowance for a job saved
         * before the two were told apart, where it was the same field.
         */
        bagCount: job.collectedBagCount ?? job.bagCount,
        photoCount: job.photos.length,
      };

      await outboundService.send({
        event: 'job-completed',
        subjectKey: `job-completed:${job.id}`,
        recipient: recipientFor(job),
        email: (to) => buildJobCompletedEmail(to, context),
        sms: (to) => buildJobCompletedSms(to, context),
        accountId: job.accountId,
        jobId: job.id,
      });

      await notificationService.notifyAccount({
        accountId: job.accountId,
        category: 'queue',
        severity: 'info',
        title: `Pickup complete — ${job.siteName}`,
        body:
          job.expectedAreaM2 === null
            ? `Job #${String(job.jobNumber)} is complete. ${String(job.photos.length)} site photos.`
            : `Job #${String(job.jobNumber)} is complete — ${String(job.expectedAreaM2)} m². ${String(job.photos.length)} site photos.`,
        href: `/portal/jobs/${job.id}`,
        subjectKey: `job-completed:${job.id}`,
        jobId: job.id,
        jobNumber: job.jobNumber,
      });
    });
  },

  /**
   * M8.3 — "is the site ready for tomorrow?"
   *
   * Returns the outcome because the sweep that calls it counts what went out;
   * everything else here is fire-and-forget.
   */
  async readinessReminder(job: NoticeJob): Promise<'sent' | 'skipped'> {
    const context = { ...contextFor(job), jobId: job.id };

    const result = await outboundService.send({
      event: 'pickup-reminder',
      // Keyed on the DATE as well as the job: a rescheduled job is a new ask,
      // and the once-only guard must not silence tomorrow's reminder because
      // one went out for a date that has since moved.
      subjectKey: `pickup-reminder:${job.id}:${job.targetDate}`,
      recipient: recipientFor(job),
      email: (to) => buildReadinessEmail(to, context),
      sms: (to) => buildReadinessSms(to, context),
      accountId: job.accountId,
      jobId: job.id,
    });

    if (result.outcome === 'sent') {
      await notificationService.notifyAccount({
        accountId: job.accountId,
        category: 'queue',
        // `action` — this one genuinely asks the customer to do something, and
        // ignoring it is what produces a futile pickup and a $120 charge.
        severity: 'action',
        title: `Ready for tomorrow? ${job.siteName}`,
        body: `Job #${String(job.jobNumber)} is booked for ${context.when}. If the site will not be ready, move the date.`,
        href: `/portal/jobs/${job.id}`,
        subjectKey: `pickup-reminder:${job.id}:${job.targetDate}`,
        jobId: job.id,
        jobNumber: job.jobNumber,
      });
    }

    return result.outcome === 'sent' ? 'sent' : 'skipped';
  },
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

async function loadJob(jobId: string, event: string): Promise<CompletedJob | null> {
  // `accountId: null` — an unscoped read. This is the system telling a customer
  // about their own job, not one customer reading another's.
  const job = await jobRepository.findById(jobId, {
    accountId: null,
    bookedByUserId: null,
    driverId: null,
  });

  if (!job) log.warn({ jobId, event }, 'job vanished before its notice could be sent');
  return job;
}

/**
 * The site contact.
 *
 * Email is preferred by `outboundService`; the mobile is what reaches a
 * supervisor who has no email, which on a building site is most of them.
 */
function recipientFor(job: NoticeJob) {
  return { email: job.siteContactEmail, mobile: job.siteContactMobile };
}

function contextFor(job: NoticeJob) {
  return {
    jobNumber: job.jobNumber,
    siteName: job.siteName,
    when: formatDay(job.targetDate),
    accountName: job.accountName,
  };
}

/**
 * "Tue 12 Sept" — a date a person can act on.
 *
 * ⚠️ Formatted in Sydney, deliberately. An ISO date rendered in UTC is a day
 * out for anything booked in the evening, and a reminder naming the wrong day
 * is worse than none. See `lib/business-day.ts` for the same rule on the
 * reading side.
 */
function formatDay(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00+10:00`);

  return date.toLocaleDateString('en-AU', {
    timeZone: 'Australia/Sydney',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}
