import type {
  ExceptionReason,
  Job,
  JobComment,
  JobCommentDraft,
  JobDraft,
  JobListItem,
  PageMeta,
  PricePreview,
  Role,
} from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { withTransaction } from '../../lib/transaction.js';
import { accountRepository } from '../accounts/account.repository.js';
import { placeService } from '../places/place.service.js';
import { pricingService } from '../settings/pricing.service.js';
import { settingsRepository } from '../settings/settings.repository.js';
import {
  jobRepository,
  type JobScope,
  type ListJobsQuery,
} from './job.repository.js';

const log = logger.child({ module: 'jobs' });

/**
 * Jobs (M2) — the centre of the system.
 *
 * ── What this file is responsible for ─────────────────────────────────────
 * Three things a repository cannot do: deciding WHO sees which jobs, resolving
 * a booking form into a priced job, and refusing the state changes that would
 * corrupt history. Everything else is storage.
 */

export interface Caller {
  userId: string;
  name: string;
  roles: readonly Role[];
  accountId: string | null;
}

const CUSTOMER_ADMIN: Role = 'customer-administrator';
const SITE_SUPERVISOR: Role = 'customer-site-supervisor';
const CUSTOMER_ROLES = new Set<Role>([CUSTOMER_ADMIN, SITE_SUPERVISOR]);

/** Roles that may book, cancel and reschedule on anyone's behalf. */
const OFFICE_ROLES = new Set<Role>(['super-admin', 'operations', 'office-staff', 'allocator']);

/**
 * An id that matches nothing, for a customer whose session carries no account.
 *
 * ⚠️ Fail CLOSED. A customer-role caller with a null `accountId` is a broken
 * session, and the safe reading of "which account is this" with no answer is
 * "none of them" — never "all of them".
 */
const MATCHES_NOTHING = '000000000000000000000000';

/**
 * Statuses a job may be cancelled FROM.
 *
 * Completed work is a historical record: the truck went, the customer was
 * served, and the tonnage is on a diversion certificate. Cancelling that does
 * not undo any of it — it just makes the record wrong.
 */
const CANCELLABLE_FROM = ['booked', 'assigned', 'in-transit', 'arrived'] as const;

