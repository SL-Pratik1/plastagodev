import type {
  PageMeta,
  PortalBookingDraft,
  PortalChangeRequest,
  PortalDashboard,
  PortalJob,
  PortalJobEdit,
  PortalJobListItem,
  PortalScope as PortalScopeContract,
  PricePreview,
  ReadinessCertification,
  Role,
} from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { accountRepository } from '../accounts/account.repository.js';
import { jobService, type Caller as JobCaller } from '../jobs/job.service.js';
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
     * M2.10 — a PO-required account cannot book without a reference. Refused
     * here rather than at invoicing, because the moment to ask a builder for
     * their PO number is while they are filling in the form, not three weeks
     * later when the invoice will not go out.
     */
    if (account.poPolicy === 'required-before-invoice' && !draft.poNumber.trim()) {
      throw AppError.validation('This account needs a purchase order number', [
        {
          path: 'poNumber',
          message: 'Enter the PO or job reference — your invoice cannot be sent without it',
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

    const settings = await settingsRepository.get();

    const changed = await portalRepository.editJob(id, scope, {
      readyDate: input.readyDate,
      // The SLA clock restarts from the customer's new ready date (M2.4a).
      targetDate: addBusinessDays(input.readyDate, settings.general.slaBusinessDays),
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

    log.info(
      { jobId: id, kind: input.kind, accountId: account.id, by: caller.name },
      'change request raised from the portal',
    );
  },

  /** M5.5 — flag urgent. The office is alerted and the board highlights it. */
  async setUrgency(id: string, urgent: boolean, caller: Caller): Promise<PortalJobListItem> {
    const account = await requireAccount(caller);

    const changed = await portalRepository.setUrgency(id, scopeFor(caller, account.id), urgent);
    if (!changed) {
      throw AppError.notFound('No such job, or it has already been collected');
    }

    log.info({ jobId: id, urgent, by: caller.name }, 'urgency changed from the portal');
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

  /** Re-reads one job as a list item, for the mutations that return one. */
  async jobListItem(id: string, caller: Caller): Promise<PortalJobListItem> {
    const account = await requireAccount(caller);

    const job = await portalRepository.findJob(
      id,
      scopeFor(caller, account.id),
      canSeePricing(caller),
    );
    if (!job) throw AppError.notFound('No such job');

    return job;
  },
};

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
