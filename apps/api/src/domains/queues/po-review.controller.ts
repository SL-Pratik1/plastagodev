import type { PoConfirmationSchema } from '@plastago/shared';
import type { Response } from 'express';
import { AppError } from '../../lib/app-error.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { poReviewService, type Caller } from './po-review.service.js';
import type {
  ExtractionIdParamsSchema,
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
    const result = await poReviewService.ingest({
      ...body,
      receivedAt: new Date(body.receivedAt),
      // Decided server-side. The extractor does not get to declare its own
      // output trustworthy — see the service.
      reason: 'below-threshold',
    });
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