export const jobService = {
  async list(
    query: ListJobsQuery,
    caller: Caller,
  ): Promise<{ data: JobListItem[]; meta: PageMeta }> {
    return jobRepository.list(query, scopeFor(caller));
  },

  async get(id: string, caller: Caller): Promise<Job> {
    const job = await jobRepository.findById(id, scopeFor(caller));

    // 404, not 403. A 403 confirms the job exists, which is exactly what a
    // caller probing for another account's work wants to know.
    if (!job) throw AppError.notFound('No such job');

    return job;
  },

  /**
   * M2.1 / M6.9 — the estimate shown BEFORE saving.
   *
   * Runs the same `pricingService.quote` the create below runs, on purpose: if
   * the preview and the saved job could disagree, the number the office quoted
   * down the phone would not be the number on the invoice.
   */
  async preview(draft: JobDraft, caller: Caller): Promise<PricePreview> {
    const { account, place } = await resolveDraft(draft, caller);

    return pricingService.quote({
      rateCardId: account.rateCardId,
      zone: place.zone,
      // Zero means "nobody has told us yet", which is the fixed-price builder's
      // normal case (Matt, 31:04) — not an area of nothing.
      expectedAreaM2: draft.expectedAreaM2 > 0 ? draft.expectedAreaM2 : null,
      bagCount: draft.bagCount,
    });
  },

  /**
   * M2.1 — book a pickup.
   *
   * ── Why the job number is taken before the job is written ─────────────────
   * `takeNextNumber` is an atomic `$inc`, so two simultaneous bookings can never
   * receive the same number (M1.4). The cost is that a failed create burns a
   * number — a gap in the sequence. That is the right trade: a gap is a
   * curiosity, a collision is a reconciliation nobody can unpick.
   */
  async create(draft: JobDraft, caller: Caller): Promise<JobListItem> {
    const { account, place } = await resolveDraft(draft, caller);

    if (account.status !== 'active') {
      throw AppError.conflict(
        `${account.name} is not an active account, so a pickup cannot be booked against it`,
      );
    }

    const settings = await settingsRepository.get();

    const quote = await pricingService.quote({
      rateCardId: account.rateCardId,
      zone: place.zone,
      expectedAreaM2: draft.expectedAreaM2 > 0 ? draft.expectedAreaM2 : null,
      bagCount: draft.bagCount,
    });

    const jobNumber = await settingsRepository.takeNextNumber('nextJobNumber');

    /*
     * The job and its opening event are ONE unit of work.
     *
     * A job with no "Job created" line is a job whose timeline lies about where
     * it came from, and M2.3's whole purpose is that the timeline is complete.
     * So both writes happen inside `withTransaction`: a real transaction where
     * the deployment supports one, and where it does not — a standalone MongoDB,
     * which is what runs in development — the PARENT is written first and
     * `compensate` removes it, so a failure leaves nothing rather than half.
     */
    let createdId: string | null = null;

    const created = await withTransaction(
      async () =>
        jobRepository.create({
          jobNumber,
          accountId: account.id,
          accountName: account.name,
          brandId: account.brandId,
          builderName: draft.builderName.trim(),
          siteName: draft.siteName.trim(),
          lotNumber: draft.lotNumber.trim() || null,
          addressLine: draft.addressLine.trim(),
          // From the PICKED suburb, never from typed text. The zone prices the
          // job (M6.3) and the pin plots it, and neither can be guessed.
          suburb: place.suburb,
          postcode: place.postcode,
          zone: place.zone,
          latitude: place.latitude,
          longitude: place.longitude,
          accessNotes: draft.accessNotes.trim(),
          gateHours: draft.gateHours.trim() || null,
          inductionRequired: draft.inductionRequired,
          craneAvailable: draft.craneAvailable,
          siteContactName: draft.siteContactName.trim() || null,
          siteContactMobile: draft.siteContactMobile.trim() || null,
          siteContactEmail: draft.siteContactEmail.trim() || null,
          poNumber: draft.poNumber.trim() || null,
          bookedByName: caller.name,
          // Only a portal booking carries a scoping user. A job keyed in by the
          // office has none, and a null is invisible to every site supervisor —
          // which is the safe direction. See `bookedByUserId` on the model.
          bookedByUserId: isCustomer(caller) ? caller.userId : null,
          bookedBySource: isCustomer(caller) ? 'portal' : 'office',
          readyDate: draft.readyDate,
          // M2.4a — the SLA is in BUSINESS days, from the customer's ready date.
          targetDate: addBusinessDays(draft.readyDate, settings.general.slaBusinessDays),
          serviceLevel: draft.serviceLevel,
          freightItem: draft.freightItem,
          expectedAreaM2: draft.expectedAreaM2 > 0 ? draft.expectedAreaM2 : null,
          bagCount: draft.bagCount,
          notes: draft.notes.trim(),
          totalExGst: quote.subtotalExGst,
          gst: quote.gst,
          totalIncGst: quote.totalIncGst,
          /*
           * M4.8b — the account's rule, resolved NOW and frozen on the job.
           *
           * Never read live from the account afterwards: a job booked today
           * under today's rule must still show today's rule when it is audited
           * next year. Re-deriving it would let a settings change rewrite the
           * past and make a compliant job look like a gap.
           */
          riskAssessmentRequired: account.riskAssessmentRequired,
        }).then(async (job) => {
          // Remembered so `compensate` can find the job if the event write below
          // fails on a deployment with no transactions.
          createdId = job.id;

          await jobRepository.appendEvent({
            jobId: job.id,
            label: 'Job created',
            actor: caller.name,
            status: 'booked',
            detail: isCustomer(caller)
              ? 'Booked in the customer portal'
              : 'Created in the admin console',
          });

          return job;
        }),
      {
        label: 'create-job',
        compensate: async () => {
          if (createdId === null) return;
          log.warn({ jobNumber, jobId: createdId }, 'removing a half-created job');
          await jobRepository.deleteCascade(createdId);
        },
      },
    );

    log.info(
      { jobId: created.id, jobNumber, accountId: account.id, zone: place.zone },
      'job created',
    );

    return created;
  },

  /**
   * M2.4 — cancel with a STRUCTURED reason, never free text.
   *
   * A reason people pick from a list can be counted; a reason people type
   * cannot. "How many jobs did we lose to access problems last quarter" is a
   * question the office should be able to answer without reading notes.
   */
  async cancel(
    id: string,
    reason: ExceptionReason,
    note: string,
    caller: Caller,
  ): Promise<void> {
    const job = await jobRepository.findSummary(id, scopeFor(caller));
    if (!job) throw AppError.notFound('No such job');

    assertMayChange(caller);

    if (job.status === 'cancelled') {
      // Idempotent-looking but refused: a second cancel would overwrite the
      // first one's reason, and the first one is the true one.
      throw AppError.conflict('That job is already cancelled');
    }

    if (!isCancellable(job.status)) {
      throw AppError.conflict(
        'A job that has been completed cannot be cancelled — the collection already happened',
      );
    }

    /*
     * The status is re-checked inside the write. Between the read above and
     * here, a driver could have completed the job on their phone; the update
     * matches nothing and we say so rather than silently cancelling finished
     * work.
     */
    const changed = await jobRepository.cancel(id, reason, note.trim() || null, [
      ...CANCELLABLE_FROM,
    ]);

    if (!changed) {
      throw AppError.conflict('That job changed while you were looking at it — reload and retry');
    }

    await jobRepository.appendEvent({
      jobId: id,
      label: 'Job cancelled',
      actor: caller.name,
      status: 'cancelled',
      detail: note.trim() || null,
    });

    log.info({ jobId: id, jobNumber: job.jobNumber, reason }, 'job cancelled');
  },

  /** M2.4a — a new ready date restarts the SLA clock from the customer's date. */
  async reschedule(id: string, readyDate: string, caller: Caller): Promise<void> {
    const job = await jobRepository.findSummary(id, scopeFor(caller));
    if (!job) throw AppError.notFound('No such job');

    assertMayChange(caller);

    if (!isCancellable(job.status)) {
      throw AppError.conflict(
        'That job is finished, so there is nothing left to reschedule',
      );
    }

    const settings = await settingsRepository.get();
    const targetDate = addBusinessDays(readyDate, settings.general.slaBusinessDays);

    const changed = await jobRepository.reschedule(id, readyDate, targetDate);
    if (!changed) throw AppError.notFound('No such job');

    await jobRepository.appendEvent({
      jobId: id,
      label: 'Ready date changed',
      actor: caller.name,
      status: null,
      detail: `Moved to ${readyDate}`,
    });

    log.info({ jobId: id, jobNumber: job.jobNumber, readyDate, targetDate }, 'job rescheduled');
  },

  /**
   * M2.11 / M8.6 — post to one of the job's three threads.
   *
   * ── Why a driver comment can be refused ───────────────────────────────────
   * M8.6's shape is *"between the office and the driver"*, singular: the driver
   * in question is the one allocated to this job. On an unallocated job there is
   * no such person, so there is nobody for the message to reach — and silently
   * accepting it would put a message in a thread that never gets delivered,
   * which is worse than refusing to send it.
   */
  async addComment(jobId: string, draft: JobCommentDraft, caller: Caller): Promise<JobComment> {
    const job = await jobRepository.findSummary(jobId, scopeFor(caller));
    if (!job) throw AppError.notFound('No such job');

    if (isCustomer(caller) && draft.visibility !== 'customer') {
      // A customer writing into the internal or driver thread would be posting
      // somewhere they cannot read back — and the internal thread is the one
      // place the office talks about the customer.
      throw AppError.forbidden('You can only post to the thread you can see');
    }

    if (draft.visibility === 'driver' && job.driverId === null) {
      throw AppError.conflict(
        'This job has no allocated driver, so there is nobody to send it to',
      );
    }

    const now = new Date();

    return jobRepository.addComment({
      jobId,
      body: draft.body.trim(),
      author: caller.name,
      authorId: caller.userId,
      visibility: draft.visibility,
      // A driver comment pushes to their app (M4.11 · F45). Internal and
      // customer comments are not pushed, so they carry no delivery state —
      // null rather than a timestamp that would imply one.
      deliveredAt: draft.visibility === 'driver' ? now : null,
      fromDriver: false,
    });
  },
};

