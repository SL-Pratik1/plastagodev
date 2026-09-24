import type {
  AwaitingCallUp,
  CallUpRequest,
  PageMeta,
  PortalBookingDraft,
  PortalChangeRequest,
  PortalDashboard,
  PortalJob,
  PortalJobEdit,
  PortalJobListItem,
  PortalJobMessage,
  PortalJobMessageDraft,
  PortalScope as PortalScopeContract,
  PricePreview,
  ReadinessCertification,
  Role,
} from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { assertPlausibleReadyDate } from '../../lib/ready-date.js';
import { notificationService } from '../notifications/notification.service.js';
import { accountRepository } from '../accounts/account.repository.js';
import { jobService, type Caller as JobCaller } from '../jobs/job.service.js';
import { callUpService, type CallUpOutcome } from '../queues/call-up.service.js';
import { settingsRepository } from '../settings/settings.repository.js';
import {
  portalRepository,
  type PortalJobsQuery,
  type PortalScope,
} from './portal.repository.js';

const log = logger.child({ module: 'portal' });

/**
 * The customer portal (M5).
 *
 * ── The rule the whole domain turns on ────────────────────────────────────
 * A customer sees their own work and nothing else. A builder seeing another
 * builder's job would expose what a competitor pays, which is the worst failure
 * this system can have — so the scope comes from the SESSION, never from a
 * parameter, and it is folded into every query in the repository.
 *
 * ── Two customers, two journeys (Matt, 21:55) ─────────────────────────────
 * A BUILDER has site supervisors and a short booking form, because the area and
 * bag count already came off the purchase order. A CONTRACTOR gets one login, no
 * supervisors, and a form that asks for everything — because that form IS the
 * authorisation: *"they're just going to fill out the form"* (22:53).
 */

export interface Caller {
  userId: string;
  name: string;
  roles: readonly Role[];
  accountId: string | null;
}

const CUSTOMER_ADMIN: Role = 'customer-administrator';
const SITE_SUPERVISOR: Role = 'customer-site-supervisor';

