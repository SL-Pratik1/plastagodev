import {
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
import { poReviewController } from './po-review.controller.js';
import {
  ExtractionIdParamsSchema,
  IngestExtractionSchema,
  ListExtractionsQuerySchema,
  RejectExtractionSchema,
} from './po-review.schemas.js';
import { queueController } from './queue.controller.js';
import {
  ChargeDecisionBodySchema,
  QueueIdParamsSchema,
  QueueIdsSchema,
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
  validate({ query: QueueListQuerySchema }),
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

queueRouter.get(
  '/approvals',
  validate({ query: QueueListQuerySchema }),
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

/* ── M7.3 · Approved charges awaiting a PO ───────────────────────────────── */

queueRouter.get(
  '/awaiting-po',
  validate({ query: QueueListQuerySchema }),
  asyncHandler(queueController.awaitingPoList),
);

/**
 * Records that a chase went out, so ageing is measured against contact.
 * It does not send anything — somebody picks up the phone.
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
