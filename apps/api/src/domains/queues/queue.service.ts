import type {
  AwaitingPoItem,
  ChargeApprovalDetail,
  ChargeApprovalItem,
  ChargeDecision,
  FutileDecision,
  FutileReview,
  FutileReviewItem,
  PageMeta,
  QueueCounts,
  Role,
} from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { pricingService } from '../settings/pricing.service.js';
import { queueRepository, type QueueListQuery } from './queue.repository.js';

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
}

/** Roles that work these queues. Customers and drivers see none of them. */
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
    query: QueueListQuery,
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

    log.info(
      { reviewId: id, jobId: result.jobId, outcome: decision.outcome, by: caller.name },
      'futile review decided',
    );
  },

  /* ── M2.7 · Charge approvals ───────────────────────────────────────────── */

  async approvalList(
    query: QueueListQuery,
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
   * The driver is told why. A rejection with no reason reads as the office
   * disbelieving them, and the next contamination goes unreported.
   */
  async approvalDecide(
    ids: readonly string[],
    decision: ChargeDecision,
    caller: Caller,
  ): Promise<number> {
    assertApprover(caller);

    if (ids.length === 0) throw AppError.validation('Select at least one charge');

    const note = decision.note.trim();
    if (decision.decision === 'reject' && !note) {
      throw AppError.validation('Say why the charge is being rejected', [
        { path: 'note', message: 'The driver is told why — write a short reason' },
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

    return result.changed;
  },

  /* ── M7.3 · Awaiting a purchase order ──────────────────────────────────── */

  async awaitingPoList(
    query: QueueListQuery,
    caller: Caller,
  ): Promise<{ data: AwaitingPoItem[]; meta: PageMeta }> {
    assertOffice(caller);
    return queueRepository.awaitingPoList(query);
  },

  /**
   * M7.3 — record that a chase went out.
   *
   * ── Why chasing is a recorded act and not just a note ─────────────────────
   * Because the queue's whole value is its ageing, and ageing against the
   * APPROVAL date stops being useful after the first week — everything is old.
   * Ageing against the last contact answers the question the office actually
   * has: who have we not spoken to about this?
   *
   * It does not send anything. Somebody picks up the phone; this records that
   * they did.
   */
  async awaitingPoChase(ids: readonly string[], caller: Caller): Promise<number> {
    assertOffice(caller);

    if (ids.length === 0) throw AppError.validation('Select at least one invoice to chase');

    const changed = await queueRepository.recordChase(ids);

    if (changed === 0) {
      throw AppError.conflict(
        'None of those invoices are waiting on a purchase order any more',
      );
    }

    log.info({ count: changed, by: caller.name }, 'purchase-order chases recorded');
    return changed;
  },
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * The futile fee, read from the price list rather than hard-coded.
 *
 * It is $120 today. It is a setting because Matt can change it without a
 * deploy, and because the queue showing a stale number beside a real charge is
 * how somebody talks a customer out of paying it.
 */
async function futileFee(): Promise<string> {
  try {
    const priced = await pricingService.priceAdditionalService('futile-pickup');
    return priced.amountExGst;
  } catch {
    // A missing price must not blank the whole queue — the rows still need
    // reviewing, and the fee is shown for context rather than charged here.
    log.warn('futile-pickup is not configured in the price list');
    return '0.00';
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
