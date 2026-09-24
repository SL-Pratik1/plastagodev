import {
  CallUpRequestSchema,
  FutileDecisionSchema,
  LeadConversionSchema,
  LeadCreateSchema,
  LeadUpdateSchema,
  PoConfirmationSchema,
} from '@plastago/shared';
import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { leadController } from './lead.controller.js';
import {
  AttachLeadFileSchema,
  LeadAttachmentParamsSchema,
  LeadIdParamsSchema,
  ListLeadsQuerySchema,
} from './lead.schemas.js';
import { callUpController } from './call-up.controller.js';
import {
  CallUpIdParamsSchema,
  ListAwaitingQuerySchema,
  ListCallUpsQuerySchema,
  PurchaseOrderIdParamsSchema,
  RejectCallUpSchema,
} from './call-up.schemas.js';
import { poReviewController } from './po-review.controller.js';
import {
  ExtractionIdParamsSchema,
  IngestExtractionSchema,
  ListExtractionsQuerySchema,
  RejectExtractionSchema,
} from './po-review.schemas.js';
import { queueController } from './queue.controller.js';
import {
  ChangeRequestDecisionBodySchema,
  ChargeDecisionBodySchema,
  QueueIdParamsSchema,
  QueueIdsSchema,
  ApprovalListQuerySchema,
  FutileListQuerySchema,
  AwaitingPoListQuerySchema,
  QueueListQuerySchema,
} from './queue.schemas.js';

/**
 * Router layer — paths and middleware only. No logic.
 *
 * ── Why the role gate is in the service, not here ─────────────────────────
 * Because approving a charge is narrower than reading a worklist — an allocator
 * works the futile queue but does not decide what a customer is billed — and
 * expressing that as two different `requireRole` calls across nine routes is
 * nine chances to put the wrong one on. `assertOffice` and `assertApprover` sit
 * next to the rules they protect.
 *
 * What is guaranteed here is only that somebody is signed in.
 */
export const queueRouter = Router();

queueRouter.use(requireAuth);

/** One call for every nav badge. Polled by the shell, not by each screen. */
queueRouter.get('/counts', asyncHandler(queueController.counts));

/* ── M2.6 · Futile pickup review ─────────────────────────────────────────── */

queueRouter.get(
  '/futile',
  validate({ query: FutileListQuerySchema }),
  asyncHandler(queueController.futileList),
);

queueRouter.get(
  '/futile/:id',
  validate({ params: QueueIdParamsSchema }),
  asyncHandler(queueController.futileGet),
);

/**
 * Both outcomes keep the $120 fee — the decision is about the JOB.
 * See the note on `futileDecide`.
 */
queueRouter.post(
  '/futile/:id/decision',
  validate({ params: QueueIdParamsSchema, body: FutileDecisionSchema }),
  asyncHandler(queueController.futileDecide),
);

/* ── M2.7 · Additional service approvals ─────────────────────────────────── */

/**
 * Charges awaiting a decision — and, on request, ones already decided.
 *
 * `approvalState` defaults to `pending`, so the queue stays a worklist. It is
 * there because approving used to remove a charge from the only screen that
 * lists charges, which made an approved charge impossible to look up again from
 * the queue that approved it.
 */
queueRouter.get(
  '/approvals',
  validate({ query: ApprovalListQuerySchema }),
  asyncHandler(queueController.approvalList),
);

queueRouter.get(
  '/approvals/:id',
  validate({ params: QueueIdParamsSchema }),
  asyncHandler(queueController.approvalGet),
);

/** Bulk, because the queue is worked in batches. */
queueRouter.post(
  '/approvals/decision',
  validate({ body: ChargeDecisionBodySchema }),
  asyncHandler(queueController.approvalDecide),
);

/* ── M5.4 · Change requests raised from the portal ─────────────────────── */

queueRouter.get(
  '/change-requests',
  validate({ query: QueueListQuerySchema }),
  asyncHandler(queueController.changeRequestList),
);

/** Records the answer; it does not move the job. See `changeRequestDecide`. */
queueRouter.post(
  '/change-requests/:id/decision',
  validate({ params: QueueIdParamsSchema, body: ChangeRequestDecisionBodySchema }),
  asyncHandler(queueController.changeRequestDecide),
);

/* ── M7.3 · Approved charges awaiting a PO ───────────────────────────────── */

queueRouter.get(
  '/awaiting-po',
  validate({ query: AwaitingPoListQuerySchema }),
  asyncHandler(queueController.awaitingPoList),
);

/**
 * Emails each billing contact asking for the purchase order, and records the
 * chase so ageing is measured against contact.
 */
queueRouter.post(
  '/awaiting-po/chase',
  validate({ body: QueueIdsSchema }),
  asyncHandler(queueController.awaitingPoChase),
);

/* ── M2.12 · AI purchase-order review ────────────────────────────────────── */

/**
 * ⚠️ The queue that stops a model billing a customer.
 *
 * An extraction is a PROPOSAL — see the service. Nothing here writes a purchase
 * order except `confirm`, and `confirm` is a human pressing a button.
 */
