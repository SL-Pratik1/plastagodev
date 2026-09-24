import type { Job } from '@plastago/shared';
import { logger } from '../../lib/logger.js';
import {
  buildJobBookedEmail,
  buildJobBookedSms,
  buildJobCancelledEmail,
  buildJobCancelledSms,
  buildJobCompletedEmail,
  buildJobCompletedSms,
  buildJobEnRouteEmail,
  buildJobEnRouteSms,
  buildJobFutileEmail,
  buildJobFutileSms,
  buildJobMessageToCustomerEmail,
  buildJobMessageToOfficeEmail,
  buildJobMovedEmail,
  buildJobMovedSms,
  buildReadinessEmail,
  buildReadinessSms,
} from '../../integrations/notice-messages.js';
import { accountRepository } from '../accounts/account.repository.js';
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
 * The SITE contact on the job first. Matt, 14:16: the site contact is *"often
 * the builder's supervisor, who has no login here"* — which is exactly why
 * these go out as messages rather than only appearing in the portal. The portal
 * notification goes up alongside for the people who do have logins — and only
 * those who can open the pickup: the account's administrators and the
 * supervisor who booked it (`notificationService.notifyJobAudience`).
 *
 * Where the job carries no site contact, `recipientFor` falls back to the
 * account's own contacts rather than sending nothing. See the note there: with
 * no fallback these notices silently reached nobody, which is the failure they
 * exist to prevent.
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
  // Who, besides the administrators, may see it in the portal — and so be told.
  | 'bookedByUserId'
> & {
  /**
   * The customer's ready date. Optional only so a caller holding an older,
   * narrower projection still compiles; every real read carries it, and the
   * booking notice then says "ready from X, collected by Y".
   */
  readyDate?: string;
};

