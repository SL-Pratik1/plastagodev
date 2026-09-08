import {
  BrandIdSchema,
  InvoiceKindSchema,
  InvoiceStatusSchema,
  ObjectIdSchema,
  XeroSyncStateSchema,
} from '@plastago/shared';
import * as z from 'zod';

/**
 * Request shapes that belong to the transport rather than the domain.
 *
 * `@plastago/shared` describes what an Invoice IS; this describes how one is
 * asked for and acted on over HTTP.
 */

export const InvoiceIdParamsSchema = z
  .object({ id: ObjectIdSchema })
  .meta({ id: 'InvoiceIdParams' });

export const JobIdParamsSchema = z
  .object({ jobId: ObjectIdSchema })
  .meta({ id: 'InvoiceJobIdParams' });

/**
 * The invoice grid's query.
 *
 * Facets are a fixed set, not a pass-through — an arbitrary filter reaching
 * Mongo is a caller choosing their own query plan, and a caller sorting by a
 * field the projection withholds.
 */
export const ListInvoicesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    // Capped: a page of 5,000 invoices is not a page, it is an export, and it
    // is how one request holds a connection open long enough to time out.
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    sort: z.string().trim().max(40).optional(),
    q: z.string().trim().max(120).optional(),
    status: InvoiceStatusSchema.optional(),
    kind: InvoiceKindSchema.optional(),
    account: ObjectIdSchema.optional(),
    brandId: BrandIdSchema.optional(),
    xeroState: XeroSyncStateSchema.optional(),
    /** Relative windows, matching how the office phrases a filter. */
    issuedWindow: z.enum(['today', 'last-7', 'last-30', 'last-90']).optional(),
  })
  .meta({ id: 'ListInvoicesQuery' });

/**
 * A bulk action's payload.
 *
 * Bounded at 200: bulk send and bulk approve are the documented operations
 * (M7.7), and an unbounded list is a way to make one request update the whole
 * table.
 */
export const InvoiceIdsSchema = z
  .object({
    ids: z
      .array(ObjectIdSchema)
      .min(1, 'Select at least one invoice')
      .max(200, 'Select fewer invoices — up to 200 at a time'),
  })
  .meta({ id: 'InvoiceIds' });

/** M7.3 — the purchase order that unblocks an invoice. */
export const RecordPoSchema = z
  .object({
    poNumber: z
      .string()
      .trim()
      .min(1, 'Enter the purchase order number the customer issued')
      .max(60),
  })
  .meta({ id: 'RecordPo' });
