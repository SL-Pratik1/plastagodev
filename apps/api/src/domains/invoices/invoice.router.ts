import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
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
 * ── Why the acts are gated in the SERVICE, not here ───────────────────────
 * `assertFinance` guards send, approve, record-a-PO and the Xero retry from
 * inside the service, so the rule holds however the call arrives — a check on a
 * route is one somebody can forget to copy onto the next route.
 *
 * ── Why the ROUTER is gated as well ───────────────────────────────────────
 * ⚠️ This note used to say there was no router gate because "a customer has a
 * legitimate scoped view here: their own invoices are exactly what the portal
 * shows them". That premise is not true of this router. The portal has its own
 * endpoints — `portal.http.ts` calls nothing else — and `/portal/invoices` is
 * the one that gets the rule right, refusing a site supervisor with "Ask your
 * account administrator — this is not shown on your login".
 *
 * Leaving these reads open to any signed-in caller meant the two disagreed, and
 * the wrong one won: a SITE SUPERVISOR read the invoices the portal refuses
 * them, and the ALLOCATOR and the DRIVER — neither of whom holds `invoices:read`
 * or `pricing:view` — listed all 147 invoices across every customer and could
 * render any of them as a PDF, because `requestPdf` never asked who was calling.
 *
 * So the office roles that actually hold `invoices:read` are the ones admitted.
 * Customers keep their scoped view where it was always meant to be: the portal.
 */
export const invoiceRouter = Router();

invoiceRouter.use(requireAuth);
invoiceRouter.use(requireRole('super-admin', 'operations', 'office-staff'));

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
