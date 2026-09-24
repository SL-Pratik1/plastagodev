import type {
  ChangeRequestDecision,
  ChangeRequestItem,
  AwaitingPoChaseResult,
  AwaitingPoItem,
  ChargeApprovalDetail,
  ChargeApprovalItem,
  ChargeDecision,
  ChargeDecisionOutcome,
  FutileDecision,
  FutileReview,
  FutileReviewItem,
  PageMeta,
  QueueCounts,
  Role,
} from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { assertPlausibleReadyDate } from '../../lib/ready-date.js';
import { invoiceService } from '../invoices/invoice.service.js';
import { jobService } from '../jobs/job.service.js';
import { buildPoRequestEmail } from '../../integrations/notice-messages.js';
import { notificationService } from '../notifications/notification.service.js';
import { outboundService } from '../notifications/outbound.service.js';
import { pricingService } from '../settings/pricing.service.js';
import { settingsRepository } from '../settings/settings.repository.js';
import {
  FUTILE_CHARGE_CODE,
  queueRepository,
  type ApprovalListQuery,
  type AwaitingPoListQuery,
  type FutileListQuery,
  type QueueListQuery,
} from './queue.repository.js';

const log = logger.child({ module: 'queues' });

/**
 * The office's worklists (M2.6, M2.7, M7.3).
 *
 * ── What a queue is for ───────────────────────────────────────────────────
 * Every one of these exists because something is waiting on a HUMAN decision,
 * and the cost of nobody making it is money. A futile job nobody reviews is a
 * customer who never gets called back; a charge nobody approves never reaches
 * an invoice; an invoice waiting on a PO is cash sitting still — Matt's three
 * months (33:56).
 *
 * So every list is ordered OLDEST FIRST and can be filtered by age. A queue
 * worked newest-first is one where the oldest row never gets touched, which is
 * exactly the row that matters.
 */

export interface Caller {
  userId: string;
  name: string;
  roles: readonly Role[];
  /** Null for office staff. Only carried so `jobService` can scope by it. */
  accountId: string | null;
}

/** Roles that work these queues. Customers and drivers see none of them. */
/**
 * Who may open a worklist at all — the allocator included.
 *
 * This contradicts `permissions.ts`, which gives the allocator neither
 * `pricing:view` ("never what it is worth") nor `queues:action`. The console
 * therefore draws no queue nav for them, while this set lets them call
 * `/queues/approvals`, `/queues/futile` and `/queues/awaiting-po` directly and
 * read every charge amount, futile fee and invoice total.
 *
 * ✔ Confirmed 2026-09-11: that is accepted. An allocator is internal staff, and
 * seeing what a job is worth is not a risk worth another permission tier. The
 * narrower rule that does matter is still enforced below — APPROVING a charge
 * is a pricing decision and stays with the office (`APPROVER_ROLES`).
 *
 * So the two files disagree on purpose, not by accident. `permissions.ts`
 * decides which screens are DRAWN; this decides what the server will answer.
 */
const OFFICE_ROLES = new Set<Role>(['super-admin', 'operations', 'office-staff', 'allocator']);

/** M2.7 — approving a charge is a pricing decision, so it is narrower. */
const APPROVER_ROLES = new Set<Role>(['super-admin', 'operations', 'office-staff']);