/** A new post on a pickup's customer thread (M2.11). */
export interface PostedMessage {
  commentId: string;
  jobId: string;
  jobNumber: number;
  siteName: string;
  accountId: string;
  accountName: string;
  bookedByUserId: string | null;
  author: string;
  body: string;
  /** Written in the portal. False when the office wrote it. */
  fromCustomer: boolean;
}

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
        recipient: await recipientFor(job),
        email: (to) => buildJobBookedEmail(to, context),
        sms: (to) => buildJobBookedSms(to, context),
        accountId: job.accountId,
        jobId: job.id,
      });

      await notificationService.notifyJobAudience({
        accountId: job.accountId,
        bookedByUserId: job.bookedByUserId ?? null,
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
        recipient: await recipientFor(job),
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
        recipient: await recipientFor(job),
        email: (to) => buildJobCompletedEmail(to, context),
        sms: (to) => buildJobCompletedSms(to, context),
        accountId: job.accountId,
        jobId: job.id,
      });

      await notificationService.notifyJobAudience({
        accountId: job.accountId,
        bookedByUserId: job.bookedByUserId ?? null,
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
  async readinessReminder(job: NoticeJob & { runDate: string }): Promise<'sent' | 'skipped'> {
    // `when` is the RUN's day — the day the truck is coming — not the deadline.
    const context = { ...contextFor(job), when: formatDay(job.runDate), jobId: job.id };

    const result = await outboundService.send({
      event: 'pickup-reminder',
      // Keyed on the truck's DATE as well as the job: a job moved to another
      // run is a new ask, and the once-only guard must not silence it because
      // one went out for a day that has since changed.
      subjectKey: `pickup-reminder:${job.id}:${job.runDate}`,
      recipient: await recipientFor(job),
      email: (to) => buildReadinessEmail(to, context),
      sms: (to) => buildReadinessSms(to, context),
      accountId: job.accountId,
      jobId: job.id,
    });

    if (result.outcome === 'sent') {
      await notificationService.notifyJobAudience({
        accountId: job.accountId,
        bookedByUserId: job.bookedByUserId ?? null,
        category: 'queue',
        // `action` — this one genuinely asks the customer to do something, and
        // ignoring it is what produces a futile pickup and a $120 charge.
        severity: 'action',
        title: `Ready for tomorrow? ${job.siteName}`,
        body: `Job #${String(job.jobNumber)} is booked for ${context.when}. If the site will not be ready, move the date.`,
        href: `/portal/jobs/${job.id}`,
        subjectKey: `pickup-reminder:${job.id}:${job.runDate}`,
        jobId: job.id,
        jobNumber: job.jobNumber,
      });
    }

    return result.outcome === 'sent' ? 'sent' : 'skipped';
  },

  /**
   * M2.6 — "we could not collect today", the day it happens.
   *
   * Keyed on the job: a phone replaying the futile report cannot text the site
   * twice. `reason` is already in words ("Site not ready"); no fee is named —
   * see `buildJobFutileEmail`.
   */
  async futile(jobId: string, reason: string): Promise<void> {
    return quietly('job-futile', async () => {
      const job = await loadJob(jobId, 'futile');
      if (!job) return;

      const context = { ...contextFor(job), jobId: job.id, reason };

      await outboundService.send({
        event: 'job-futile',
        subjectKey: `job-futile:${job.id}`,
        recipient: await recipientFor(job),
        email: (to) => buildJobFutileEmail(to, context),
        sms: (to) => buildJobFutileSms(to, context),
        accountId: job.accountId,
        jobId: job.id,
      });

      await notificationService.notifyJobAudience({
        accountId: job.accountId,
        bookedByUserId: job.bookedByUserId ?? null,
        category: 'queue',
        // `action`: somebody on their side has to get the site ready and rebook.
        severity: 'action',
        title: `Pickup not collected — ${job.siteName}`,
        body: `Job #${String(job.jobNumber)}: ${reason}. The office will be in touch to book a new day.`,
        href: `/portal/jobs/${job.id}`,
        subjectKey: `job-futile:${job.id}`,
        jobId: job.id,
        jobNumber: job.jobNumber,
      });
    });
  },

  /**
   * M2.4 — "your pickup has been cancelled".
   *
   * Whoever cancelled it — the office, or the builder's own call-up email —
   * the site contact is still holding a "pickup booked" message, and without
   * this they keep the pile back for a truck that is never coming.
   */
  async cancelled(jobId: string): Promise<void> {
    return quietly('job-cancelled', async () => {
      const job = await loadJob(jobId, 'cancelled');
      if (!job) return;

      const context = contextFor(job);

      await outboundService.send({
        event: 'job-cancelled',
        subjectKey: `job-cancelled:${job.id}`,
        recipient: await recipientFor(job),
        email: (to) => buildJobCancelledEmail(to, context),
        sms: (to) => buildJobCancelledSms(to, context),
        accountId: job.accountId,
        jobId: job.id,
      });

      await notificationService.notifyJobAudience({
        accountId: job.accountId,
        bookedByUserId: job.bookedByUserId ?? null,
        category: 'queue',
        severity: 'info',
        title: `Pickup cancelled — ${job.siteName}`,
        body: `Job #${String(job.jobNumber)} has been cancelled. Nobody will come to the site for it.`,
        href: `/portal/jobs/${job.id}`,
        subjectKey: `job-cancelled:${job.id}`,
        jobId: job.id,
        jobNumber: job.jobNumber,
      });
    });
  },

  /**
   * M2.4a — "your pickup has a new date".
   *
   * Keyed on the new ready date: each move is news, while the same move
   * arriving twice (a call-up email reprocessed) is not.
   */
  async moved(jobId: string): Promise<void> {
    return quietly('job-moved', async () => {
      const job = await loadJob(jobId, 'moved');
      if (!job) return;

      const context = { ...contextFor(job), jobId: job.id };
      const readyDate = job.readyDate ?? job.targetDate;
      const subjectKey = `job-moved:${job.id}:${readyDate}`;

      await outboundService.send({
        event: 'job-moved',
        subjectKey,
        recipient: await recipientFor(job),
        email: (to) => buildJobMovedEmail(to, context),
        sms: (to) => buildJobMovedSms(to, context),
        accountId: job.accountId,
        jobId: job.id,
      });

      await notificationService.notifyJobAudience({
        accountId: job.accountId,
        bookedByUserId: job.bookedByUserId ?? null,
        category: 'queue',
        severity: 'info',
        title: `Pickup date changed — ${job.siteName}`,
        body: `Job #${String(job.jobNumber)}: ready from ${formatDay(readyDate)}, collected by ${context.when}.`,
        href: `/portal/jobs/${job.id}`,
        subjectKey,
        jobId: job.id,
        jobNumber: job.jobNumber,
      });
    });
  },

  /**
   * M2.11 — a new message on a pickup's customer thread.
   *
   * ── Each side is told when the other writes ───────────────────────────────
   * An office message goes to the people who can see the pickup; a customer's
   * reply goes to the office. Both get the bell AND an email: the customer
   * because they rarely have the portal open, the office because a reply is
   * somebody waiting on an answer.
   *
   * The email goes to exactly the people the bell reached, and only where they
   * have an address — a supervisor who signs in by SMS has the bell. There is
   * no SMS form: a message does not fit one segment, and an SMS per message
   * would be billed on every reply.
   *
   * Keyed on the COMMENT, not the job: every message is new, and one read
   * notification must not hide the next one on the same pickup.
   */
  async messagePosted(message: PostedMessage): Promise<void> {
    return quietly('job-message', async () => {
      const subjectKey = `job-comment:${message.commentId}`;
      const preview = previewOf(message.body);
      const context = {
        jobId: message.jobId,
        jobNumber: message.jobNumber,
        siteName: message.siteName,
        accountName: message.accountName,
        author: message.author,
        body: message.body,
      };

      const recipients = message.fromCustomer
        ? await notificationService.notifyOffice({
            category: 'message',
            severity: 'action',
            title: `Message from ${message.accountName} — #${String(message.jobNumber)}`,
            body: `${message.author}: ${preview}`,
            // Straight to the customer thread, not the job's overview.
            href: `/admin/jobs/${message.jobId}?tab=comments&thread=customer`,
            subjectKey,
            jobId: message.jobId,
            jobNumber: message.jobNumber,
          })
        : await notificationService.notifyJobAudience({
            accountId: message.accountId,
            bookedByUserId: message.bookedByUserId,
            category: 'message',
            severity: 'action',
            title: `New message about pickup #${String(message.jobNumber)}`,
            body: `${message.siteName}: ${preview}`,
            href: `/portal/jobs/${message.jobId}#messages`,
            subjectKey,
            jobId: message.jobId,
            jobNumber: message.jobNumber,
          });

      await Promise.all(
        recipients
          .filter((recipient) => recipient.email !== null)
          .map((recipient) =>
            outboundService.send({
              event: message.fromCustomer ? 'job-message-to-office' : 'job-message-to-customer',
              // Per person: each is their own row in the log, sent once.
              subjectKey: `${subjectKey}:${recipient.id}`,
              recipient: { email: recipient.email, mobile: null },
              email: (to) =>
                message.fromCustomer
                  ? buildJobMessageToOfficeEmail(to, context)
                  : buildJobMessageToCustomerEmail(to, context),
              accountId: message.accountId,
              jobId: message.jobId,
            }),
          ),
      );
    });
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
 * Who to tell, preferring the person standing on the site.
 *
 * Email is preferred by `outboundService`; the mobile is what reaches a
 * supervisor who has no email, which on a building site is most of them.
 *
 * ── Why there is a fallback at all ────────────────────────────────────────
 * ⚠️ This used to return the job's site contact and nothing else, so a job
 * booked without one sent NOTHING — logged as `skipped: no email or mobile on
 * file`, in a place nobody reads. It was not an edge case: no booking form
 * could set a site contact until recently, so in practice every pickup booked
 * through the product told the customer nothing, while the account sat there
 * with an accounts contact and a site contact on file.
 *
 * The account's own contacts are the right fallback, and the invoice path
 * already resolves recipients this way. Order matters: the SITE contact is
 * preferred over the accounts contact, because "your pickup is booked" is
 * operational news for whoever is on site, not for whoever pays.
 */
async function recipientFor(job: NoticeJob): Promise<{ email: string | null; mobile: string | null }> {
  if (job.siteContactEmail || job.siteContactMobile) {
    return { email: job.siteContactEmail, mobile: job.siteContactMobile };
  }

  const account = await accountRepository.findById(job.accountId, { accountId: null });
  const contacts = account?.contacts ?? [];

  const reachable = (contact: (typeof contacts)[number]) => contact.email ?? contact.mobile;
  const onSite = contacts.find((contact) => contact.role === 'site' && reachable(contact));
  const fallback = onSite ?? contacts.find(reachable);

  if (!fallback) return { email: null, mobile: null };

  return { email: fallback.email, mobile: fallback.mobile };
}

/**
 * The start of a message, for a notification line.
 *
 * Whitespace collapsed so a message typed with line breaks still reads as one
 * line in the inbox; cut at a word where possible.
 */
export function previewOf(body: string, limit = 140): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;

  const cut = flat.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function contextFor(job: NoticeJob) {
  return {
    jobNumber: job.jobNumber,
    siteName: job.siteName,
    // The date we collect BY. A readiness reminder overrides it with the run's day.
    when: formatDay(job.targetDate),
    // The date it is ready FROM — without it the deadline read as the truck's day.
    readyFrom: job.readyDate ? formatDay(job.readyDate) : undefined,
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
export function formatDay(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00+10:00`);

  return date.toLocaleDateString('en-AU', {
    timeZone: 'Australia/Sydney',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}
