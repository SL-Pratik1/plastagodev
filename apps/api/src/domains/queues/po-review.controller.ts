import type { PoConfirmationSchema } from '@plastago/shared';
import type { Response } from 'express';
import { AppError } from '../../lib/app-error.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { poReviewService, type Caller } from './po-review.service.js';
import type {
  ExtractionIdParamsSchema,
  ExtractorWebhookSchema,
  IngestExtractionSchema,
  ListExtractionsQuerySchema,
  RejectExtractionSchema,
} from './po-review.schemas.js';

/** Controller layer — HTTP in, HTTP out. No business rules, no Mongoose. */

function callerFrom(req: { auth?: Express.Request['auth'] }): Caller {
  if (!req.auth) throw AppError.unauthenticated('Sign in to continue');
  return {
    userId: req.auth.userId,
    name: req.auth.name,
    roles: req.auth.roles as Caller['roles'],
  };
}

export const poReviewController = {
  list: async (
    req: ValidatedRequest<{ query: typeof ListExtractionsQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await poReviewService.list(req.validated.query, callerFrom(req)));
  },

  get: async (
    req: ValidatedRequest<{ params: typeof ExtractionIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await poReviewService.get(req.validated.params.id, callerFrom(req)));
  },

  /** 202: accepted into the queue. It is not a purchase order until confirmed. */
  ingest: async (
    req: ValidatedRequest<{ body: typeof IngestExtractionSchema }>,
    res: Response,
  ): Promise<void> => {
    const body = req.validated.body;
    const result = await poReviewService.ingest(
      {
        ...body,
        receivedAt: new Date(body.receivedAt),
        // Decided server-side. The extractor does not get to declare its own
        // output trustworthy — see the service.
        reason: 'awaiting-check',
      },
      callerFrom(req),
    );
    res.status(202).json(result);
  },

  /**
   * I6 — the extractor's callback.
   *
   * ── Why every outcome is a 2xx ────────────────────────────────────────────
   * The vendor retries a callback that did not succeed. Three of the outcomes
   * here are not failures and must not be retried:
   *
   *  • the document is still processing — it will fire again when it finishes
   *  • it failed at the vendor — retrying our end cannot read the PDF
   *  • it is another document type — it will never be ours
   *
   * Answering any of those with a 4xx would put the vendor's retry loop to work
   * on something that will never change. A genuine fault on our side still
   * throws, reaches the error handler as a 5xx, and IS retried — which is
   * exactly the case where a retry helps.
   *
   * 202 rather than 201: nothing was created that anybody can act on yet. An
   * extraction is a proposal until a human confirms it (Risk 9).
   */
  webhook: async (
    req: ValidatedRequest<{ body: typeof ExtractorWebhookSchema }>,
    res: Response,
  ): Promise<void> => {
    const result = await poReviewService.ingestFromExtractor(req.validated.body.extractionId);

    if (!result) {
      res.status(200).json({ ignored: true });
      return;
    }

    res.status(202).json(result);
  },

  confirm: async (
    req: ValidatedRequest<{
      params: typeof ExtractionIdParamsSchema;
      body: typeof PoConfirmationSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    await poReviewService.confirm(req.validated.params.id, req.validated.body, callerFrom(req));
    res.status(204).send();
  },

  reject: async (
    req: ValidatedRequest<{
      params: typeof ExtractionIdParamsSchema;
      body: typeof RejectExtractionSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    await poReviewService.reject(
      req.validated.params.id,
      req.validated.body.note,
      callerFrom(req),
    );
    res.status(204).send();
  },
};