export const portalService = {
  /**
   * Resolved from the session on every page load.
   *
   * Cheap and cached hard, because every portal screen needs it — and because
   * `canSeePricing` decides what the server is willing to send, so it must be
   * the same answer everywhere.
   */
  async scope(caller: Caller): Promise<PortalScopeContract> {
    const account = await requireAccount(caller);
    const settings = await settingsRepository.get();

    return {
      accountId: account.id,
      accountName: account.name,
      customerCode: account.code,
      accountType: account.accountType,
      capturesWeight: account.captureMode === 'area-and-weight',
      poRequired: account.poPolicy === 'required-before-invoice',
      /*
       * The office's prefix travels with the scope because the customer has to
       * quote the same number back when they pay (Matt, 7:07), and the portal
       * cannot read office settings.
       */
      invoiceNumberPrefix: settings.invoicing.invoiceNumberPrefix,
      canSeePricing: canSeePricing(caller),
      /*
       * What this field is NOT: the enforcement. The server narrows the query
       * regardless. This only tells the UI what to say about the narrowing —
       * "showing jobs you raised" rather than a silently short list.
       */
      visibility: isSupervisorOnly(caller) ? 'own-jobs' : 'account',
    };
  },

  /**
   * M5.7 — the screen that replaces phoning the office.
   *
   * The fields answer the questions that generate those calls: where is my
   * pickup, is anything late, what did we divert. A dashboard that answers a
   * question nobody rings about is one nobody opens.
   */
  async dashboard(caller: Caller): Promise<PortalDashboard> {
    const account = await requireAccount(caller);
    const scope = scopeFor(caller, account.id);

    const counts = await portalRepository.dashboardCounts(scope);

    /*
     * Money only for an administrator (M1.5). A supervisor's dashboard gets
     * null, not zero — zero would read as "nothing outstanding", which is a
     * different and wrong statement.
     */
    const outstanding = canSeePricing(caller)
      ? await portalRepository.outstandingInvoices(account.id)
      : null;

    return {
      generatedAt: new Date().toISOString(),
      openJobs: counts.openJobs,
      nextPickup: counts.nextPickup
        ? {
            jobId: counts.nextPickup._id.toHexString(),
            jobNumber: counts.nextPickup.jobNumber,
            siteName: counts.nextPickup.siteName,
            readyDate: counts.nextPickup.readyDate,
            status: counts.nextPickup.status,
            driverName: counts.nextPickup.driverName,
          }
        : null,
      atRiskJobs: counts.atRiskJobs,
      completedThisMonth: counts.completedThisMonth,
      areaThisMonthM2: counts.areaThisMonthM2,
      /*
       * ⚠️ Null on an m²-only account, not zero. A zero would read as "we
       * recovered nothing this month" to a customer who never buys weight
       * capture — see M2.3.
       */
      tonnesThisMonth:
        account.captureMode === 'area-and-weight'
          ? Math.round(counts.weightThisMonthKg / 100) / 10
          : null,
      outstandingInvoiceCount: outstanding?.count ?? null,
      outstandingInvoiceTotalIncGst: outstanding?.totalIncGst ?? null,
      /*
       * M8.3 — the direct attack on futile pickups. The reminder asks whether
       * the site is ready; this is where an unanswered ask becomes visible.
       */
      awaitingReadinessConfirmation: counts.awaitingReadiness,
    };
  },

  async jobs(
    query: PortalJobsQuery,
    caller: Caller,
  ): Promise<{ data: PortalJobListItem[]; meta: PageMeta }> {
    const account = await requireAccount(caller);
    return portalRepository.listJobs(query, scopeFor(caller, account.id), canSeePricing(caller));
  },

  async job(id: string, caller: Caller): Promise<PortalJob> {
    const account = await requireAccount(caller);

    const job = await portalRepository.findJob(
      id,
      scopeFor(caller, account.id),
      canSeePricing(caller),
      caller.userId,
    );

    // 404, not 403 — a 403 would confirm another customer's job exists.
    if (!job) throw AppError.notFound('No such job');

    return job;
  },

  /**
   * M5.1 — book a pickup. Roughly four fields, against today's seventeen.
   *
   * The account, the builder and the contact are absent by design: the session
   * already knows them, and the account name being free text is exactly why
   * leads currently arrive disguised as jobs.
   */
  async book(draft: PortalBookingDraft, caller: Caller): Promise<PortalJobListItem> {
    const account = await requireAccount(caller);

    /*
     * The same guard the office paths carry (`jobs`, and the futile reschedule
     * in `queues`). The portal walked straight past it: a customer could book —
     * or edit — a pickup ready in 2020 or in 2099, and the API took both. The
     * browser date input suggests a minimum and nothing enforces one, so a
     * mistyped year produced a job either permanently overdue at the top of
     * every at-risk list, or invisible below the fold forever. `targetDate` is
     * derived from this, so the SLA clock inherits the mistake.
     */
    assertPlausibleReadyDate(draft.readyDate);

    /*
     * M2.10 — a PO-required account cannot book without a reference. Refused
     * here rather than at invoicing, because the moment to ask a builder for
     * their PO number is while they are filling in the form, not three weeks
     * later when the invoice will not go out.
     */
    /*
     * ⚠️ Choosing a purchase order SATISFIES the policy.
     *
     * A confirmed order carries its own number, and that number is better than
     * a typed one — it is the string the builder's accounts system matches, and
     * a retyped copy can differ from it by a character (M2.12). Demanding the
     * text as well would be asking somebody to transcribe a document PlastaGo
     * is already holding.
     */
    if (
      account.poPolicy === 'required-before-invoice' &&
      draft.purchaseOrderId === null &&
      !draft.poNumber.trim()
    ) {
      throw AppError.validation('This account needs a purchase order', [
        {
          path: 'poNumber',
          message:
            'Choose the purchase order, or enter the PO reference — your invoice cannot be sent without it',
        },
      ]);
    }

    /*
     * The certification is three separate promises, and all three are required.
     * Zod already enforces `literal(true)` on each; this is the second gate, so
     * a future caller that skips validation still cannot book uncertified work.
     */
    assertCertified(draft.certification);

    // Reuses the office's own booking path, so a portal job and an office job
    // are the same job — same numbering, same pricing, same events.
    const created = await jobService.create(
      {
        accountId: account.id,
        siteName: draft.siteName,
        lotNumber: draft.lotNumber,
        addressLine: draft.addressLine,
        placeId: draft.placeId,
        builderName: draft.builderName,
        accessNotes: draft.accessNotes,
        gateHours: draft.gateHours,
        inductionRequired: draft.inductionRequired,
        craneAvailable: draft.craneAvailable,
        siteContactName: draft.siteContactName,
        siteContactMobile: draft.siteContactMobile,
        siteContactEmail: draft.siteContactEmail,
        poNumber: draft.poNumber,
        // Overrides the number, the area and the bag count when set. See the
        // field on `PortalBookingDraftSchema`.
        purchaseOrderId: draft.purchaseOrderId,
        readyDate: draft.readyDate,
        serviceLevel: draft.serviceLevel,
        freightItem: draft.craneAvailable ? 'plasterboard-bagged' : 'plasterboard-hand-load',
        /*
         * ⚠️ Null means "the purchase order has it" — the builder's supervisor
         * genuinely does not know (Matt, 29:21). The office booking path takes a
         * number, so null becomes 0 there and is stored back as null.
         */
        expectedAreaM2: draft.expectedAreaM2 ?? 0,
        bagCount: draft.bagCount,
        notes: draft.notes,
      },
      toJobCaller(caller),
    );

    // The certification is filed against the job it certifies, immediately.
    await portalRepository.certify({
      jobId: created.id,
      jobReady: draft.certification.jobReady,
      truckAccessible: draft.certification.truckAccessible,
      freeOfContaminants: draft.certification.freeOfContaminants,
      certifiedByUserId: caller.userId,
      certifiedByName: caller.name,
      certifiedByCompany: account.name,
    });

    log.info(
      { jobId: created.id, jobNumber: created.jobNumber, accountId: account.id, by: caller.name },
      'job booked in the portal',
    );

    const job = await portalRepository.findJob(
      created.id,
      scopeFor(caller, account.id),
      canSeePricing(caller),
      caller.userId,
    );
    if (!job) throw new Error('Job vanished immediately after being booked');

    return job;
  },

  /**
   * M6.9 — the estimate, for roles that may see pricing.
   *
   * ⚠️ Refused outright for a site supervisor (M1.5). Not hidden in the UI:
   * the figure never leaves the server.
   */
  /**
   * The orders on this account with no job yet (M2.12b).
   *
   * ── Why the customer sees this list at all ────────────────────────────────
   * Matt, 30:40: *"this guy, he can log into his portal and that job, that PO
   * that we got will be sitting there on his account and he can go call this up
   * for the 21st because this email is not coming to us."*
   *
   * The builders' own systems drop these notices, and when they do the work
   * still has to happen. This is the screen that makes that recoverable without
   * a phone call to the office.
   */
  async awaitingCallUp(
    query: { page: number; pageSize: number },
    caller: Caller,
  ): Promise<{ data: AwaitingCallUp[]; meta: PageMeta }> {
    const account = await requireAccount(caller);

    /*
     * ⚠️ The account comes from the SESSION, never from the request. No portal
     * route takes an account id, which is what stops a URL widening what a
     * customer can see — see the note on the router.
     */
    return callUpService.listAwaiting(
      { accountId: account.id, page: query.page, pageSize: query.pageSize },
      { ...caller, accountId: account.id },
    );
  },

  /**
   * Calling one of their own orders up (Matt, 29:03).
   *
   * Two taps rather than a booking form: everything about the job is already on
   * the order, which is the whole reason a supervisor can do this at all — they
   * cannot answer an area or a bag allowance, and should not be asked.
   */
  async callUp(
    purchaseOrderId: string,
    request: CallUpRequest,
    caller: Caller,
  ): Promise<CallUpOutcome> {
    const account = await requireAccount(caller);

    // Scoped in the service by `accountId`, so an order belonging to another
    // account is a 404 here exactly as it is in the office queue.
    return callUpService.callUpByHand(purchaseOrderId, request, {
      ...caller,
      accountId: account.id,
    });
  },

  async quote(draft: PortalBookingDraft, caller: Caller): Promise<PricePreview> {
    const account = await requireAccount(caller);

    if (!canSeePricing(caller)) {
      throw AppError.forbidden('Pricing is not shown on your login');
    }

    return jobService.preview(
      {
        accountId: account.id,
        siteName: draft.siteName,
        lotNumber: draft.lotNumber,
        addressLine: draft.addressLine,
        placeId: draft.placeId,
        builderName: draft.builderName,
        accessNotes: draft.accessNotes,
        gateHours: draft.gateHours,
        inductionRequired: draft.inductionRequired,
        craneAvailable: draft.craneAvailable,
        siteContactName: draft.siteContactName,
        siteContactMobile: draft.siteContactMobile,
        siteContactEmail: draft.siteContactEmail,
        poNumber: draft.poNumber,
        // Overrides the number, the area and the bag count when set. See the
        // field on `PortalBookingDraftSchema`.
        purchaseOrderId: draft.purchaseOrderId,
        readyDate: draft.readyDate,
        serviceLevel: draft.serviceLevel,
        freightItem: draft.craneAvailable ? 'plasterboard-bagged' : 'plasterboard-hand-load',
        expectedAreaM2: draft.expectedAreaM2 ?? 0,
        bagCount: draft.bagCount,
        notes: draft.notes,
      },
      toJobCaller(caller),
    );
  },

  /**
   * M5.4 — a direct edit, allowed only while the job is still editable.
   *
   * The client's own rule: freely editable until it reaches a run sheet. After
   * that the driver has it and the day is planned around it, so a change becomes
   * a request instead — `requestChange` below.
   */
  async editJob(id: string, input: PortalJobEdit, caller: Caller): Promise<PortalJobListItem> {
    const account = await requireAccount(caller);
    const scope = scopeFor(caller, account.id);

    const existing = await portalRepository.findJobForEdit(id, scope);
    if (!existing) throw AppError.notFound('No such job');

    if (!existing.editable) {
      throw AppError.conflict(
        'This pickup is already allocated to a run — send a change request instead',
      );
    }

    // See the note in `book` — an edit moves the ready date too, and restarts
    // the SLA clock from it.
    assertPlausibleReadyDate(input.readyDate);

    const slaBusinessDays = await settingsRepository.slaBusinessDays();

    const changed = await portalRepository.editJob(id, scope, {
      readyDate: input.readyDate,
      // The SLA clock restarts from the customer's new ready date (M2.4a).
      targetDate: addBusinessDays(input.readyDate, slaBusinessDays),
      expectedAreaM2: input.expectedAreaM2,
      bagCount: input.bagCount,
      serviceLevel: input.serviceLevel,
      poNumber: input.poNumber.trim() || null,
      notes: input.notes,
    });

    if (!changed) {
      // The allocator put it on a run between the read and the write.
      throw AppError.conflict('That pickup was allocated while you were editing it — reload');
    }

    return this.jobListItem(id, caller);
  },

  /**
   * M5.4 — once the job is on a run sheet, the change routes to the office.
   *
   * Not auto-applied: a reschedule the customer asked for may collide with a run
   * that is already staffed, and only the allocator can see that.
   */
  async requestChange(id: string, input: PortalChangeRequest, caller: Caller): Promise<void> {
    const account = await requireAccount(caller);
    const scope = scopeFor(caller, account.id);

    const existing = await portalRepository.findJobForEdit(id, scope);
    if (!existing) throw AppError.notFound('No such job');

    if (input.kind === 'reschedule' && !input.requestedDate) {
      throw AppError.validation('A reschedule needs a date', [
        { path: 'requestedDate', message: 'Choose when the site will be ready' },
      ]);
    }

    // A second identical ask does not make the office move faster; it makes the
    // queue longer and the customer feel ignored twice.
    if (await portalRepository.hasOpenChangeRequest(id)) {
      throw AppError.conflict(
        'You already have a change request open on this pickup — the office is looking at it',
      );
    }

    await portalRepository.requestChange({
      jobId: id,
      accountId: account.id,
      kind: input.kind,
      requestedDate: input.kind === 'reschedule' ? input.requestedDate : null,
      note: input.note.trim(),
      requestedByUserId: caller.userId,
      requestedByName: caller.name,
    });

    /*
     * ⚠️ The customer is told "Request sent to the office". Until this call
     * existed that was not true of anything: the request was written to
     * `changerequests` and read by no office screen, no queue and no alert,
     * so a reschedule or a cancellation asked for after allocation reached
     * nobody. It is the ONLY channel a customer has once the job is on a run
     * sheet — `editJob` refuses and points them here.
     */
    await notificationService.notifyOffice({
      // The allocator too — whether the run has room is theirs to see.
      audience: 'dispatch',
      category: 'exception',
      /*
       * A cancellation is urgent and the others are not: a truck may be about
       * to be sent to a site that no longer wants it, and that is a wasted run
       * plus a futile charge argument. A reschedule can wait for the queue.
       */
      severity: input.kind === 'cancel' ? 'urgent' : 'action',
      title: `${describeChangeKind(input.kind)} — #${String(existing.jobNumber)}`,
      body: `${caller.name} at ${account.name} asked to ${describeChangeAsk(input)}. ${input.note.trim()}`,
      href: `/admin/queues/change-requests`,
      // They cannot open the queues; the job is where they can act on it.
      allocatorHref: `/admin/jobs/${id}`,
      /*
       * One open request per job is all the service allows, so the job is the
       * subject. A second ask after the first is resolved is genuinely new and
       * gets its own notification.
       */
      subjectKey: `change-request:${id}:${String(Date.now())}`,
      jobId: id,
      jobNumber: existing.jobNumber,
    });

    log.info(
      { jobId: id, kind: input.kind, accountId: account.id, by: caller.name },
      'change request raised from the portal',
    );
  },

  /**
   * M5.5 — flag urgent. The office is alerted and the board highlights it.
   *
   * The badge was always drawn; the alert is new. This comment described both
   * from the beginning and only one of them existed.
   */
  async setUrgency(id: string, urgent: boolean, caller: Caller): Promise<PortalJobListItem> {
    const account = await requireAccount(caller);

    const changed = await portalRepository.setUrgency(id, scopeFor(caller, account.id), urgent);
    if (!changed) {
      throw AppError.notFound('No such job, or it has already been collected');
    }

    log.info({ jobId: id, urgent, by: caller.name }, 'urgency changed from the portal');

    /*
     * ⚠️ The portal tells the customer "The office has been alerted". Nothing
     * was: this method set the flag and logged. The board does draw an Urgent
     * badge, so the flag was visible to anyone already looking at it — but a
     * customer marking a job urgent is precisely the case where nobody is.
     *
     * Only on the way IN. Standing a job back down is not news, and a pair of
     * notifications for somebody toggling a switch twice is how an inbox stops
     * being read.
     */
    if (urgent) {
      const job = await portalRepository.findJobForEdit(id, scopeFor(caller, account.id));

      /*
       * `setUrgency` already returned `changed`, so the job is there. Re-read
       * for its number rather than trusting that: the notification names the
       * job, and a title reading "Marked urgent — #0" is worse than no
       * notification at all.
       */
      if (job) {
        await notificationService.notifyOffice({
          // Sooner means a different run — the allocator's call.
          audience: 'dispatch',
          category: 'exception',
          severity: 'action',
          title: `Marked urgent — #${String(job.jobNumber)}`,
          body: `${caller.name} at ${account.name} needs this pickup sooner. Confirm what is possible.`,
          href: `/admin/jobs/${id}`,
          /*
           * Keyed on the job, not the moment: a customer toggling urgent off
           * and on again is the same ask, and the office does not need it
           * twice. A change REQUEST is keyed with a timestamp instead, because
           * a second one genuinely is a new thing to read.
           */
          subjectKey: `portal-urgent:${id}`,
          jobId: id,
          jobNumber: job.jobNumber,
        });
      }
    }

    return this.jobListItem(id, caller);
  },

  /**
   * M5.2 — certify readiness on a job booked without it, or re-confirm.
   *
   * Writes a NEW record rather than updating the old one. What an invoice
   * dispute asks is "what did they promise, and when" — and a re-confirmation
   * two days before the pickup is a different, stronger fact than one made at
   * booking three weeks earlier.
   */
  async certifyReadiness(
    id: string,
    input: ReadinessCertification,
    caller: Caller,
  ): Promise<PortalJobListItem> {
    const account = await requireAccount(caller);
    const scope = scopeFor(caller, account.id);

    const existing = await portalRepository.findJobForEdit(id, scope);
    if (!existing) throw AppError.notFound('No such job');

    if (existing.status === 'completed' || existing.status === 'cancelled') {
      throw AppError.conflict('That pickup is finished — there is nothing left to certify');
    }

    assertCertified(input);

    await portalRepository.certify({
      jobId: id,
      jobReady: input.jobReady,
      truckAccessible: input.truckAccessible,
      freeOfContaminants: input.freeOfContaminants,
      certifiedByUserId: caller.userId,
      certifiedByName: caller.name,
      certifiedByCompany: account.name,
    });

    log.info({ jobId: id, by: caller.name }, 'readiness certified from the portal');
    return this.jobListItem(id, caller);
  },

  /**
   * M2.11 — reply to the office on a pickup's message thread.
   *
   * ── Who may ───────────────────────────────────────────────────────────────
   * Anyone who can see the pickup: an administrator on any of the account's
   * pickups, a site supervisor on the ones they booked. Scoped exactly like
   * reading it, so a pickup the portal will not show is a 404 here too.
   *
   * ── Where it lands ────────────────────────────────────────────────────────
   * On the job's `customer` thread, through the same path the office posts
   * with, so the office reads it in the console's Customer thread and is
   * notified. It can never reach the internal or driver threads: the
   * visibility is fixed here, not taken from the request.
   *
   * Allowed on a finished pickup too. "Why was this one futile?" is asked
   * after the fact, and the office's answer belongs on the job.
   */
  async postMessage(
    id: string,
    draft: PortalJobMessageDraft,
    caller: Caller,
  ): Promise<PortalJobMessage> {
    const account = await requireAccount(caller);

    // 404, not 403 — the same answer as reading a pickup outside the scope.
    const existing = await portalRepository.findJobForEdit(id, scopeFor(caller, account.id));
    if (!existing) throw AppError.notFound('No such job');

    const comment = await jobService.addComment(
      id,
      { body: draft.body, visibility: 'customer' },
      toJobCaller({ ...caller, accountId: account.id }),
    );

    log.info({ jobId: id, accountId: account.id, by: caller.name }, 'message sent from the portal');

    return {
      id: comment.id,
      body: comment.body,
      author: comment.author,
      at: comment.at,
      fromCustomer: true,
      mine: true,
    };
  },

  /** Re-reads one job as a list item, for the mutations that return one. */
  async jobListItem(id: string, caller: Caller): Promise<PortalJobListItem> {
    const account = await requireAccount(caller);

    const job = await portalRepository.findJob(
      id,
      scopeFor(caller, account.id),
      canSeePricing(caller),
      caller.userId,
    );
    if (!job) throw AppError.notFound('No such job');

    return job;
  },
};