/* ── Scoping ─────────────────────────────────────────────────────────────── */

function isCustomer(caller: Caller): boolean {
  return caller.roles.some((role) => CUSTOMER_ROLES.has(role));
}

/**
 * What this caller is allowed to see.
 *
 * ── The three boundaries ──────────────────────────────────────────────────
 *  • Office staff see everything.
 *  • A customer administrator sees their whole account.
 *  • A site supervisor sees only the jobs THEY raised — because with sites
 *    removed (Matt, 0:29) there is nothing else left to scope them by, and
 *    Matt asked for exactly this at 18:15: *"I just want to make sure site
 *    supervisors can submit their jobs and be able to see the jobs they've
 *    submitted."*
 *
 * A supervisor who is also an administrator gets the wider of the two, which is
 * why the supervisor clause checks that they are NOT an administrator.
 */
function scopeFor(caller: Caller): JobScope {
  if (!isCustomer(caller)) {
    return { accountId: null, bookedByUserId: null, driverId: null };
  }

  const accountId = caller.accountId ?? MATCHES_NOTHING;
  const isSupervisorOnly =
    caller.roles.includes(SITE_SUPERVISOR) && !caller.roles.includes(CUSTOMER_ADMIN);

  return {
    accountId,
    bookedByUserId: isSupervisorOnly ? caller.userId : null,
    driverId: null,
  };
}

