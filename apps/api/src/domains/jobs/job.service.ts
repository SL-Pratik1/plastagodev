import type {
  ExceptionReason,
  Job,
  JobCharge,
  JobChargeDraft,
  JobComment,
  JobCommentDraft,
  JobDraft,
  JobListItem,
  LocationSource,
  PageMeta,
  PricePreview,
  Role,
} from '@plastago/shared';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/app-error.js';
import { distanceKm } from '../../lib/geo.js';
import { centsToMoney, moneyToCents } from '../../lib/money.js';
import { getMapsProvider, isPrecise, type MapsProvider } from '../../integrations/maps.js';
import { assertPlausibleReadyDate } from '../../lib/ready-date.js';
import { logger } from '../../lib/logger.js';
import { withTransaction } from '../../lib/transaction.js';
import { jobNotices } from '../notifications/job-notices.service.js';
import { accountRepository } from '../accounts/account.repository.js';
import { placeService } from '../places/place.service.js';
import {
  purchaseOrderRepository,
  type BookablePurchaseOrder,
} from '../queues/purchase-order.repository.js';
import { pricingService } from '../settings/pricing.service.js';
import { settingsRepository } from '../settings/settings.repository.js';
import {
  writeQuotedCharges,
  jobRepository,
  jobsForPurchaseOrders,
  type JobScope,
  type ListJobsQuery,
} from './job.repository.js';

/**
 * A purchase order as the booking picker shows it.
 *
 * `usedByJobNumber` is why this is not just `BookablePurchaseOrder`: an order
 * already on a job cannot be booked again (one PO, one invoice), and the picker
 * has to say which job took it rather than quietly hiding the row.
 */
export interface BookablePurchaseOrderOption extends BookablePurchaseOrder {
  usedByJobNumber: number | null;
}

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

/**
 * Roles allowed to see what a job is worth.
 *
 * ⚠️ The ALLOCATOR is absent, and M1.5 is the reason: *"the allocator sees the
 * job, the site, the driver and the dates — never what it is worth."* Every one
 * of their eleven workflows is logistics; not one is commercial.
 *
 * The console already honours this — it drops the total column from the grid
 * and removes the Charges and Invoice tabs entirely — but it said so itself:
 * *"This is a UI courtesy, not a security boundary. The server must scope what
 * it returns."* It did not, so the numbers arrived anyway and were one devtools
 * panel away. This is the server doing its half.
 */
const PRICING_ROLES = new Set<Role>(['super-admin', 'operations', 'office-staff']);

const seesPricing = (caller: Caller): boolean =>
  caller.roles.some((role) => PRICING_ROLES.has(role));

/**
 * Blank the money on a job for a caller who may not see it.
 *
 * Nulled rather than omitted: the fields stay on the contract, so the console
 * renders them as "—" through `formatMoney` wherever a screen does reach for
 * one, instead of failing to parse a response with a field missing.
 */
function redactListItem<T extends JobListItem>(job: T): T {
  return { ...job, totalExGst: null };
}