/* ── Describing a change request ─────────────────────────────────────────── */

/** The notification title, in the office’s words rather than the enum’s. */
function describeChangeKind(kind: PortalChangeRequest['kind']): string {
  if (kind === 'cancel') return 'Cancellation requested';
  if (kind === 'reschedule') return 'Reschedule requested';
  return 'Change requested';
}

/** The body, so the notification says what was actually asked for. */
function describeChangeAsk(input: PortalChangeRequest): string {
  if (input.kind === 'cancel') return 'cancel this pickup';
  if (input.kind === 'reschedule') {
    return input.requestedDate ? `move it to ${input.requestedDate}` : 'move it';
  }
  return 'change something about it';
}

/* ── Scoping ─────────────────────────────────────────────────────────────── */

function isSupervisorOnly(caller: Caller): boolean {
  // A supervisor who is ALSO an administrator gets the wider view.
  return caller.roles.includes(SITE_SUPERVISOR) && !caller.roles.includes(CUSTOMER_ADMIN);
}

/**
 * M1.5 — a site supervisor never sees money.
 *
 * Used by the repository to null the figures out of the payload entirely, not
 * merely to hide them: what a supervisor must not see, they must not receive.
 */
function canSeePricing(caller: Caller): boolean {
  return !isSupervisorOnly(caller);
}

