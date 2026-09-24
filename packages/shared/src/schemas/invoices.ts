import * as z from 'zod';
import {
  IsoDateSchema,
  IsoDateTimeSchema,
  MoneySchema,
  NonEmptyStringSchema,
  ObjectIdSchema,
} from './primitives.js';
import { BrandIdSchema } from './party.js';

/**
 * Invoices (M7).
 *
 * ── The two-invoice workflow is the load-bearing part ──────────────────────
 * The base invoice goes out immediately on completion against the original PO;
 * additional charges are invoiced **separately, later**, once a new PO arrives.
 * Matt's own reasoning: "any additional charges require a separate PO, which can
 * take time. So, to avoid delays in receiving payment for the actual job, we
 * send the invoice for the job immediately upon completion and then send another
 * invoice later." So `kind` is a first-class field, not a flag.
 *
 * Accounts with no PO requirement get everything on one invoice.
 */
export const INVOICE_KINDS = ['base', 'additional-charges'] as const;
export const InvoiceKindSchema = z.enum(INVOICE_KINDS).meta({ id: 'InvoiceKind' });
export type InvoiceKind = z.infer<typeof InvoiceKindSchema>;

export const INVOICE_KIND_LABELS: Record<InvoiceKind, string> = {
  base: 'Base invoice',
  'additional-charges': 'Additional charges',
};

/**
 * `awaiting-po` is the M7.3 queue — approved charges that cannot be invoiced
 * until a PO arrives. It is where money currently leaks, so it is a state rather
 * than an absence.
 *
 * `unknown` is not laziness: their current invoice list genuinely shows payment
 * status "Unknown" for several customers because the Xero sync only partly
 * works today. Modelling it honestly is what makes fixing it visible.
 */
export const INVOICE_STATUSES = [
  'draft',
  'awaiting-po',
  'sent',
  'paid',
  'overdue',
  'unknown',
] as const;
export const InvoiceStatusSchema = z.enum(INVOICE_STATUSES).meta({ id: 'InvoiceStatus' });
export type InvoiceStatus = z.infer<typeof InvoiceStatusSchema>;

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  'awaiting-po': 'Awaiting PO',
  sent: 'Sent',
  paid: 'Paid',
  overdue: 'Overdue',
  unknown: 'Unknown',
};

export const InvoiceListItemSchema = z
  .object({
    id: ObjectIdSchema,
    /** M1.4 — continues from ~104,100. */
    invoiceNumber: z.number().int().positive(),
    kind: InvoiceKindSchema,
    status: InvoiceStatusSchema,
    brandId: BrandIdSchema,
    accountId: ObjectIdSchema,
    accountName: NonEmptyStringSchema,
    jobId: ObjectIdSchema.nullable(),
    jobNumber: z.number().int().positive().nullable(),
    /** PO number or job reference — one field, printed as the PO (Matt, 9:56). */
    poNumber: z.string().nullable(),
    issuedOn: IsoDateSchema.nullable(),
    /** 7-day terms — there is no slack in their cash cycle. */
    dueOn: IsoDateSchema.nullable(),
    subtotalExGst: MoneySchema,
    gst: MoneySchema,
    totalIncGst: MoneySchema,
    paidAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'InvoiceListItem' });

export type InvoiceListItem = z.infer<typeof InvoiceListItemSchema>;

/**
 * An invoice that billing a job produced or changed.
 *
 * ── Why "updated" exists ──────────────────────────────────────────────────
 * Billing a job used to only ever CREATE, and refused once the job had an
 * invoice of each kind. So a charge approved after the invoice was raised was
 * never billed at all. Now a charge like that is added to the job's invoice
 * while it is still unsent, and the caller is told which invoices were new and
 * which were changed — "Invoice raised" over an invoice that already existed
 * would send the office looking for a second document that is not there.
 *
 * Defaulted so a console updated before the API still reads the response.
 */
export const RaisedInvoiceSchema = InvoiceListItemSchema.extend({
  change: z.enum(['created', 'updated']).default('created'),
}).meta({ id: 'RaisedInvoice' });

export type RaisedInvoice = z.infer<typeof RaisedInvoiceSchema>;

/**
 * One invoice line.
 *
 * `quantity × unitRate = amount` is a functional GAIN over TransVirtual, which
 * cannot render quantities — Matt wants "2 residential recycling bags at $30
 * each, equalling $60". Worth demoing.
 */
