import type {
  AwaitingCallUp,
  CallUp,
  CallUpKind,
  CallUpOutcome,
  CallUpRequest,
  CallUpReviewReason,
  CallUpSource,
  CallUpState,
  JobDraft,
  PageMeta,
  Role,
} from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { placeRepository } from '../places/place.repository.js';
import { jobService, type Caller } from '../jobs/job.service.js';
import { callUpRepository, type MatchedOrder } from './call-up.repository.js';

const log = logger.child({ module: 'call-up' });

const REVIEWER_ROLES = new Set<Role>(['super-admin', 'operations', 'office-staff', 'allocator']);

/**
 * The call-up (M2.12b) — what actually schedules the work.
 *
 * ── The two-message flow, in Matt's words ─────────────────────────────────
 * 21:30: *"once we receive the PO that will then obviously store in their
 * pre-populate all the job's details and then that job should be sitting there
 * waiting for a call-up date to happen."* And 28:50: *"We'll then get an email
 * from them a week or so out, giving us that PO number and that address and **a
 * date**."*
 *
 * So the purchase order says WHAT the job is, months ahead. The call-up says
 * WHEN. This service is the second half: it takes a PO number and a date and
 * turns a waiting order into a job on the board.
 *
 * ── Why the job is created here and not when the PO is confirmed ──────────
 * Because a job needs a date. `readyDate` prices the SLA, drives the dispatch
 * indexes and is what a driver's run sheet is built from — a job carrying a null
 * date would have to be special-cased in every one of those. And a job created
 * three months early is a board full of houses that are still being framed.
 * The order sitting in `listAwaiting` is the *"sitting there waiting"* Matt
 * described, without inventing a dateless job to represent it.
 *
 * ── Why nothing here guesses ──────────────────────────────────────────────
 * Same rule as the purchase-order queue. A call-up naming an order nobody has
 * on file is not a booking; inventing one would put a truck on a road for work
 * that was never ordered. Every case it cannot resolve becomes a queue item
 * with a reason, and a human decides.
 */

/**
 * The caller the system acts as when an email schedules a job.
 *
 * ⚠️ An OFFICE identity, never a customer one. `jobService.create` scopes a
 * job to the caller when the caller is a customer, and a system booking that
 * claimed a customer role would scope every emailed job to a synthetic user —
 * making it invisible to the supervisor who actually needs it. As an office
 * caller, the scoping falls to the purchase order's own supervisor, which is
 * what Matt asked for (33:57).
 */
const SYSTEM_CALLER: Caller = {
  userId: '000000000000000000000000',
  name: 'Call-up email',
  roles: ['operations'],
  accountId: null,
};

/** Statuses a call-up may still move or cancel. */
const CHANGEABLE = new Set(['booked', 'assigned', 'in-transit', 'arrived']);

export interface RecordCallUpInput {
  poNumber: string;
  kind: CallUpKind;
  /** Null only on a cancellation. */
  readyDate: string | null;
  receivedAt: Date;
  source: CallUpSource;
  note: string;
  /** The vendor's extraction id, where this came from an email. */
  externalId: string | null;
  /** Set when raised against one known order — a portal or office call-up. */
  purchaseOrderId?: string | null;
  raisedBy?: string | null;
}

/*
 * Re-exported rather than redeclared: the screens validate responses against
 * `CallUpOutcomeSchema`, and a second definition here would be free to drift
 * from the one the client actually checks.
 */
export type { CallUpOutcome };

