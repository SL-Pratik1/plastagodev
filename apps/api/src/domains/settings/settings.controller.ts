import type {
  CredentialTypeSettingSchema,
  InvoicingSettingsSchema,
  NotificationSettingsSchema,
} from '@plastago/shared';
import type { Response } from 'express';
import type * as z from 'zod';
import { AppError } from '../../lib/app-error.js';
import type { Request } from 'express';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { pricingService } from './pricing.service.js';
import type {
  IntegrationCheckBodySchema,
  IntegrationIdParamsSchema,
  QuoteQuerySchema,
} from './settings.schemas.js';
import { settingsService, type Caller } from './settings.service.js';

/**
 * Controller layer — HTTP in, HTTP out. No business rules, no Mongoose.
 *
 * Handlers are arrow-function properties, not methods: Express receives them as
 * bare references, so a `this`-bound method would silently lose its receiver.
 */
export const settingsController = {
  get: async (req: Request, res: Response): Promise<void> => {
    const settings = await settingsService.get(callerOf(req));
    res.json(settings);
  },

  saveNotifications: async (
    req: ValidatedRequest<{ body: typeof NotificationSettingsSchema }>,
    res: Response,
  ): Promise<void> => {
    const saved = await settingsService.saveNotifications(req.validated.body, callerOf(req));
    res.json(saved);
  },

  saveInvoicing: async (
    req: ValidatedRequest<{ body: typeof InvoicingSettingsSchema }>,
    res: Response,
  ): Promise<void> => {
    const saved = await settingsService.saveInvoicing(req.validated.body, callerOf(req));
    res.json(saved);
  },

  saveCredentialTypes: async (
    req: ValidatedRequest<{ body: z.ZodArray<typeof CredentialTypeSettingSchema> }>,
    res: Response,
  ): Promise<void> => {
    const saved = await settingsService.saveCredentialTypes(req.validated.body, callerOf(req));
    res.json(saved);
  },

  recordIntegrationCheck: async (
    req: ValidatedRequest<{
      params: typeof IntegrationIdParamsSchema;
      body: typeof IntegrationCheckBodySchema;
    }>,
    res: Response,
  ): Promise<void> => {
    const updated = await settingsService.recordIntegrationCheck(
      req.validated.params.id,
      req.validated.body,
      callerOf(req),
    );
    res.json(updated);
  },

  /**
   * A price preview (M6).
   *
   * GET rather than POST: it computes nothing and stores nothing, so it should
   * be cacheable and safe to retry. The office's form re-asks on every keystroke
   * that changes the area.
   */
  quote: async (
    req: ValidatedRequest<{ query: typeof QuoteQuerySchema }>,
    res: Response,
  ): Promise<void> => {
    const { rateCardId, zone, expectedAreaM2, bagCount } = req.validated.query;

    const preview = await pricingService.quote({
      rateCardId,
      zone,
      expectedAreaM2: expectedAreaM2 ?? null,
      bagCount: bagCount ?? 0,
    });

    res.json(preview);
  },
};

/**
 * The caller, from the session the auth middleware already resolved.
 *
 * Throws rather than defaulting if `req.auth` is missing — that means the route
 * was mounted without `requireAuth`, which is a routing bug and must fail
 * loudly rather than quietly running unscoped.
 */
function callerOf(req: Request): Caller {
  if (!req.auth) throw AppError.unauthenticated('Sign in to continue');
  return { roles: req.auth.roles as Caller['roles'], accountId: req.auth.accountId };
}
