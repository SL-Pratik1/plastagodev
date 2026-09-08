import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { invoiceController } from './invoice.controller.js';
import {
  InvoiceIdParamsSchema,
  InvoiceIdsSchema,
  JobIdParamsSchema,
  ListInvoicesQuerySchema,
  RecordPoSchema,
} from './invoice.schemas.js';

/**
 * Router layer — paths and middleware only. No logic.
 *
 * ── Why there is no `requireRole` on the whole router ─────────────────────
 * Unlike dispatch, a customer has a legitimate scoped view here: their own
 * invoices are exactly what the portal shows them. So reads are open to any
 * signed-in caller and SCOPED in the repository, while the acts that decide what
 * PlastaGo bills — send, approve, record a PO — are gated in the service by
 * `assertFinance`.
 *
 * Gating those in the service rather than here is deliberate: the same rule has
 * to hold when the portal calls them too, and a check on a route is one somebody
 * can forget to copy onto the next route.
 */
export const invoiceRouter = Router();

invoiceRouter.use(requireAuth);

/* ── Reads — scoped, not gated ───────────────────────────────────────────── */

invoiceRouter.get(
  '/',
  validate({ query: ListInvoicesQuerySchema }),
  asyncHandler(invoiceController.list),
);

invoiceRouter.get(
  '/:id',
  validate({ params: InvoiceIdParamsSchema }),
  asyncHandler(invoiceController.get),
);

/* ── M7.1 · raising ──────────────────────────────────────────────────────── */

/**
 * Raises the invoices for a completed job.
 *
 * Keyed by JOB rather than taking a body, because there is nothing to choose:
 * what goes on the invoice is the job's billable charges, and whether it splits
 * is the account's PO policy. A body would only be a way to disagree with both.
 */
invoiceRouter.post(
  '/jobs/:jobId',
  validate({ params: JobIdParamsSchema }),
  asyncHandler(invoiceController.generate),
);

/* ── M7.7 · bulk actions ─────────────────────────────────────────────────── */

invoiceRouter.post(
  '/send',
  validate({ body: InvoiceIdsSchema }),
  asyncHandler(invoiceController.send),
);

invoiceRouter.post(
  '/approve',
  validate({ body: InvoiceIdsSchema }),
  asyncHandler(invoiceController.approve),
);

/* ── M7.6 · PDFs ─────────────────────────────────────────────────────────── */

invoiceRouter.post(
  '/pdf',
  validate({ body: InvoiceIdsSchema }),
  asyncHandler(invoiceController.requestPdf),
);

/* ── M7.3 · the purchase order that unblocks an invoice ──────────────────── */

invoiceRouter.post(
  '/:id/purchase-order',
  validate({ params: InvoiceIdParamsSchema, body: RecordPoSchema }),
  asyncHandler(invoiceController.recordPo),
);

/* ── I1 · Xero ───────────────────────────────────────────────────────────── */

invoiceRouter.post(
  '/:id/xero-retry',
  validate({ params: InvoiceIdParamsSchema }),
  asyncHandler(invoiceController.retryXero),
);
