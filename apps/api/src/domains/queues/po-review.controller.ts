import type { PoConfirmationSchema } from '@plastago/shared';
import type { Response } from 'express';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { poReviewService, type Caller } from './po-review.service.js';
import type {
  ExtractionIdParamsSchema,
  ExtractorWebhookSchema,
  IngestExtractionSchema,
  ListExtractionsQuerySchema,
  RejectExtractionSchema,
} from './po-review.schemas.js';

const log = logger.child({ module: 'po-review-webhook' });

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
   * ── Why this acknowledges BEFORE it does the work ─────────────────────────
   * Ingesting one extraction takes ten seconds or more on a good day: a session
   * mint, a fetch from the vendor, a download of the original PDF, a copy into
   * our own storage, then the account and suburb lookups. Measured, not
   * estimated — and that is before a slow network puts its thumb on any of it.
   *
   * Webhook senders do not wait that long. This one gave up before we replied,
   * so extractions completed at the vendor and never arrived here at all: the
   * office saw an empty queue and no error anywhere to explain it. The work was
   * always finishing; nobody was left listening for the answer.
   *
   * So the acknowledgement goes first and the work runs after it. The reply is
   * "understood", not "done" — which is all a 202 ever claimed.
   *
   * ── What that costs, and why it is still the right trade ──────────────────
   * The vendor's retry-on-5xx is gone: once we have answered 202 there is no
   * status left to fail with, so a genuine fault on our side is now ours alone
   * to notice. That is why the failure branch logs loudly with the extraction id
   * — it is the only trace, and it is what a re-drive is run from.
   *
   * Worth it, because the retry was protecting against the rarer problem. A
   * timeout meant EVERY extraction was lost; a fault after acknowledgement loses
   * one, leaves a log line naming it, and `ingestFromExtractor` is idempotent —
   * so re-driving that id is safe and creates no duplicate.
   *
   * ⚠️ The response is sent BEFORE the returned promise settles, and the promise
   * is returned rather than floated only so `asyncHandler` still has something to
   * hold — every controller here is wrapped, without exception, so that nobody
   * has to remember which ones are safe.
   *
   * The `catch` is load-bearing either way. A rejection that reached
   * `asyncHandler` would be forwarded to `next` after the headers were already
   * flushed, which Express can do nothing useful with; and a rejection nobody
   * caught at all is an unhandled rejection Node may end the process over.
   */
  webhook: (
    req: ValidatedRequest<{ body: typeof ExtractorWebhookSchema }>,
    res: Response,
  ): Promise<void> => {
    const { extractionId } = req.validated.body;

    res.status(202).json({ accepted: true });

    return poReviewService
      .ingestFromExtractor(extractionId)
      .then((result) => {
        if (!result) {
          // Still processing, failed at the vendor, or another document type —
          // all three are normal and none of them is ours to act on.
          log.info({ extractionId }, 'extractor callback ignored');
          return;
        }

        log.info({ extractionId, id: result.id }, 'extractor callback ingested');
      })
      .catch((error: unknown) => {
        /*
         * The only record that this arrived and did not land. Logged with the
         * vendor's id rather than ours, because ours was never created — that
         * id is what a re-drive needs.
         */
        log.error(
          { extractionId, error: error instanceof Error ? error.message : String(error) },
          'extractor callback failed after it was acknowledged',
        );
      });
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