export const InvoiceLineSchema = z
  .object({
    id: ObjectIdSchema,
    description: NonEmptyStringSchema,
    quantity: z.number(),
    unitRate: MoneySchema,
    amount: MoneySchema,
    /** Set on the additional-charges invoice, so the driver's evidence is traceable. */
    raisedBy: z.string().nullable(),
  })
  .meta({ id: 'InvoiceLine' });

/**
 * I1 Xero — scoped honestly as "2-way": invoices and contacts out, payment
 * status in. Credit notes, part-payments and bank reconciliation are v1.1, so
 * nothing here models them.
 *
 * `unknown` is not laziness: their current invoice list genuinely shows payment
 * status "Unknown" for several customers because the sync only partly works
 * today. Fixing that is a visible day-one win, and it is only visible if the
 * broken state is modelled rather than hidden.
 */
export const XERO_SYNC_STATES = ['not-synced', 'synced', 'failed', 'unknown'] as const;
export const XeroSyncStateSchema = z.enum(XERO_SYNC_STATES).meta({ id: 'XeroSyncState' });
export type XeroSyncState = z.infer<typeof XeroSyncStateSchema>;

export const XERO_SYNC_LABELS: Record<XeroSyncState, string> = {
  'not-synced': 'Not sent to Xero',
  synced: 'In Xero',
  failed: 'Xero push failed',
  unknown: 'Unknown',
};

export const InvoiceSchema = InvoiceListItemSchema.extend({
  lines: z.array(InvoiceLineSchema),
  /**
   * Which template produced it, as the name read at the time (M7.4, M7.5).
   *
   * ⚠️ A frozen copy, not a reference. Renaming or deleting a template must
   * not change what an invoice already sent says it was printed on.
   */
  templateName: NonEmptyStringSchema,
  /**
   * Storage key for the rendered PDF (M7.6). Null until one exists.
   *
   * The stored bytes ARE the invoice — a reprint serves this object rather
   * than re-rendering, so a document reprinted a year later is identical to
   * the one in the builder's filing system.
   */
  pdfKey: z.string().nullable(),
  sentAt: IsoDateTimeSchema.nullable(),
  xeroState: XeroSyncStateSchema,
  xeroLastSyncAt: IsoDateTimeSchema.nullable(),
  xeroMessage: z.string().nullable(),
  /** Bank details and terms printed on the PDF, from the brand (M7.5). */
  paymentTermsDays: z.number().int().nonnegative(),
  notes: z.string(),
}).meta({ id: 'Invoice' });

export type InvoiceLine = z.infer<typeof InvoiceLineSchema>;
export type Invoice = z.infer<typeof InvoiceSchema>;

/**
 * M7.6 — a rendered invoice, and where to fetch it from.
 *
 * ── Why a short-lived URL rather than the bytes ───────────────────────────
 * The PDF lives in object storage, so the API hands back a presigned link the
 * browser follows directly instead of streaming megabytes through Node. That is
 * the same shape docket photos, lead attachments and PO documents already use.
 *
 * ⚠️ The URL EXPIRES (`S3_URL_TTL_SECONDS`). It is a fetch instruction for right
 * now, never something to store on a record or print in an email — a saved one
 * is a link that works in testing and is dead by the time a customer clicks it.
 */
export const InvoiceDownloadSchema = z
  .object({
    id: ObjectIdSchema,
    invoiceNumber: z.number().int().positive(),
    /**
     * What the file is called once saved — "Invoice PGA-104312.pdf".
     *
     * Carries the prefix because that is what the office and the builder both
     * quote; the bare sequence is an internal key that Xero matches on.
     */
    fileName: NonEmptyStringSchema,
    url: NonEmptyStringSchema,
  })
  .meta({ id: 'InvoiceDownload' });

export type InvoiceDownload = z.infer<typeof InvoiceDownloadSchema>;

/**
 * The answer to "render these and give me the files".
 *
 * `downloads` can be SHORTER than what was asked for: one invoice whose brand
 * has no template fails on its own, and the screen has to be able to say so
 * rather than report a success it did not have.
 */
export const InvoiceDownloadsSchema = z
  .object({
    requested: z.number().int().nonnegative(),
    downloads: z.array(InvoiceDownloadSchema),
  })
  .meta({ id: 'InvoiceDownloads' });

export type InvoiceDownloads = z.infer<typeof InvoiceDownloadsSchema>;
