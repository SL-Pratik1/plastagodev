import type { LeadConversionSchema, LeadCreateSchema, LeadUpdateSchema } from '@plastago/shared';
import type { Response } from 'express';
import { AppError } from '../../lib/app-error.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { leadService, type Caller } from './lead.service.js';
import type {
  AttachLeadFileSchema,
  LeadAttachmentParamsSchema,
  LeadIdParamsSchema,
  ListLeadsQuerySchema,
} from './lead.schemas.js';

/** Controller layer — HTTP in, HTTP out. No business rules, no Mongoose. */

function callerFrom(req: { auth?: Express.Request['auth'] }): Caller {
  if (!req.auth) throw AppError.unauthenticated('Sign in to continue');
  return {
    userId: req.auth.userId,
    name: req.auth.name,
    roles: req.auth.roles as Caller['roles'],
  };
}

export const leadController = {
  list: async (
    req: ValidatedRequest<{ query: typeof ListLeadsQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await leadService.list(req.validated.query, callerFrom(req)));
  },

  /** The Won / Conversion cards. Counted across every lead, never per page. */
  stats: async (req: ValidatedRequest<object>, res: Response): Promise<void> => {
    res.json(await leadService.stats(callerFrom(req)));
  },

  get: async (
    req: ValidatedRequest<{ params: typeof LeadIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await leadService.get(req.validated.params.id, callerFrom(req)));
  },

  /**
   * 201 with the FULL lead, not a list item — the caller goes straight to the
   * detail screen to keep working it, and returning the list shape would mean a
   * second round trip to render the page we just navigated to.
   */
  create: async (
    req: ValidatedRequest<{ body: typeof LeadCreateSchema }>,
    res: Response,
  ): Promise<void> => {
    res.status(201).json(await leadService.create(req.validated.body, callerFrom(req)));
  },

  update: async (
    req: ValidatedRequest<{ params: typeof LeadIdParamsSchema; body: typeof LeadUpdateSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(
      await leadService.update(req.validated.params.id, req.validated.body, callerFrom(req)),
    );
  },

  attach: async (
    req: ValidatedRequest<{ params: typeof LeadIdParamsSchema; body: typeof AttachLeadFileSchema }>,
    res: Response,
  ): Promise<void> => {
    res
      .status(201)
      .json(await leadService.attach(req.validated.params.id, req.validated.body, callerFrom(req)));
  },

  detach: async (
    req: ValidatedRequest<{ params: typeof LeadAttachmentParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    await leadService.detach(
      req.validated.params.id,
      req.validated.params.attachmentId,
      callerFrom(req),
    );
    res.status(204).send();
  },

  convert: async (
    req: ValidatedRequest<{
      params: typeof LeadIdParamsSchema;
      body: typeof LeadConversionSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    res
      .status(201)
      .json(
        await leadService.convert(req.validated.params.id, req.validated.body, callerFrom(req)),
      );
  },
};