function scopeFor(caller: Caller, accountId: string): PortalScope {
  return {
    accountId,
    bookedByUserId: isSupervisorOnly(caller) ? caller.userId : null,
  };
}

/**
 * The caller's own account, or a refusal.
 *
 * ⚠️ Reads the account id from the SESSION and nowhere else. There is no portal
 * route that takes an account id, deliberately — a parameter is something that
 * can be changed.
 */
async function requireAccount(caller: Caller) {
  if (!caller.accountId) {
    // A customer-role session with no account is broken, not permissive.
    throw AppError.forbidden('Your login is not linked to a customer account');
  }

  const account = await accountRepository.findById(caller.accountId, {
    accountId: caller.accountId,
  });

  if (!account) throw AppError.forbidden('Your customer account could not be found');

  if (account.status !== 'active') {
    throw AppError.forbidden(
      'This account is not active. Please contact PlastaGo on 1300 395 438.',
    );
  }

  return account;
}

function toJobCaller(caller: Caller): JobCaller {
  return {
    userId: caller.userId,
    name: caller.name,
    roles: caller.roles,
    accountId: caller.accountId,
  };
}

/**
 * All three promises, or none.
 *
 * A second gate behind Zod's `literal(true)`. The futile charge stands on this
 * record, so it is worth refusing twice rather than storing a half-certification
 * that reads as a full one.
 */
function assertCertified(certification: ReadinessCertification): void {
  if (
    !certification.jobReady ||
    !certification.truckAccessible ||
    !certification.freeOfContaminants
  ) {
    throw AppError.validation('All three readiness confirmations are required', [
      { path: 'certification', message: 'Confirm all three before booking' },
    ]);
  }
}

/** M2.4a — the SLA is in BUSINESS days; the trucks do not run at weekends. */
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