export const callUpService = {
  /**
   * Records a call-up and applies it if it can be applied unambiguously.
   *
   * ── Why it is stored before it is understood ──────────────────────────────
   * The row is written first, with `needs-review`, and stamped with an outcome
   * afterwards. A call-up that cannot be matched, or that crashes halfway
   * through booking, is then still on file — and a real email about real work is
   * never lost because the code could not make sense of it.
   */
  async record(input: RecordCallUpInput): Promise<CallUpOutcome> {
    const matches = input.purchaseOrderId
      ? [await callUpRepository.findOrder(input.purchaseOrderId)].filter(
          (order): order is MatchedOrder => order !== null,
        )
      : await callUpRepository.findMatches(input.poNumber);

    const order = matches.length === 1 ? matches[0] : null;

    const recorded = await callUpRepository.record({
      purchaseOrderId: order?.id ?? null,
      poNumber: input.poNumber.trim(),
      accountId: order?.accountId ?? null,
      accountName: order?.accountName ?? null,
      receivedAt: input.receivedAt,
      source: input.source,
      kind: input.kind,
      readyDate: input.readyDate,
      previousReadyDate: null,
      state: 'needs-review',
      reason: null,
      jobId: null,
      jobNumber: null,
      note: input.note,
      externalId: input.externalId,
      raisedBy: input.raisedBy ?? null,
    });

    /*
     * ⚠️ The idempotency gate. The vendor retries on any non-2xx and the
     * builder's system resends, so one email can arrive three times. Acting
     * again would reschedule a job to the date it already has and write two more
     * rows into its history.
     */
    if (recorded.alreadySeen) {
      const existing = await callUpRepository.findById(recorded.id);
      log.info(
        { callUpId: recorded.id, poNumber: input.poNumber, externalId: input.externalId },
        'call-up already recorded for this email — ignored',
      );

      return {
        id: recorded.id,
        state: existing?.state ?? 'needs-review',
        reason: existing?.reason ?? null,
        jobId: existing?.jobId ?? null,
        jobNumber: existing?.jobNumber ?? null,
      };
    }

    const outcome = await this.apply(recorded.id, matches, input);

    log.info(
      {
        callUpId: recorded.id,
        poNumber: input.poNumber,
        kind: input.kind,
        source: input.source,
        state: outcome.state,
        reason: outcome.reason,
        jobNumber: outcome.jobNumber,
      },
      outcome.state === 'applied' ? 'call-up applied' : 'call-up needs review',
    );

    return outcome;
  },

  /**
   * Decides what a recorded call-up means, and does it.
   *
   * Split out from `record` so the office can retry one from the queue once
   * they have fixed whatever made it ambiguous — a missing order, a suburb
   * nobody had added — without the email having to arrive again.
   */
  async apply(
    callUpId: string,
    matches: MatchedOrder[],
    input: Pick<RecordCallUpInput, 'kind' | 'readyDate' | 'note' | 'raisedBy'>,
  ): Promise<CallUpOutcome> {
    const review = async (reason: CallUpReviewReason): Promise<CallUpOutcome> => {
      await callUpRepository.setOutcome(callUpId, {
        state: 'needs-review',
        reason,
        jobId: null,
        jobNumber: null,
        resolvedBy: null,
      });
      return { id: callUpId, state: 'needs-review', reason, jobId: null, jobNumber: null };
    };

    if (matches.length === 0) return review('no-matching-po');
    /*
     * The PO number is unique per ACCOUNT, not globally, so two builders can in
     * principle use the same string. Picking one would schedule the wrong
     * builder's work; the office is asked instead.
     */
    if (matches.length > 1) return review('ambiguous-po');

    const order = matches[0];
    if (!order) return review('no-matching-po');

    if (input.kind === 'new') return this.book(callUpId, order, input);
    return this.change(callUpId, order, input);
  },

  /** A new booking (Matt's blue notice) — the order becomes a job. */
  async book(
    callUpId: string,
    order: MatchedOrder,
    input: Pick<RecordCallUpInput, 'readyDate' | 'note' | 'raisedBy'>,
  ): Promise<CallUpOutcome> {
    const review = async (reason: CallUpReviewReason): Promise<CallUpOutcome> => {
      await callUpRepository.setOutcome(callUpId, {
        state: 'needs-review',
        reason,
        jobId: null,
        jobNumber: null,
        resolvedBy: null,
      });
      return { id: callUpId, state: 'needs-review', reason, jobId: null, jobNumber: null };
    };

    /*
     * Already booked. A resent blue notice for work that is already on the board
     * is not a second job — Matt's builders resend, and two trucks would go.
     * A cancelled job does not count: the builder may re-book what they called
     * off, which is why `listAwaiting` ignores cancelled jobs too.
     */
    if (order.jobId !== null && order.jobStatus !== 'cancelled') {
      return review('already-booked');
    }

    if (input.readyDate === null) return review('no-job-to-change');

    /*
     * The zone prices the job, and it comes from the place — never from the
     * order's free-text suburb. An unmatched suburb is a real answer ("we do not
     * go there"), so it queues rather than defaulting to a zone and quietly
     * pricing the job wrong.
     */
    const placeId = await resolvePlace(order.suburb);
    if (placeId === null) return review('unknown-suburb');

    const draft: JobDraft = {
      accountId: order.accountId,
      /*
       * The lot is how a driver identifies a house that has no letterbox yet.
       * Falling back to the street address, and last to the PO number, because
       * `siteName` is required and drivers navigate by it.
       */
      siteName: order.lotNumber
        ? `Lot ${order.lotNumber}`
        : (order.addressLine ?? `PO ${order.poNumber}`),
      lotNumber: order.lotNumber ?? '',
      addressLine: order.addressLine ?? '',
      placeId,
      builderName: order.accountName,
      accessNotes: '',
      gateHours: '',
      inductionRequired: false,
      craneAvailable: false,
      siteContactName: order.siteSupervisorName ?? '',
      siteContactMobile: '',
      siteContactEmail: '',
      poNumber: '',
      /*
       * The order supplies the area, the bag allowance and the PO number
       * server-side — see `JobDraft.purchaseOrderId`. Everything sent here for
       * those three fields is ignored on purpose.
       */
      purchaseOrderId: order.id,
      readyDate: input.readyDate,
      serviceLevel: 'standard',
      freightItem: 'plasterboard-bagged',
      expectedAreaM2: 0,
      bagCount: 0,
      notes: input.note,
    };

    const job = await jobService.create(draft, SYSTEM_CALLER);

    await callUpRepository.setOutcome(callUpId, {
      state: 'applied',
      reason: null,
      jobId: job.id,
      jobNumber: job.jobNumber,
      resolvedBy: input.raisedBy ?? SYSTEM_CALLER.name,
    });

    return {
      id: callUpId,
      state: 'applied',
      reason: null,
      jobId: job.id,
      jobNumber: job.jobNumber,
    };
  },

  /** A reschedule (green) or a cancellation (red) of work already booked. */
  async change(
    callUpId: string,
    order: MatchedOrder,
    input: Pick<RecordCallUpInput, 'kind' | 'readyDate' | 'note' | 'raisedBy'>,
  ): Promise<CallUpOutcome> {
    const review = async (reason: CallUpReviewReason): Promise<CallUpOutcome> => {
      await callUpRepository.setOutcome(callUpId, {
        state: 'needs-review',
        reason,
        jobId: order.jobId,
        jobNumber: order.jobNumber,
        resolvedBy: null,
      });
      return {
        id: callUpId,
        state: 'needs-review',
        reason,
        jobId: order.jobId,
        jobNumber: order.jobNumber,
      };
    };

    /*
     * Nothing to move. Matt, 24:07, gets greens for jobs he was never told
     * about in blue — the builder's first notice sometimes goes missing, so the
     * reschedule is the first thing we see. That is a queue item, not a booking:
     * a reschedule carries a date but says nothing about whether the work was
     * ever ordered from us.
     */
    if (order.jobId === null) return review('no-job-to-change');
    if (order.jobStatus === null || !CHANGEABLE.has(order.jobStatus)) {
      return review('job-finished');
    }

    if (input.kind === 'cancel') {
      /*
       * Ten in four years (Matt, 24:24) — and each one is a truck that would
       * otherwise drive to a site with nothing on it.
       */
      await jobService.cancel(
        order.jobId,
        'customer-request',
        input.note.trim() === '' ? 'Cancelled by the builder’s call-up' : input.note,
        SYSTEM_CALLER,
      );
    } else {
      if (input.readyDate === null) return review('no-job-to-change');
      await jobService.reschedule(order.jobId, input.readyDate, SYSTEM_CALLER);
    }

    await callUpRepository.setOutcome(callUpId, {
      state: 'applied',
      reason: null,
      jobId: order.jobId,
      jobNumber: order.jobNumber,
      // What it moved from, so the office can see the change rather than infer it.
      previousReadyDate: order.jobReadyDate,
      resolvedBy: input.raisedBy ?? SYSTEM_CALLER.name,
    });

    return {
      id: callUpId,
      state: 'applied',
      reason: null,
      jobId: order.jobId,
      jobNumber: order.jobNumber,
    };
  },

  /**
   * Calling an order up by hand — the fallback when no email arrives.
   *
   * ── Why this exists at all ────────────────────────────────────────────────
   * Matt, 29:03 and 30:40: *"sometimes that call-up email fails and the site
   * supervisor needs to book the job himself… he can log into his portal and
   * that PO that we got will be sitting there on his account and he can go call
   * this up for the 21st."*
   *
   * The builders' systems break, and when they do the work still has to happen.
   * One method serves both doors — the supervisor's portal and the office keying
   * in a phone call — because the act is identical: name a date against an order
   * that already says everything else.
   *
   * ── Why the kind is decided here rather than asked for ───────────────────
   * Nobody calling up an order thinks in terms of "new" versus "reschedule".
   * They are picking a date. Whether that books the work or moves it is a fact
   * about the order, so it is read off the order instead of being a question the
   * supervisor could get wrong.
   */
  async callUpByHand(
    purchaseOrderId: string,
    request: CallUpRequest,
    caller: Caller,
  ): Promise<CallUpOutcome> {
    const order = await callUpRepository.findOrder(purchaseOrderId);
    if (!order) throw AppError.notFound('No such purchase order');

    const isReviewer = caller.roles.some((role) => REVIEWER_ROLES.has(role));

    /*
     * ⚠️ The scope check, in the service rather than the route.
     *
     * A customer may only call up their OWN account's orders. Getting this wrong
     * does not show somebody a screen they should not see — it lets one builder
     * book a truck against another builder's purchase order, which is billable
     * work on somebody else's money.
     */
    if (!isReviewer && caller.accountId !== order.accountId) {
      throw AppError.notFound('No such purchase order');
    }

    /*
     * A live job means they are moving a date, not booking one. Cancelled does
     * not count: work that was called off can be called up again, which is the
     * same rule `listAwaiting` and `book` apply.
     */
    const hasLiveJob = order.jobId !== null && order.jobStatus !== 'cancelled';

    return this.record({
      poNumber: order.poNumber,
      purchaseOrderId: order.id,
      kind: hasLiveJob ? 'reschedule' : 'new',
      readyDate: request.readyDate,
      receivedAt: new Date(),
      // The office keying one in is almost always relaying a phone call; a
      // customer doing it themselves is the portal. Neither is an email.
      source: isReviewer ? 'phone' : 'portal',
      note: request.note,
      // No external id: nothing to deduplicate against, and a sparse unique
      // index is what lets many of these coexist.
      externalId: null,
      raisedBy: caller.name,
    });
  },

  /**
   * Tries a queued call-up again, after somebody fixed what blocked it.
   *
   * ── Why a retry rather than re-keying it by hand ──────────────────────────
   * Every reason a call-up lands in the queue is a fixable data problem outside
   * the message: the purchase order had not been confirmed yet, its suburb was
   * missing from the places table, two accounts shared a PO number. Once that is
   * sorted the email is perfectly good — and the alternative is somebody reading
   * a date off a queue row and typing it into a booking form, which is exactly
   * the retyping this whole pipeline exists to remove.
   *
   * ⚠️ Re-resolves from scratch rather than trusting what was matched before.
   * The stored row's `purchaseOrderId` is null on the case this is used for most
   * (`no-matching-po`), and a match found an hour ago may since have gained a
   * job — so the decision is made again against the world as it is now.
   */
  async retry(id: string, caller: Caller): Promise<CallUpOutcome> {
    assertReviewer(caller);

    const callUp = await callUpRepository.findById(id);
    if (!callUp) throw AppError.notFound('No such call-up');

    /*
     * Applied means a job was created or moved. Running it again would book a
     * second job or move the date twice, and the second run would look like the
     * authoritative one.
     */
    if (callUp.state === 'applied') {
      throw AppError.conflict(
        `That call-up is already applied${callUp.jobNumber === null ? '' : ` to job #${String(callUp.jobNumber)}`}`,
      );
    }

    const matches = await callUpRepository.findMatches(callUp.poNumber);

    const outcome = await this.apply(id, matches, {
      kind: callUp.kind,
      readyDate: callUp.readyDate,
      note: callUp.note,
      raisedBy: caller.name,
    });

    log.info(
      {
        callUpId: id,
        poNumber: callUp.poNumber,
        was: callUp.reason,
        state: outcome.state,
        reason: outcome.reason,
        by: caller.name,
      },
      outcome.state === 'applied' ? 'queued call-up applied on retry' : 'call-up still needs review',
    );

    return outcome;
  },

  /**
   * Sets a call-up aside as not actionable.
   *
   * ── Why the queue needs a way out that is not a booking ───────────────────
   * Not every message in here is work. A builder resends a notice for a job
   * that was cancelled months ago, or an unrelated email matches the template
   * closely enough to be read as a call-up. Without this the row sits in the
   * queue forever, and a queue nobody can empty is a queue nobody reads.
   *
   * ⚠️ Never deleted. The record is why a job did not get booked, and that is
   * the question somebody asks three weeks later.
   */
  async reject(id: string, note: string, caller: Caller): Promise<void> {
    assertReviewer(caller);

    const callUp = await callUpRepository.findById(id);
    if (!callUp) throw AppError.notFound('No such call-up');

    if (callUp.state === 'applied') {
      throw AppError.conflict('That call-up already produced a job — cancel the job instead');
    }

    await callUpRepository.setOutcome(id, {
      state: 'rejected',
      // The reason it could not be applied is kept: "rejected because no
      // matching PO" is a different fact from a bare rejection.
      reason: callUp.reason,
      jobId: callUp.jobId,
      jobNumber: callUp.jobNumber,
      resolvedBy: caller.name,
    });

    await callUpRepository.appendNote(id, note.trim());

    log.info(
      { callUpId: id, poNumber: callUp.poNumber, was: callUp.reason, by: caller.name },
      'call-up rejected',
    );
  },

  /* ── Reading ──────────────────────────────────────────────────────────── */

  async list(
    query: { state?: CallUpState; page: number; pageSize: number },
    caller: Caller,
  ): Promise<{ data: CallUp[]; meta: PageMeta }> {
    assertReviewer(caller);
    return callUpRepository.list(query);
  },

  async get(id: string, caller: Caller): Promise<CallUp> {
    assertReviewer(caller);
    const callUp = await callUpRepository.findById(id);
    if (!callUp) throw AppError.notFound('No such call-up');
    return callUp;
  },

  async countNeedingReview(): Promise<number> {
    return callUpRepository.countNeedingReview();
  },

  /**
   * Confirmed orders with no job — the office's *"what have we not been booked
   * for yet?"* list.
   *
   * `serviceable` is computed per row rather than stored: it answers "will a
   * call-up for this actually be able to create a job?", and the office needs to
   * know that BEFORE the email arrives, not from a queue item afterwards.
   */
  async listAwaiting(
    query: { accountId?: string | null; page: number; pageSize: number },
    caller: Caller,
  ): Promise<{ data: AwaitingCallUp[]; meta: PageMeta }> {
    /*
     * ⚠️ Two callers, one list, and the difference is the scope — not the role.
     *
     * The office sees every account's waiting orders. A customer sees their own,
     * and may not widen that by asking for another account's id. Checked here
     * rather than by handing the portal an office role: a service that accepted
     * a spoofed role would make every future caller's scope a matter of who
     * remembered to spoof correctly.
     */
    if (!caller.roles.some((role) => REVIEWER_ROLES.has(role))) {
      if (!caller.accountId || query.accountId !== caller.accountId) {
        throw AppError.forbidden('You can only see your own account’s purchase orders');
      }
    }

    const page = await callUpRepository.listAwaiting(query);

    const data = await Promise.all(
      page.data.map(async (row) => ({
        ...row,
        serviceable: (await resolvePlace(row.suburb)) !== null,
      })),
    );

    return { data, meta: page.meta };
  },
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function assertReviewer(caller: Caller): void {
  if (!caller.roles.some((role) => REVIEWER_ROLES.has(role))) {
    throw AppError.forbidden('Call-ups are worked by the office');
  }
}

/**
 * The place a free-text suburb refers to, or null.
 *
 * ── Why only an exact match counts ────────────────────────────────────────
 * The picker's search is deliberately fuzzy — it matches mid-word so somebody
 * typing "park" finds "Oran Park". That is right for a human choosing from a
 * list and wrong here, where there is nobody to choose: "Park" would match four
 * suburbs in three zones, and the zone sets the rate. So the suburb has to name
 * exactly one place, or the call-up goes to a human.
 */
async function resolvePlace(suburb: string | null): Promise<string | null> {
  const needle = suburb?.trim().toLowerCase() ?? '';
  if (needle === '') return null;

  const candidates = await placeRepository.search(needle);
  const exact = candidates.filter((place) => place.suburb.toLowerCase() === needle);

  return exact.length === 1 ? (exact[0]?.id ?? null) : null;
}