export const jobService = {
  async list(
    query: ListJobsQuery,
    caller: Caller,
  ): Promise<{ data: JobListItem[]; meta: PageMeta }> {
    const page = await jobRepository.list(query, scopeFor(caller));
    if (seesPricing(caller)) return page;

    return { ...page, data: page.data.map(redactListItem) };
  },

  async get(id: string, caller: Caller): Promise<Job> {
    const job = await jobRepository.findById(id, scopeFor(caller));

    // 404, not 403. A 403 confirms the job exists, which is exactly what a
    // caller probing for another account's work wants to know.
    if (!job) throw AppError.notFound('No such job');

    if (seesPricing(caller)) return job;

    // `charges` goes too: a line reading "Contamination — $90" is the price,
    // whatever the totals say.
    return { ...redactListItem(job), gst: null, totalIncGst: null, charges: [] };
  },

  /**
   * M2.12 — the purchase orders a pickup can be booked against.
   *
   * ── Why this lives in the jobs domain ─────────────────────────────────────
   * Because it is a booking concern, not a review-queue one. It composes two
   * repositories — the orders on the account, and which of them a job already
   * holds — and composing repositories is what a service is for.
   *
   * Scoped through the caller's own account, so a customer administrator sees
   * their orders and nobody else's.
   */
  async purchaseOrders(
    accountId: string,
    search: string | undefined,
    caller: Caller,
  ): Promise<BookablePurchaseOrderOption[]> {
    const scope = scopeFor(caller);

    // The account is resolved through the caller's scope first, so an id that
    // is not theirs answers "none" rather than somebody else's orders.
    const account = await accountRepository.findById(accountId, { accountId: scope.accountId });
    if (!account) throw AppError.notFound('No such account');

    const orders = await purchaseOrderRepository.listForAccount(account.id, search);
    const taken = await jobsForPurchaseOrders(orders.map((order) => order.id));

    return orders.map((order) => ({
      ...order,
      /*
       * A used order is RETURNED, not filtered out. "PO-88214 is on job 61,412"
       * is the answer somebody looking for it needs; silently omitting it makes
       * them think the extraction failed and key the order in by hand.
       */
      usedByJobNumber: taken.get(order.id) ?? null,
    }));
  },

  /**
   * M2.1 / M6.9 — the estimate shown BEFORE saving.
   *
   * Runs the same `pricingService.quote` the create below runs, on purpose: if
   * the preview and the saved job could disagree, the number the office quoted
   * down the phone would not be the number on the invoice.
   */
  async preview(draft: JobDraft, caller: Caller): Promise<PricePreview> {
    const { account, place, purchaseOrder } = await resolveDraft(draft, caller);
    const quantities = quantitiesFor(draft, purchaseOrder);

    return pricingService.quote({
      rateCardId: account.rateCardId,
      zoneId: place.zoneId,
      expectedAreaM2: quantities.expectedAreaM2,
      bagCount: quantities.bagCount,
      // M6.2 — the SAME date `create` below prices on, so the estimate the
      // office reads out cannot differ from the job that gets saved.
      onDate: draft.readyDate,
    });
  },

  /**
   * M2.6 — the new pickup a futile review's "Rescheduled" outcome promises.
   *
   * ── Why a NEW job rather than moving the old one back ─────────────────────
   * The futile job is finished work: the truck went, the driver attended, and
   * the $120 fee is already on it. Invoicing accepts `completed`, `admin-complete`
   * and `futile` — not `cancelled` and not `booked` — so putting the job back to
   * `booked` would take the fee off the invoice run until the re-attempt
   * completes, which is exactly what "the fee applies either way" rules out.
   * A second job also matches what the screen says: *"Rescheduling books a new
   * pickup."*
   *
   * ⚠️ The purchase order LINK is deliberately not carried. `purchaseOrderId`
   * is unique across jobs (`purchase_order_unique`), and the futile job still
   * holds it. The PO NUMBER comes across, because that is the string the
   * builder's accounts system matches on.
   *
   * Priced fresh on the new ready date, like any booking — the quote is taken
   * on the day the work will happen.
   */
  async rebookFromFutile(
    originalJobId: string,
    newReadyDate: string,
    caller: Caller,
  ): Promise<JobListItem> {
    const original = await jobRepository.findById(originalJobId, scopeFor(caller));
    if (!original) throw AppError.notFound('No such job');

    const place = await placeService.findForJob(original.suburb, original.postcode);
    if (!place) {
      // Refusing beats booking a pickup into somewhere we no longer go.
      throw AppError.validation(
        `${original.suburb} is not a suburb we service any more, so this pickup cannot be rebooked`,
        [{ path: 'newReadyDate', message: 'Book this one by hand against a serviced suburb' }],
      );
    }

    const rebooked = await this.create(
      {
        accountId: original.accountId,
        siteName: original.siteName,
        lotNumber: original.lotNumber ?? '',
        addressLine: original.addressLine,
        placeId: place.id,
        builderName: original.builderName,
        accessNotes: original.accessNotes,
        gateHours: original.gateHours ?? '',
        inductionRequired: original.inductionRequired,
        craneAvailable: original.craneAvailable,
        siteContactName: original.siteContactName ?? '',
        siteContactMobile: original.siteContactMobile ?? '',
        siteContactEmail: original.siteContactEmail ?? '',
        poNumber: original.poNumber ?? '',
        purchaseOrderId: null,
        readyDate: newReadyDate,
        serviceLevel: original.serviceLevel,
        freightItem: original.freightItem,
        expectedAreaM2: original.expectedAreaM2 ?? 0,
        bagCount: original.bagCount,
        notes: original.notes,
      },
      caller,
    );

    // Both timelines have to say where the other went, or the pair is
    // unreadable six months later.
    await jobRepository.appendEvent({
      jobId: originalJobId,
      label: 'Rebooked after a futile attempt',
      actor: caller.name,
      status: null,
      detail: `New pickup #${String(rebooked.jobNumber)}, ready ${newReadyDate}`,
    });

    await jobRepository.appendEvent({
      jobId: rebooked.id,
      label: 'Rebooked from a futile pickup',
      actor: caller.name,
      status: null,
      detail: `Replaces job #${String(original.jobNumber)}`,
    });

    log.info(
      {
        originalJobId,
        originalJobNumber: original.jobNumber,
        jobId: rebooked.id,
        jobNumber: rebooked.jobNumber,
        newReadyDate,
      },
      'futile pickup rebooked',
    );

    return rebooked;
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
    // Before anything is priced off it — the quote below is taken ON this date.
    assertPlausibleReadyDate(draft.readyDate);

    const { account, place, purchaseOrder } = await resolveDraft(draft, caller);

    if (account.status !== 'active') {
      throw AppError.conflict(
        `${account.name} is not an active account, so a pickup cannot be booked against it`,
      );
    }

    const slaBusinessDays = await settingsRepository.slaBusinessDays();
    const quantities = quantitiesFor(draft, purchaseOrder);

    const { preview: quote, appliedRate } = await pricingService.quoteWithAppliedRate({
      rateCardId: account.rateCardId,
      zoneId: place.zoneId,
      expectedAreaM2: quantities.expectedAreaM2,
      bagCount: quantities.bagCount,
      /*
       * ⚠️ M6.2 — priced on the READY DATE, not on today.
       *
       * A pickup booked in September for an October ready date is priced on
       * October's schedule, because that is when the work happens and that is
       * what the office quoted. `appliedRate` freezes the result onto the job,
       * so a schedule issued later cannot move this figure.
       */
      onDate: draft.readyDate,
    });

    /*
     * I3 — the pin, resolved BEFORE the number is taken.
     *
     * Deliberately outside the transaction below and ahead of the job number:
     * a network call inside a transaction holds it open for as long as Google
     * takes, and a number taken before a step that can be slow is a number
     * wasted if the request is abandoned. This step cannot fail the booking in
     * any case — see `resolveLocation`.
     */
    const location = await resolveLocation(draft, place);

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
        jobRepository
          .create({
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
            zoneId: place.zoneId,
            latitude: location.latitude,
            longitude: location.longitude,
            locationSource: location.locationSource,
            accessNotes: draft.accessNotes.trim(),
            gateHours: draft.gateHours.trim() || null,
            inductionRequired: draft.inductionRequired,
            craneAvailable: draft.craneAvailable,
            siteContactName: draft.siteContactName.trim() || null,
            siteContactMobile: draft.siteContactMobile.trim() || null,
            siteContactEmail: draft.siteContactEmail.trim() || null,
            // The order's own number wins where there is one: that is the string
            // the builder's accounts system matches, and a typed copy can differ
            // from it by a character (Matt, 9:56).
            poNumber: purchaseOrder ? purchaseOrder.poNumber : draft.poNumber.trim() || null,
            purchaseOrderId: purchaseOrder?.id ?? null,
            // Who actually keyed it in. Stays the office user even where the
            // scoping id below belongs to somebody else — the two answer different
            // questions, and the model says so.
            bookedByName: caller.name,
            /*
             * Who may SEE this job (an authorisation field — see the model).
             *
             * A portal booking scopes to whoever made it. An office booking has
             * no such person, and a null is invisible to every supervisor — the
             * safe direction, and still the answer for a phone booking.
             *
             * ⚠️ The exception is an order that named a supervisor. Matt, 33:57:
             * *"that job should get assigned to that site supervisor… they get an
             * email and able to log in in the system and see all these job
             * details."* Without this the office confirms the order, the job is
             * created, and the one person who needs to see it cannot — which is
             * indistinguishable from the feature not existing.
             */
            bookedByUserId: isCustomer(caller)
              ? caller.userId
              : (purchaseOrder?.siteSupervisorUserId ?? null),
            bookedBySource: isCustomer(caller) ? 'portal' : 'office',
            readyDate: draft.readyDate,
            // M2.4a — the SLA is in BUSINESS days, from the customer's ready date.
            targetDate: addBusinessDays(draft.readyDate, slaBusinessDays),
            serviceLevel: draft.serviceLevel,
            freightItem: draft.freightItem,
            /*
             * Frozen from the order, exactly like the zone above. Not re-read
             * through `purchaseOrderId` at invoice time: an order corrected next
             * year must not re-price a job already collected and invoiced.
             */
            expectedAreaM2: quantities.expectedAreaM2,
            bagCount: quantities.bagCount,
            notes: draft.notes.trim(),
            totalExGst: quote.subtotalExGst,
            gst: quote.gst,
            totalIncGst: quote.totalIncGst,
            /*
             * ⚠️ M6.2 — the rates that produced those totals, frozen on the job
             * for exactly the same reason as the zone and the area above.
             *
             * This is what lets a rate be changed at all. A credit note or a
             * reprint reads these figures instead of asking the rate tables
             * again, so a schedule issued next March cannot move a line on an
             * invoice the customer has already paid — and a retired rate card
             * does not take its history with it.
             */
            appliedRate,
            /*
             * M4.8b — the account's rule, resolved NOW and frozen on the job.
             *
             * Never read live from the account afterwards: a job booked today
             * under today's rule must still show today's rule when it is audited
             * next year. Re-deriving it would let a settings change rewrite the
             * past and make a compliant job look like a gap.
             */
            riskAssessmentRequired: account.riskAssessmentRequired,
          })
          .then(async (job) => {
            // Remembered so `compensate` can find the job if the event write below
            // fails on a deployment with no transactions.
            createdId = job.id;

            /*
             * The quote is PERSISTED as the job's own charge lines.
             *
             * Not recomputed at invoice time: rates are effective-dated (M6.2), so
             * a re-quote months later would silently re-price history the first
             * time somebody edits a rate card — and the invoice has to reproduce
             * what the customer was quoted, to the cent (Risk 1). Storing them
             * here makes the job the single source of truth and the invoice a
             * straight copy of it.
             */
            await writeQuotedCharges(
              job.id,
              quote.lines.map((line) => ({
                code: line.code,
                description: line.description,
                quantity: line.quantity,
                unitRate: line.unitRate,
                amount: line.amount,
              })),
            );

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

    /*
     * M8.1 — the site contact is told it is coming.
     *
     * ⚠️ AFTER the transaction, and unable to throw. The
     * booking is the durable act; a message is not worth losing it for. The job
     * is re-read rather than assembled from `created` because a notice needs
     * the site contact, which the grid row does not carry.
     */
    const forNotice = await jobRepository.findById(created.id, {
      accountId: null,
      bookedByUserId: null,
      driverId: null,
    });
    if (forNotice) await jobNotices.booked(forNotice);

    log.info(
      { jobId: created.id, jobNumber, accountId: account.id, zone: place.zoneLabel },
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
  async cancel(id: string, reason: ExceptionReason, note: string, caller: Caller): Promise<void> {
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
      throw AppError.conflict('That job is finished, so there is nothing left to reschedule');
    }

    assertPlausibleReadyDate(readyDate);

    const targetDate = addBusinessDays(readyDate, await settingsRepository.slaBusinessDays());

    const previous = await jobRepository.reschedule(id, readyDate, targetDate);
    if (!previous) throw AppError.notFound('No such job');

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
      throw AppError.conflict('This job has no allocated driver, so there is nobody to send it to');
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

  /**
   * Add a configured extra to a job (M6.5).
   *
   * ── The gap this closes ───────────────────────────────────────────────────
   * Charges reached a job only through something a driver did or the system
   * derived. Everything on the additional-services price list that the office
   * decides — an out-of-area fee, a fuel levy on a one-off — had a price and no
   * way of ever being applied. The settings dialog promised otherwise.
   *
   * ── Why the office cannot name its own amount ─────────────────────────────
   * The draft carries a CODE and a quantity, never a figure. The price comes
   * from the configured service, exactly as it does for a driver-raised one, so
   * the same charge costs the same whoever adds it and changing it stays one
   * edit on one screen. A free-typed amount here would be a second, invisible
   * price list.
   */
  async addCharge(jobId: string, draft: JobChargeDraft, caller: Caller): Promise<JobCharge> {
    /*
     * ⚠️ Office only, and deliberately not `scopeFor(caller)`. A customer
     * administrator can read their own job; letting them add a billable line to
     * it would let them invoice themselves.
     */
    if (isCustomer(caller)) throw AppError.forbidden('Your role does not allow that');

    // Unscoped: the only callers that reach here are office roles, which the
    // guard above has already established.
    const job = await jobRepository.findSummary(jobId, scopeFor(caller));
    if (!job) throw AppError.notFound('No such job');

    if (job.status === 'cancelled') {
      throw AppError.conflict('This job was cancelled, so nothing can be billed against it');
    }

    /*
     * A percentage service is a proportion OF THE JOB, so it needs the job's
     * own ex-GST total to apply to. A fixed one ignores it.
     */
    const priced = await pricingService.priceAdditionalService(draft.code, {
      quantity: draft.quantity,
      baseAmount: job.totalExGst,
    });

    /*
     * The unit rate is what one of them costs, so the invoice line can read
     * "2 × $30.00 = $60.00" — Matt's own example. Derived by division rather
     * than read from the service, because a percentage charge has no unit price
     * of its own and would otherwise print its percentage as a dollar figure.
     */
    const unitCents = Math.round(moneyToCents(priced.amountExGst) / draft.quantity);

    const chargeId = await jobRepository.addOfficeCharge({
      jobId,
      code: draft.code,
      description: priced.label,
      quantity: draft.quantity,
      unitRate: centsToMoney(unitCents),
      amount: priced.amountExGst,
      /*
       * ⚠️ The configured `requiresApproval` decides this, NOT the fact that the
       * office added it. A contamination charge is approved before it can be
       * invoiced whoever raised it — that rule is about the money, not about who
       * typed it — and an office user approving their own charge in one click
       * would be the same person on both sides of the decision.
       */
      approvalState: priced.requiresApproval ? 'pending' : 'not-required',
      raisedBy: caller.name,
      note: draft.note?.trim() === '' ? null : (draft.note ?? null),
    });

    log.info(
      { jobId, chargeId, code: draft.code, amount: priced.amountExGst, by: caller.name },
      'office charge added to job',
    );

    const charge = (await jobRepository.findCharge(chargeId)) ?? null;
    if (!charge) throw new Error('charge vanished immediately after it was created');
    return charge;
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
 * The pin this job will carry, and an honest account of where it came from (I3).
 *
 * ── Why this can only ever succeed ────────────────────────────────────────
 * The suburb the office PICKED already gives a usable answer, and it is the
 * answer every job booked before this existed carries. So there is no failure
 * mode worth propagating: Google being slow, rate-limited, unconfigured or
 * simply ignorant of a three-week-old street all land in the same place —
 * the suburb pin, marked as such. A booking must never fail because a map
 * lookup did.
 *
 * ── The two gates, and why a pin has to pass both ─────────────────────────
 * 1. PRECISION. `block` and `approximate` are Google saying "somewhere on this
 *    street" or "somewhere in this locality" — the same class of answer the
 *    suburb pin already is. Storing one would swap a pin we can explain for one
 *    we cannot, while marking the job as precisely located.
 * 2. DRIFT. Google will answer a half-built estate's address with a real street
 *    of the same name in another state, at full ROOFTOP confidence, because as
 *    far as it knows that IS the address. The suburb is the one part a human
 *    definitely chose from a list, so a result too far from it loses.
 *
 * A rejected pin is logged with what was rejected and why. "Why is this job on
 * the suburb centre?" is otherwise unanswerable after the fact, and the honest
 * fallback would be indistinguishable from the geocoder never having run.
 */
async function resolveLocation(
  draft: JobDraft,
  place: { suburb: string; postcode: string; state: string; latitude: number; longitude: number },
): Promise<{ latitude: number; longitude: number; locationSource: LocationSource }> {
  const suburbPin = {
    latitude: place.latitude,
    longitude: place.longitude,
    locationSource: 'suburb' as const,
  };

  const addressLine = draft.addressLine.trim();
  if (addressLine === '') return suburbPin;

  /*
   * ⚠️ Belt AND braces. The provider's contract is that it returns null rather
   * than throwing, and it honours that — but the promise being made here is
   * that a BOOKING cannot fail because of a map lookup, and that promise should
   * not rest on a second file continuing to be careful. One catch is cheaper
   * than the incident where it was not.
   */
  let point: Awaited<ReturnType<MapsProvider['geocode']>>;
  try {
    point = await getMapsProvider().geocode({
      addressLine,
      suburb: place.suburb,
      postcode: place.postcode,
      state: place.state,
    });
  } catch (error) {
    log.warn({ err: error, suburb: place.suburb }, 'geocode threw — keeping the suburb pin');
    return suburbPin;
  }

  if (!point) return suburbPin;

  if (!isPrecise(point)) {
    log.debug(
      { suburb: place.suburb, precision: point.precision },
      'geocode was no more precise than the suburb — keeping the suburb pin',
    );
    return suburbPin;
  }

  const driftKm = distanceKm(point, place);
  if (driftKm > env.GEOCODE_MAX_DRIFT_KM) {
    log.warn(
      {
        suburb: place.suburb,
        driftKm: Math.round(driftKm),
        maxKm: env.GEOCODE_MAX_DRIFT_KM,
        matched: point.formattedAddress,
      },
      'geocode landed too far from the chosen suburb — keeping the suburb pin',
    );
    return suburbPin;
  }

  return {
    latitude: point.latitude,
    longitude: point.longitude,
    locationSource: 'geocoded',
  };
}

/**
 * The account, the place and the purchase order behind a booking form.
 *
 * All three are resolved SERVER-SIDE from ids. The browser sends `accountId`,
 * `placeId` and `purchaseOrderId` and nothing else about any of them — sending
 * the zone, the rate card or the area would let a caller nominate its own, and
 * all three decide the price (M6.3).
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

  const purchaseOrder = await resolvePurchaseOrder(draft, account.id);

  return { account, place, purchaseOrder };
}

/**
 * M2.12 — the confirmed purchase order this booking is against.
 *
 * ── Why the order's figures win over the form's ───────────────────────────
 * Because the purchase order IS the authority. It is what the builder issued,
 * what their accounts system matches an invoice against, and what states the
 * area PlastaGo is being paid for. A typed area that disagreed with it would
 * produce an invoice the builder rejects — and nobody would know why for weeks
 * (Matt, 9:56).
 *
 * So `expectedAreaM2`, `bagCount` and `poNumber` are taken from the stored
 * record and whatever arrived in the draft for those three fields is ignored.
 * That is the same rule as `placeId` supplying the zone.
 *
 * Returns null for a booking with no order behind it, which is every contractor
 * and most phone bookings.
 */
async function resolvePurchaseOrder(
  draft: JobDraft,
  accountId: string,
): Promise<BookablePurchaseOrder | null> {
  if (draft.purchaseOrderId === null) return null;

  /*
   * Fetched through the ACCOUNT, so a caller cannot attach another customer's
   * purchase order by pasting its id — the constraint is in the query, not a
   * check afterwards.
   */
  const order = await purchaseOrderRepository.findForAccount(draft.purchaseOrderId, accountId);

  if (!order) {
    throw AppError.validation('That purchase order could not be found on this account', [
      { path: 'purchaseOrderId', message: 'Choose a purchase order from the list' },
    ]);
  }

  /*
   * ⚠️ Wisdom's order states it in capitals: *"ONE PURCHASE ORDER NUMBER ONLY
   * PER TAX INVOICE."* An invoice is raised per job, so a second job against one
   * order bills the builder twice under a number their accounts system has
   * already closed.
   *
   * The unique index enforces this. Checking here means the second caller gets a
   * sentence naming the job that took it, rather than a duplicate-key error.
   */
  const taken = await jobsForPurchaseOrders([order.id]);
  const existing = taken.get(order.id);

  if (existing !== undefined) {
    throw AppError.conflict(
      `Purchase order ${order.poNumber} is already on job ${String(existing)}. ` +
        'A builder pays one purchase order once — book this pickup against a different order.',
    );
  }

  return order;
}

/**
 * The two quantities that price a job, from whichever source is authoritative.
 *
 * ── One function, because the preview and the create must not disagree ────
 * `preview` is the figure quoted down the phone and `create` is the figure
 * invoiced. If each decided the area for itself they would drift, and the way
 * you find out is a customer comparing the quote against the invoice (see the
 * note on `pricingService`).
 *
 * ⚠️ Null is not zero, and the difference is money.
 *
 * Matt, 31:04, on the Wisdom order: *"we're on a fixed price with them. So they
 * don't actually give us square metres… they just give us a line item."* A zero
 * would price the job at the call-out fee AND silently drop the stop out of the
 * m²-weighted tip-off split, handing its share of recovered tonnage to everyone
 * else on the run — on a figure that ends up on a diversion certificate.
 *
 * So a fixed-price order legitimately yields null here, and that is correct
 * rather than missing.
 */
function quantitiesFor(
  draft: JobDraft,
  purchaseOrder: BookablePurchaseOrder | null,
): { expectedAreaM2: number | null; bagCount: number } {
  if (purchaseOrder) {
    return {
      // Already null on a fixed-price order. Passed through untouched.
      expectedAreaM2: purchaseOrder.expectedAreaM2,
      /*
       * The order states an allowance — "Bulka Bag (500m2 plasterboard per
       * bag), 2.00 Each". Zero where it states none, because `bagCount` is a
       * count of bags actually allowed for and the contract makes it
       * non-nullable.
       */
      bagCount: purchaseOrder.bagAllowance ?? 0,
    };
  }

  return {
    // Zero from a form means "nobody has told us yet", which is not an area of
    // nothing. See the warning above.
    expectedAreaM2: draft.expectedAreaM2 > 0 ? draft.expectedAreaM2 : null,
    bagCount: draft.bagCount,
  };
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
