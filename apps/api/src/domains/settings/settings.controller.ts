import type {
  AdditionalServiceCreateSchema,
  InvoiceTemplateWriteSchema,
  AdditionalServiceUpdateSchema,
  InvoicingSettingsSchema,
  LogoUploadRequestSchema,
  RateCardCreateSchema,
  RateCardUpdateSchema,
  RateScheduleCreateSchema,
  ZoneCreateSchema,
  ZoneOrderSchema,
  ZoneUpdateSchema,
} from '@plastago/shared';
import type { Response } from 'express';
import { AppError } from '../../lib/app-error.js';
import type { Request } from 'express';
import { todayInSydney } from '../../lib/business-day.js';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { pricingService } from './pricing.service.js';
import type {
  InvoiceTemplateIdParamsSchema,
  LogoConfirmSchema,
  QuoteQuerySchema,
  RateCardIdParamsSchema,
  ScheduleParamsSchema,
  ServiceCodeParamsSchema,
  ZoneIdParamsSchema,
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

  saveInvoicing: async (
    req: ValidatedRequest<{ body: typeof InvoicingSettingsSchema }>,
    res: Response,
  ): Promise<void> => {
    const saved = await settingsService.saveInvoicing(req.validated.body, callerOf(req));
    res.json(saved);
  },

  /* ── The invoice logo (M7.5) ─────────────────────────────────────────── */

  presignLogo: async (
    req: ValidatedRequest<{ body: typeof LogoUploadRequestSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await settingsService.presignLogo(req.validated.body, callerOf(req)));
  },

  /** 200 with the link to the logo now in force. */
  confirmLogo: async (
    req: ValidatedRequest<{ body: typeof LogoConfirmSchema }>,
    res: Response,
  ): Promise<void> => {
    const logoUrl = await settingsService.confirmLogo(req.validated.body.key, callerOf(req));
    res.json({ logoUrl });
  },

  removeLogo: async (req: Request, res: Response): Promise<void> => {
    await settingsService.removeLogo(callerOf(req));
    res.status(204).send();
  },

  /* ── The certificate signature (M9.5) ─────────────────────────────────── */

  presignCertificateSignature: async (
    req: ValidatedRequest<{ body: typeof LogoUploadRequestSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await settingsService.presignCertificateSignature(req.validated.body, callerOf(req)));
  },

  /** 200 with the link to the signature now in force. */
  confirmCertificateSignature: async (
    req: ValidatedRequest<{ body: typeof LogoConfirmSchema }>,
    res: Response,
  ): Promise<void> => {
    const certificateSignatureUrl = await settingsService.confirmCertificateSignature(
      req.validated.body.key,
      callerOf(req),
    );
    res.json({ certificateSignatureUrl });
  },

  removeCertificateSignature: async (req: Request, res: Response): Promise<void> => {
    await settingsService.removeCertificateSignature(callerOf(req));
    res.status(204).send();
  },

  /** M7.5 — a rendered sample, so a template is never chosen blind. */
  previewTemplate: async (
    req: ValidatedRequest<{ params: typeof InvoiceTemplateIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await settingsService.previewTemplate(req.validated.params.id, callerOf(req)));
  },

  /** M6.2 — undo a schedule issued with the wrong start date. */
  deleteSchedule: async (
    req: ValidatedRequest<{ params: typeof ScheduleParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    const { id, effectiveFrom } = req.validated.params;
    res.json(await settingsService.deleteSchedule(id, effectiveFrom, callerOf(req)));
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
    const { rateCardId, zoneId, expectedAreaM2, bagCount, onDate } = req.validated.query;

    const preview = await pricingService.quote({
      rateCardId,
      zoneId,
      expectedAreaM2: expectedAreaM2 ?? null,
      bagCount: bagCount ?? 0,
      /*
       * ⚠️ Today's date in SYDNEY, not `new Date()` sliced to ten characters.
       * A preview asked for at 9am on the 1st would otherwise price on the
       * 30th, which is the wrong schedule on exactly the days a rate changes.
       *
       * The default lives here rather than in `pricingService` on purpose:
       * this endpoint answers a question asked with no job attached, and every
       * domain caller must state the date it means.
       */
      onDate: onDate ?? todayInSydney(),
    });

    res.json(preview);
  },

  /* ── Invoice templates (M7.5) ──────────────────────────────────────────── */

  createInvoiceTemplate: async (
    req: ValidatedRequest<{ body: typeof InvoiceTemplateWriteSchema }>,
    res: Response,
  ): Promise<void> => {
    const created = await settingsService.createInvoiceTemplate(req.validated.body, callerOf(req));
    // 201 with the stored template: the id is derived from the name, so the
    // caller cannot know it without being told.
    res.status(201).json(created);
  },

  updateInvoiceTemplate: async (
    req: ValidatedRequest<{
      params: typeof InvoiceTemplateIdParamsSchema;
      body: typeof InvoiceTemplateWriteSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    const updated = await settingsService.updateInvoiceTemplate(
      req.validated.params.id,
      req.validated.body,
      callerOf(req),
    );
    res.json(updated);
  },

  deleteInvoiceTemplate: async (
    req: ValidatedRequest<{ params: typeof InvoiceTemplateIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    await settingsService.deleteInvoiceTemplate(req.validated.params.id, callerOf(req));
    res.status(204).end();
  },

  /* ── Rate cards (M6.1, M6.2) ───────────────────────────────────────────── */

  /* ── Zones (M6.3) ──────────────────────────────────────────────────────── */

  createZone: async (
    req: ValidatedRequest<{ body: typeof ZoneCreateSchema }>,
    res: Response,
  ): Promise<void> => {
    const zone = await settingsService.createZone(req.validated.body, callerOf(req));
    res.status(201).json(zone);
  },

  renameZone: async (
    req: ValidatedRequest<{ params: typeof ZoneIdParamsSchema; body: typeof ZoneUpdateSchema }>,
    res: Response,
  ): Promise<void> => {
    const zone = await settingsService.renameZone(
      req.validated.params.id,
      req.validated.body,
      callerOf(req),
    );
    res.json(zone);
  },

  reorderZones: async (
    req: ValidatedRequest<{ body: typeof ZoneOrderSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await settingsService.reorderZones(req.validated.body, callerOf(req)));
  },

  /**
   * ⚠️ 200 with the RETIRED zone, not 204.
   *
   * A zone is archived rather than removed, so the response carries what
   * actually happened — the screen shows a retired row it can restore, instead
   * of assuming a delete it never performed.
   */
  archiveZone: async (
    req: ValidatedRequest<{ params: typeof ZoneIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await settingsService.archiveZone(req.validated.params.id, callerOf(req)));
  },

  restoreZone: async (
    req: ValidatedRequest<{ params: typeof ZoneIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    res.json(await settingsService.restoreZone(req.validated.params.id, callerOf(req)));
  },

  createRateCard: async (
    req: ValidatedRequest<{ body: typeof RateCardCreateSchema }>,
    res: Response,
  ): Promise<void> => {
    const created = await settingsService.createRateCard(req.validated.body, callerOf(req));
    // 201 with the stored card: the id may have been derived from the label, so
    // the caller cannot know it without being told.
    res.status(201).json(created);
  },

  renameRateCard: async (
    req: ValidatedRequest<{
      params: typeof RateCardIdParamsSchema;
      body: typeof RateCardUpdateSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    const updated = await settingsService.renameRateCard(
      req.validated.params.id,
      req.validated.body,
      callerOf(req),
    );
    res.json(updated);
  },

  /**
   * POST, not PUT — issuing a schedule ADDS a dated version rather than
   * replacing the rates at a location. There is deliberately no route that
   * edits a schedule's figures in place (M6.2).
   */
  issueSchedule: async (
    req: ValidatedRequest<{
      params: typeof RateCardIdParamsSchema;
      body: typeof RateScheduleCreateSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    const updated = await settingsService.issueSchedule(
      req.validated.params.id,
      req.validated.body,
      callerOf(req),
    );
    res.status(201).json(updated);
  },

  deleteRateCard: async (
    req: ValidatedRequest<{ params: typeof RateCardIdParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    await settingsService.deleteRateCard(req.validated.params.id, callerOf(req));
    res.status(204).end();
  },

  /* ── Additional services (M6.5) ────────────────────────────────────────── */

  createAdditionalService: async (
    req: ValidatedRequest<{ body: typeof AdditionalServiceCreateSchema }>,
    res: Response,
  ): Promise<void> => {
    const created = await settingsService.createAdditionalService(
      req.validated.body,
      callerOf(req),
    );
    res.status(201).json(created);
  },

  updateAdditionalService: async (
    req: ValidatedRequest<{
      params: typeof ServiceCodeParamsSchema;
      body: typeof AdditionalServiceUpdateSchema;
    }>,
    res: Response,
  ): Promise<void> => {
    const updated = await settingsService.updateAdditionalService(
      req.validated.params.code,
      req.validated.body,
      callerOf(req),
    );
    res.json(updated);
  },

  deleteAdditionalService: async (
    req: ValidatedRequest<{ params: typeof ServiceCodeParamsSchema }>,
    res: Response,
  ): Promise<void> => {
    await settingsService.deleteAdditionalService(req.validated.params.code, callerOf(req));
    res.status(204).end();
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