/**
 * Who may change a job that already exists.
 *
 * A customer administrator may cancel and reschedule their own work — that is
 * the point of the portal. A site supervisor may not: they raise pickups, and
 * cancelling one their site is waiting on is a decision for whoever runs the
 * account.
 */
function assertMayChange(caller: Caller): void {
  const allowed =
    caller.roles.some((role) => OFFICE_ROLES.has(role)) || caller.roles.includes(CUSTOMER_ADMIN);

  if (!allowed) {
    throw AppError.forbidden('Ask your account administrator to change a booked pickup');
  }
}

function isCancellable(status: Job['status']): boolean {
  return (CANCELLABLE_FROM as readonly string[]).includes(status);
}

/* ── Resolving a draft ───────────────────────────────────────────────────── */

/**
 * The account and the place behind a booking form.
 *
 * Both are resolved SERVER-SIDE from ids. The browser sends `accountId` and
 * `placeId` and nothing else about either — sending the zone or the rate card
 * would let a caller nominate its own, and the zone decides the price (M6.3).
 */
async function resolveDraft(draft: JobDraft, caller: Caller) {
  const scope = scopeFor(caller);

  /*
   * The account is fetched through the caller's OWN scope, so a customer cannot
   * book a job against somebody else's account by pasting its id. For office
   * staff the scope is unrestricted and this is an ordinary lookup.
   */
  const account = await accountRepository.findById(draft.accountId, {
    accountId: scope.accountId,
  });

  if (!account) {
    throw AppError.validation('That account could not be found', [
      { path: 'accountId', message: 'Choose an account from the list' },
    ]);
  }

  // Throws a 422 against `placeId` when the suburb is not one PlastaGo services.
  const place = await placeService.require(draft.placeId);

  return { account, place };
}

/* ── Dates ───────────────────────────────────────────────────────────────── */

/**
 * M2.4a — the target date is the ready date plus the SLA in BUSINESS days.
 *
 * Weekends are skipped because the trucks do not run on them, so counting them
 * would promise a collection on a Sunday. Public holidays are not modelled: NSW
 * has its own calendar and getting it wrong in either direction is worse than a
 * rule everybody understands.
 *
 * UTC arithmetic throughout on a date-only value, so a server in another
 * timezone cannot shift the answer by a day.
 */
function addBusinessDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);

  if (Number.isNaN(date.getTime())) {
    throw AppError.validation('That is not a valid date', [
      { path: 'readyDate', message: 'Choose a date from the calendar' },
    ]);
  }

  let remaining = days;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }

  return date.toISOString().slice(0, 10);
}