export const queueService = {
  /** M9.4 — one call for every nav badge. */
  async counts(caller: Caller): Promise<QueueCounts> {
    assertOffice(caller);
    return queueRepository.counts();
  },

  /* ── M2.6 · Futile review ──────────────────────────────────────────────── */

  async futileList(
    query: FutileListQuery,
    caller: Caller,
  ): Promise<{ data: FutileReviewItem[]; meta: PageMeta }> {
    assertOffice(caller);
    return queueRepository.futileList(query, await futileFee());
  },

  async futileGet(id: string, caller: Caller): Promise<FutileReview> {
    assertOffice(caller);

    const review = await queueRepository.futileGet(id, await futileFee());
    if (!review) throw AppError.notFound('No such futile review');

    return review;
  },

  /**
   * M2.6 — decide what happens to a futile job.
   *
   * ⚠️ The decision is about the JOB, never about the money. Matt was explicit
   * that *either way the futile fee applies* — the $120 was earned the moment
   * the truck turned up to a site that was not ready. So there is no path here
   * that touches the charge, and the two outcomes differ only in what happens
   * to the pickup.
   */
  async futileDecide(id: string, decision: FutileDecision, caller: Caller): Promise<void> {
    assertOffice(caller);

    /*
     * Each outcome demands its own field, and the missing one is a 422 against
     * that field rather than a generic refusal — the form can then point at the
     * control the user has to fill in.
     */
    if (decision.outcome === 'rescheduled' && !decision.newReadyDate) {
      throw AppError.validation('Rescheduling needs a new ready date', [
        { path: 'newReadyDate', message: 'Choose when the site will be ready' },
      ]);
    }

    /*
     * The same window booking and rescheduling use. This path sets a ready date
     * too, and it did not check one — a futile review could be closed onto
     * `2020-01-01`, which parks the job at the top of every at-risk list.
     */
    if (decision.outcome === 'rescheduled' && decision.newReadyDate) {
      assertPlausibleReadyDate(decision.newReadyDate, 'newReadyDate');
    }

    if (decision.outcome === 'cancelled' && !decision.cancelReason) {
      // M2.4 forbids a bare cancel: a reason people pick from a list can be
      // counted, and a reason people type cannot.
      throw AppError.validation('Cancelling needs a reason', [
        { path: 'cancelReason', message: 'Choose why the job is being cancelled' },
      ]);
    }

    const result = await queueRepository.decideFutile({
      id,
      outcome: decision.outcome,
      decisionNote: decision.note.trim() || null,
      decidedByUserId: caller.userId,
      decidedBy: caller.name,
      // Only meaningful on a reschedule; deliberately not carried on a cancel.
      newReadyDate: decision.outcome === 'rescheduled' ? decision.newReadyDate : null,
    });

    if (!result) {
      // The filter did not match, which on this queue means somebody else got
      // there first. A second decision is a contradiction, not an update.
      throw AppError.conflict(
        'That review has already been decided — reload to see what was chosen',
      );
    }

    /*
     * ⚠️ The half that was missing. `decideFutile` records the decision and
     * returns the job "so the caller can act on it" — and for a long while the
     * caller did not. The review was stamped `rescheduled`, `newReadyDate` was
     * written and never read by anything, and the screen said "Rescheduling
     * books a new pickup" over a toast reading "Job #61379 rescheduled". No
     * pickup was ever booked. The queue cleared, the office believed the job
     * was back on, and the customer was simply never collected.
     *
     * `cancelled` needs nothing here and gets nothing: the job is already
     * terminal at `futile`, which is the status invoicing accepts, so the $120
     * still reaches the invoice. Only the promise of a new pickup was unkept.
     */
    let rebookedJobNumber: number | null = null;
    if (decision.outcome === 'rescheduled' && decision.newReadyDate) {
      const rebooked = await jobService.rebookFromFutile(
        result.jobId,
        decision.newReadyDate,
        caller,
      );
      rebookedJobNumber = rebooked.jobNumber;
    }

    /*
     * A cancel books nothing, but the original job still has to say it was
     * decided — otherwise its page keeps asking for the decision. A rebook
     * writes its own line in `rebookFromFutile`.
     */
    if (decision.outcome === 'cancelled') {
      await jobService.recordFutileClosed(result.jobId, decision.note.trim() || null, caller);
    }

    log.info(
      {
        reviewId: id,
        jobId: result.jobId,
        outcome: decision.outcome,
        rebookedJobNumber,
        by: caller.name,
      },
      'futile review decided',
    );
  },

  /* ── M2.7 · Charge approvals ───────────────────────────────────────────── */

  async approvalList(
    query: ApprovalListQuery,
    caller: Caller,
  ): Promise<{ data: ChargeApprovalItem[]; meta: PageMeta }> {
    assertOffice(caller);
    return queueRepository.approvalList(query);
  },

  async approvalGet(id: string, caller: Caller): Promise<ChargeApprovalDetail> {
    assertOffice(caller);

    const charge = await queueRepository.approvalGet(id);
    if (!charge) throw AppError.notFound('No such charge awaiting approval');

    return charge;
  },

  /**
   * M2.7 — approve or reject a batch of driver-raised charges.
   *
   * Bulk because the queue is worked in batches, and the count is returned
   * rather than thrown on: a grid selection is expected to contain rows somebody
   * else has already actioned, and failing the whole batch for one of them would
   * make the button useless.
   *
   * ── Why a rejection must carry a note ─────────────────────────────────────
   * It is the only record of the decision. The charge leaves the queue the
   * moment it is decided, so a rejection with no reason leaves a refused charge
   * on a job with nothing to explain it — and the person who has to answer the
   * driver, or the customer, is usually not the person who pressed the button.
   *
   * ⚠️ It is NOT sent to the driver. There is no driver notification channel
   * (`notificationService` reaches the office and customer users, and that is
   * all), so telling them is a conversation somebody has to have.
   *
   * ── Why approving bills ───────────────────────────────────────────────────
   * The screen said an approved charge "moves to the Awaiting PO queue", and
   * nothing moved: approving flipped a flag, the charge went on no invoice and
   * vanished from every list the office works from. Now an approval bills the
   * charges on every finished job it touched — see
   * `invoiceService.billApprovedCharges` — and says where each one went.
   */
  async approvalDecide(
    ids: readonly string[],
    decision: ChargeDecision,
    caller: Caller,
  ): Promise<ChargeDecisionOutcome> {
    assertApprover(caller);

    if (ids.length === 0) throw AppError.validation('Select at least one charge');

    const note = decision.note.trim();
    if (decision.decision === 'reject' && !note) {
      throw AppError.validation('Say why the charge is being rejected', [
        { path: 'note', message: 'Write a short reason — it is the only record of this decision' },
      ]);
    }

    const result = await queueRepository.decideCharges({
      ids,
      to: decision.decision === 'approve' ? 'approved' : 'rejected',
      note: note || null,
      decidedBy: caller.name,
    });

    if (result.changed === 0) {
      throw AppError.conflict(
        'None of those charges could be decided — they may already have been approved or rejected',
      );
    }

    log.info(
      {
        count: result.changed,
        decision: decision.decision,
        jobs: result.jobIds.length,
        by: caller.name,
      },
      'charge approvals decided',
    );

    if (decision.decision === 'reject') {
      return { changed: result.changed, invoices: [], awaitingJobCompletion: [], notInvoiced: [] };
    }

    // After the decision is committed, and unable to undo it — see the method.
    const billing = await invoiceService.billApprovedCharges(result.jobIds);

    return { changed: result.changed, ...billing };
  },

  /* ── M5.4 · Change requests from the portal ───────────────────────────── */

  /**
   * The office end of the portal’s only post-allocation channel.
   *
   * `assertOffice` rather than `assertApprover`: answering "can we move this to
   * Thursday" is dispatch work, not a pricing decision, and the allocator is
   * the person who can actually see whether the run has room.
   */
  async changeRequestList(
    query: QueueListQuery,
    caller: Caller,
  ): Promise<{ data: ChangeRequestItem[]; meta: PageMeta }> {
    assertOffice(caller);
    return queueRepository.changeRequestList(query);
  },

  /**
   * Record the answer. It does NOT move the job.
   *
   * Agreeing to a reschedule still goes through the normal reschedule path,
   * because that is where the business-day window, the SLA clock and the run
   * are handled. Applying it from here would be a second, quieter way to move
   * a job — with none of those — and the two would drift.
   */
  async changeRequestDecide(
    id: string,
    decision: ChangeRequestDecision,
    caller: Caller,
  ): Promise<void> {
    assertOffice(caller);

    const note = decision.note.trim();

    /*
     * A decline must say why, for the reason a rejected charge must: the
     * customer asked for something and is being told no. Unlike the charge
     * case this reason DOES reach them — they can read it on the pickup.
     */
    if (decision.outcome === 'declined' && !note) {
      throw AppError.validation('Say why the change cannot be made', [
        { path: 'note', message: 'The customer reads this — write a short reason' },
      ]);
    }

    const resolved = await queueRepository.decideChangeRequest({
      id,
      outcome: decision.outcome,
      note: note || null,
      decidedBy: caller.name,
    });

    if (!resolved) {
      throw AppError.conflict(
        'That request has already been answered — reload to see what was decided',
      );
    }

    /*
     * Tell the customer. The portal promised "we will confirm by phone or
     * text"; this is the in-product half of that, and it is what stops them
     * ringing to ask whether anyone saw it.
     *
     * The pickup's audience — its administrators and the supervisor who booked
     * it — not every supervisor on the account, who could not open the link.
     */
    await notificationService.notifyJobAudience({
      accountId: resolved.accountId,
      bookedByUserId: resolved.bookedByUserId,
      category: 'queue',
      severity: 'info',
      title: `Your change request for #${String(resolved.jobNumber)} was ${decision.outcome === 'actioned' ? 'accepted' : 'declined'}`,
      body: note || 'The office has actioned your request.',
      href: `/portal/jobs/${resolved.jobId}`,
      subjectKey: `change-request-decided:${id}`,
      jobId: resolved.jobId,
      jobNumber: resolved.jobNumber,
    });

    log.info(
      { changeRequestId: id, outcome: decision.outcome, by: caller.name },
      'change request decided',
    );
  },

  /* ── M7.3 · Awaiting a purchase order ──────────────────────────────────── */

  async awaitingPoList(
    query: AwaitingPoListQuery,
    caller: Caller,
  ): Promise<{ data: AwaitingPoItem[]; meta: PageMeta }> {
    assertOffice(caller);
    return queueRepository.awaitingPoList(query);
  },

  /**
   * M7.3 — "Send reminder": email each billing contact for the PO, and log
   * the chase.
   *
   * ⚠️ The screen always said "emailed to each account's billing contact",
   * and nothing was ever sent — this only recorded a chase. The office
   * believed the customer had been asked, nobody rang, and the invoice waited.
   *
   * ── Why chasing is a recorded act and not just a note ─────────────────────
   * Because the queue's whole value is its ageing, and ageing against the
   * APPROVAL date stops being useful after the first week — everything is old.
   * Ageing against the last contact answers the question the office actually
   * has: who have we not spoken to about this?
   *
   * The chase is logged for every invoice still waiting, emailed or not, as it
   * always was — an account with no billing email is one the office rings, and
   * the result says which those are so the screen can tell them.
   */
  async awaitingPoChase(ids: readonly string[], caller: Caller): Promise<AwaitingPoChaseResult> {
    assertOffice(caller);

    if (ids.length === 0) throw AppError.validation('Select at least one invoice to chase');

    const invoices = await queueRepository.awaitingPoForChase(ids);

    if (invoices.length === 0) {
      throw AppError.conflict(
        'None of those invoices are waiting on a purchase order any more',
      );
    }

    const prefix = await invoiceNumberPrefix();
    let emailed = 0;
    let noBillingEmail = 0;
    let failed = 0;

    for (const invoice of invoices) {
      if (invoice.billingContacts.length === 0) {
        noBillingEmail += 1;
        continue;
      }

      const context = {
        accountName: invoice.accountName,
        invoiceNumber: `${prefix}${String(invoice.invoiceNumber)}`,
        totalIncGst: invoice.totalIncGst,
        chargeSummary: invoice.chargeSummary,
        jobNumber: invoice.jobNumber,
        siteName: invoice.siteName,
      };

      const outcomes = await Promise.all(
        invoice.billingContacts.map((contact) =>
          outboundService.send({
            event: 'po-request',
            /*
             * One per contact per CHASE: the next reminder is a new email, while
             * a double-click on this one sends it once.
             */
            subjectKey: `po-request:${invoice.id}:${String(invoice.chaseCount + 1)}:${contact.id}`,
            recipient: { email: contact.email, mobile: null, notifyByEmail: true },
            email: (to) => buildPoRequestEmail(to, context),
            accountId: invoice.accountId,
            invoiceId: invoice.id,
            jobId: invoice.jobId,
          }),
        ),
      );

      if (outcomes.some((result) => result.outcome === 'sent' || result.outcome === 'duplicate')) {
        emailed += 1;
      } else {
        failed += 1;
      }
    }

    const changed = await queueRepository.recordChase(invoices.map((invoice) => invoice.id));

    log.info(
      { count: changed, emailed, noBillingEmail, failed, by: caller.name },
      'purchase-order reminders sent',
    );

    return { changed, emailed, noBillingEmail, failed };
  },
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * The futile fee, read from the price list rather than hard-coded.
 *
 * It is $120 today. It is a setting because Matt can change it without a
 * deploy, and because the queue showing a stale number beside a real charge is
 * how somebody talks a customer out of paying it.
 *
 * ⚠️ A FALLBACK ONLY. Each row now carries the fee frozen onto its own job when
 * the driver marked the pickup futile, joined in the repository — see
 * `FUTILE_CHARGE_LOOKUP`. This value is used for a review whose charge line is
 * missing, and nowhere else.
 *
 * That distinction is the whole point. Handing the CURRENT price to every row
 * meant editing the fee restated history: a pickup charged $120 last month read
 * $150 in the queue, beside a job and an invoice that both still said $120.
 */
async function futileFee(): Promise<string> {
  try {
    const priced = await pricingService.priceAdditionalService(FUTILE_CHARGE_CODE);
    return priced.amountExGst;
  } catch {
    // A missing price must not blank the whole queue — the rows still need
    // reviewing, and the fee is shown for context rather than charged here.
    log.warn('futile-pickup is not configured in the price list');
    return '0.00';
  }
}

/**
 * The invoice number as the customer's copy prints it — "PGA-104234", or the
 * bare "104234" when no prefix is set. The PO request quotes the number they
 * will find on the PDF they already hold, not a variant of it.
 */
async function invoiceNumberPrefix(): Promise<string> {
  try {
    const prefix = (await settingsRepository.get()).invoicing.invoiceNumberPrefix.trim();
    return prefix === '' ? '' : `${prefix}-`;
  } catch {
    // A settings read that fails must not stop the reminders going out.
    return '';
  }
}

function assertOffice(caller: Caller): void {
  if (!caller.roles.some((role) => OFFICE_ROLES.has(role))) {
    // Queues are internal. A customer has no scoped view of "every pending
    // charge", and a driver must never see what the office decided about theirs.
    throw AppError.forbidden('These worklists are for office staff');
  }
}

function assertApprover(caller: Caller): void {
  if (!caller.roles.some((role) => APPROVER_ROLES.has(role))) {
    throw AppError.forbidden('Only the office can approve or reject a charge');
  }
}