/* ── Call-ups (M2.12b) ─────────────────────────────────────────────────── */

/**
 * Orders that have been confirmed and not yet booked — Matt's *"sitting there
 * waiting"* (21:30).
 *
 * ⚠️ Declared before `/call-ups/:id` so the literal path is not captured as an
 * id. Express matches in declaration order, and "awaiting" is a valid
 * `ObjectId`-shaped string to nobody but the validator, which would 400 instead
 * of serving the list.
 */
queueRouter.get(
  '/call-ups/awaiting',
  validate({ query: ListAwaitingQuerySchema }),
  asyncHandler(callUpController.listAwaiting),
);

queueRouter.get(
  '/call-ups',
  validate({ query: ListCallUpsQuerySchema }),
  asyncHandler(callUpController.list),
);

queueRouter.get(
  '/call-ups/:id',
  validate({ params: CallUpIdParamsSchema }),
  asyncHandler(callUpController.get),
);

/**
 * Calling an order up by hand (Matt, 30:40).
 *
 * Keyed by the ORDER, not by a call-up id: the caller is naming a date against
 * an order, and the call-up record is what that produces rather than what it
 * addresses.
 */
queueRouter.post(
  '/call-ups/orders/:purchaseOrderId',
  validate({ params: PurchaseOrderIdParamsSchema, body: CallUpRequestSchema }),
  asyncHandler(callUpController.callUp),
);

/**
 * Working the queue: try it again, or set it aside.
 *
 * Every reason a call-up queues is a fixable data problem outside the message —
 * an unconfirmed order, a suburb nobody had added. Retry re-decides against the
 * world as it now is, so the email never has to be re-keyed by hand.
 */
queueRouter.post(
  '/call-ups/:id/retry',
  validate({ params: CallUpIdParamsSchema }),
  asyncHandler(callUpController.retry),
);

queueRouter.post(
  '/call-ups/:id/reject',
  validate({ params: CallUpIdParamsSchema, body: RejectCallUpSchema }),
  asyncHandler(callUpController.reject),
);

queueRouter.get(
  '/po-review',
  validate({ query: ListExtractionsQuerySchema }),
  asyncHandler(poReviewController.list),
);

queueRouter.get(
  '/po-review/:id',
  validate({ params: ExtractionIdParamsSchema }),
  asyncHandler(poReviewController.get),
);

queueRouter.post(
  '/po-review/:id/confirm',
  validate({ params: ExtractionIdParamsSchema, body: PoConfirmationSchema }),
  asyncHandler(poReviewController.confirm),
);

queueRouter.post(
  '/po-review/:id/reject',
  validate({ params: ExtractionIdParamsSchema, body: RejectExtractionSchema }),
  asyncHandler(poReviewController.reject),
);

/**
 * Where an external extractor posts what it read.
 *
 * ── Why this sits behind the same session gate as everything else ─────────
 * Because it writes into a queue humans act on, and an unauthenticated ingest
 * endpoint is a way for anybody to put a plausible-looking purchase order in
 * front of the office. When the extractor runs as a service it gets its own
 * account; it does not get an exemption.
 */
queueRouter.post(
  '/po-review/ingest',
  validate({ body: IngestExtractionSchema }),
  asyncHandler(poReviewController.ingest),
);

/* ── M5 · Journey A — leads and onboarding ───────────────────────────────── */

queueRouter.get(
  '/leads',
  validate({ query: ListLeadsQuerySchema }),
  asyncHandler(leadController.list),
);

/**
 * The Won / Conversion cards above the grid.
 *
 * ⚠️ ABOVE `/leads/:id` on purpose. Express matches in order, so registered
 * after it this path would be read as a lead whose id is the word "stats".
 */
queueRouter.get('/leads/stats', asyncHandler(leadController.stats));

queueRouter.get(
  '/leads/:id',
  validate({ params: LeadIdParamsSchema }),
  asyncHandler(leadController.get),
);

/** A.1 — take a lead by hand, for enquiries that never touch the web form. */
queueRouter.post(
  '/leads',
  validate({ body: LeadCreateSchema }),
  asyncHandler(leadController.create),
);

queueRouter.patch(
  '/leads/:id',
  validate({ params: LeadIdParamsSchema, body: LeadUpdateSchema }),
  asyncHandler(leadController.update),
);

/** Matt, 5:53 — PDF proposals attached to the lead they were sent for. */
queueRouter.post(
  '/leads/:id/attachments',
  validate({ params: LeadIdParamsSchema, body: AttachLeadFileSchema }),
  asyncHandler(leadController.attach),
);

queueRouter.delete(
  '/leads/:id/attachments/:attachmentId',
  validate({ params: LeadAttachmentParamsSchema }),
  asyncHandler(leadController.detach),
);

/** A.4 — creates the account. Operations only; see `assertConverter`. */
queueRouter.post(
  '/leads/:id/convert',
  validate({ params: LeadIdParamsSchema, body: LeadConversionSchema }),
  asyncHandler(leadController.convert),
);
