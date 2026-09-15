import type { Response } from 'express';
import { AppError } from '../../lib/app-error.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { invoiceService, type Caller } from './invoice.service.js';
import type {
  InvoiceIdParamsSchema,
  InvoiceIdsSchema,
  JobIdParamsSchema,
  ListInvoicesQuerySchema,
  RecordPoSchema,
} from './invoice.schemas.js';

/**
 * Controller layer — HTTP in, HTTP out. No business rules, no Mongoose.
 *
 * Handlers are arrow-function properties, not methods: Express receives them as
 * bare references, so a `this`-bound method would silently lose its receiver.
 */

/**
 * Throws rather than defaulting if `req.auth` is missing — that means the route
 * was mounted without `requireAuth`, which is a wiring mistake to find loudly in
 * development rather than a request to serve anonymously.
 */
function callerFrom(req: { auth?: Express.Request['auth'] }): Caller {
  if (!req.auth) throw AppError.unauthenticated('Sign in to continue');

  return {
    userId: req.auth.userId,
    name: req.auth.name,
    roles: req.auth.roles as Caller['roles'],
    accountId: req.auth.accountId,
  };
}

export const invoiceController = {
  list: async (
    req: ValidatedRequest<{ query: typeof ListInvoicesQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await invoiceService.list(req.validated.query, callerFrom(req)));
  },

  get: async (
    req: ValidatedRequest<{ params: typeof InvoiceIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await invoiceService.get(req.validated.params.id, callerFrom(req)));
  },

  /** 201 with what was raised — one invoice, or two when the split applies. */
  generate: async (
    req: ValidatedRequest<{ params: typeof JobIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    const created = await invoiceService.generateForJob(
      req.validated.params.jobId,
      callerFrom(req),
    );
    res.status(201).json(created);
  },

  /** Returns the COUNT that changed — a bulk action is expected to be partial. */
  send: async (
    req: ValidatedRequest<{ body: typeof InvoiceIdsSchema }>,
    res: Response,
  ): Promise<void> => {
    const changed = await invoiceService.send(req.validated.body.ids, callerFrom(req));
    res.json({ changed });
  },

  approve: async (
    req: ValidatedRequest<{ body: typeof InvoiceIdsSchema }>,
    res: Response,
  ): Promise<void> => {
    const changed = await invoiceService.approve(req.validated.body.ids, callerFrom(req));
    res.json({ changed });
  },

  recordPo: async (
    req: ValidatedRequest<{ params: typeof InvoiceIdParamsSchema; body: typeof RecordPoSchema }>,
    res: Response,
  ): Promise<void> => {
    await invoiceService.recordPo(
      req.validated.params.id,
      req.validated.body.poNumber,
      callerFrom(req),
    );
    res.status(204).send();
  },

  /**
   * 200 with the links — the render has happened by the time this answers.
   *
   * ⚠️ This used to be a 202. That was a promise the caller could do nothing
   * with: the PDF was written to storage and no route ever served it back, so
   * "accepted" was the end of the story rather than the start of one.
   */
  requestPdf: async (
    req: ValidatedRequest<{ body: typeof InvoiceIdsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await invoiceService.requestPdf(req.validated.body.ids, callerFrom(req)));
  },

  /**
   * ── Why 200 and a body, where this used to be a bodyless 202 ───────────
   * 202 was honest while the retry only re-queued: the work had been accepted
   * and had not happened. It now pushes to Xero and waits, so by the time this
   * responds the answer is known — and reporting "accepted" for something that
   * has already failed leaves the page telling the user it worked while the
   * badge beside it says otherwise.
   */
  retryXero: async (
    req: ValidatedRequest<{ params: typeof InvoiceIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await invoiceService.retryXero(req.validated.params.id, callerFrom(req)));
  },
};
