import {
  AdditionalServiceCreateSchema,
  AdditionalServiceUpdateSchema,
  InvoiceTemplateWriteSchema,
  InvoicingSettingsSchema,
  LogoUploadRequestSchema,
  RateCardCreateSchema,
  RateCardUpdateSchema,
  RateScheduleCreateSchema,
  ZoneCreateSchema,
  ZoneOrderSchema,
  ZoneUpdateSchema,
} from '@plastago/shared';
import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { settingsController } from './settings.controller.js';
import {
  InvoiceTemplateIdParamsSchema,
  LogoConfirmSchema,
  QuoteQuerySchema,
  RateCardIdParamsSchema,
  ScheduleParamsSchema,
  ServiceCodeParamsSchema,
  ZoneIdParamsSchema,
} from './settings.schemas.js';

/**
 * Router layer — paths and middleware only. No logic.
 *
 * ── Why writes are gated twice ────────────────────────────────────────────
 * `requireRole` below is a coarse gate a browser cannot be trusted to apply,
 * and the service refuses independently. That duplication is deliberate: only
 * the service's refusal is a boundary, but the route gate means a mistake in
 * one is not a hole in both.
 */
export const settingsRouter = Router();

settingsRouter.use(requireAuth);

/**
 * Reading is open to any signed-in staff member.
 *
 * The SLA and the rate cards are on screen while the office books a job, so
 * making this admin-only would just mean office staff could not see the rules
 * they are working to. Customers are refused in the service.
 */
settingsRouter.get('/', asyncHandler(settingsController.get));

/**
 * A price preview, before there is a job to attach it to (M6).
 *
 * Deliberately reachable by every signed-in role including a customer
 * administrator — the portal quote is the same computation, and a customer
 * seeing their own agreed rates is the point of it.
 */
settingsRouter.get(
  '/quote',
  validate({ query: QuoteQuerySchema }),
  asyncHandler(settingsController.quote),
);

/* ── Writes: administrators only ─────────────────────────────────────────── */

const ADMIN = requireRole('super-admin', 'operations');

/*
 * There is no `PUT /general`. The SLA is the only value that route ever wrote,
 * and it no longer has a screen — see the note in `@plastago/shared`'s settings
 * schema. It is a seed-time value now.
 */

/*
 * There is no `PUT /notifications`, no `PUT /credential-types` and no
 * `POST /integrations/:id/check` either. All three wrote settings nothing
 * downstream read — see the note in `@plastago/shared`'s settings schema.
 *
 * ⚠️ Unrelated: `/notifications` on the API root is the notification CENTRE and
 * is very much alive. Only the settings-level rules block is gone.
 */

settingsRouter.put(
  '/invoicing',
  ADMIN,
  validate({ body: InvoicingSettingsSchema }),
  asyncHandler(settingsController.saveInvoicing),
);

/* ── The invoice logo (M7.5) ─────────────────────────────────────────────── */

/*
 * Two steps on purpose: the browser asks for somewhere to PUT the bytes, then
 * confirms once they have landed. The logo the invoices print only changes on
 * the second call, so an upload that is abandoned halfway leaves the previous
 * one exactly where it was.
 */
settingsRouter.post(
  '/invoicing/logo',
  ADMIN,
  validate({ body: LogoUploadRequestSchema }),
  asyncHandler(settingsController.presignLogo),
);

settingsRouter.put(
  '/invoicing/logo',
  ADMIN,
  validate({ body: LogoConfirmSchema }),
  asyncHandler(settingsController.confirmLogo),
);

settingsRouter.delete('/invoicing/logo', ADMIN, asyncHandler(settingsController.removeLogo));

/* ── The certificate signature (M9.5 · F52) ──────────────────────────────── */

/* The same two steps as the logo above, and for the same reason. */
settingsRouter.post(
  '/invoicing/certificate-signature',
  ADMIN,
  validate({ body: LogoUploadRequestSchema }),
  asyncHandler(settingsController.presignCertificateSignature),
);

settingsRouter.put(
  '/invoicing/certificate-signature',
  ADMIN,
  validate({ body: LogoConfirmSchema }),
  asyncHandler(settingsController.confirmCertificateSignature),
);

settingsRouter.delete(
  '/invoicing/certificate-signature',
  ADMIN,
  asyncHandler(settingsController.removeCertificateSignature),
);

/* ── Invoice templates (M7.5) ────────────────────────────────────────────── */

settingsRouter.post(
  '/invoice-templates',
  ADMIN,
  validate({ body: InvoiceTemplateWriteSchema }),
  asyncHandler(settingsController.createInvoiceTemplate),
);

settingsRouter.put(
  '/invoice-templates/:id',
  ADMIN,
  validate({ params: InvoiceTemplateIdParamsSchema, body: InvoiceTemplateWriteSchema }),
  asyncHandler(settingsController.updateInvoiceTemplate),
);

settingsRouter.delete(
  '/invoice-templates/:id',
  ADMIN,
  validate({ params: InvoiceTemplateIdParamsSchema }),
  asyncHandler(settingsController.deleteInvoiceTemplate),
);

/**
 * A rendered sample of one template.
 *
 * POST rather than GET because it PRODUCES an object — it draws a PDF and puts
 * it in storage. Calling it twice leaves two previews, which is why it is not
 * something a browser may retry or prefetch on its own.
 */
settingsRouter.post(
  '/invoice-templates/:id/preview',
  ADMIN,
  validate({ params: InvoiceTemplateIdParamsSchema }),
  asyncHandler(settingsController.previewTemplate),
);

/* ── Rate cards (M6.1, M6.2) ─────────────────────────────────────────────── */

/* ── Zones (M6.3) ─────────────────────────────────────────────────────────── */

/**
 * ⚠️ Stricter than every other write on this router.
 *
 * `ADMIN` above admits operations, because repricing a card or renaming a
 * template is day-to-day office work. A zone is not: adding one writes a rate
 * row on every card for every schedule they have ever had, and retiring one
 * decides where the business goes. The service refuses independently — same
 * double-gate as the rest of this file, at a tighter setting.
 */
const ZONE_ADMIN = requireRole('super-admin');

settingsRouter.post(
  '/zones',
  ZONE_ADMIN,
  validate({ body: ZoneCreateSchema }),
  asyncHandler(settingsController.createZone),
);

/**
 * ⚠️ Declared BEFORE anything matching `/zones/:id`.
 *
 * Express matches in declaration order, and while a PUT does not collide with
 * the PATCH and DELETE below today, putting the literal path first is the habit
 * that survives somebody adding `PUT /zones/:id` later.
 */
settingsRouter.put(
  '/zones/order',
  ZONE_ADMIN,
  validate({ body: ZoneOrderSchema }),
  asyncHandler(settingsController.reorderZones),
);

/** Renames the label. The id and slug are deliberately not reachable. */
settingsRouter.patch(
  '/zones/:id',
  ZONE_ADMIN,
  validate({ params: ZoneIdParamsSchema, body: ZoneUpdateSchema }),
  asyncHandler(settingsController.renameZone),
);

settingsRouter.post(
  '/zones/:id/restore',
  ZONE_ADMIN,
  validate({ params: ZoneIdParamsSchema }),
  asyncHandler(settingsController.restoreZone),
);

/** ⚠️ RETIRES the zone. It is never removed — see `zoneSchema.archived`. */
settingsRouter.delete(
  '/zones/:id',
  ZONE_ADMIN,
  validate({ params: ZoneIdParamsSchema }),
  asyncHandler(settingsController.archiveZone),
);

settingsRouter.post(
  '/rate-cards',
  ADMIN,
  validate({ body: RateCardCreateSchema }),
  asyncHandler(settingsController.createRateCard),
);

settingsRouter.patch(
  '/rate-cards/:id',
  ADMIN,
  validate({ params: RateCardIdParamsSchema, body: RateCardUpdateSchema }),
  asyncHandler(settingsController.renameRateCard),
);

/**
 * ⚠️ Issuing a schedule is a POST to a sub-collection, and there is
 * deliberately NO `PUT /rate-cards/:id/zones`.
 *
 * A PUT would say "these are the card's rates", which is the mental model that
 * reprices history: a job is priced by the rates in force on ITS date, so
 * changing a rate has to ADD a dated version rather than overwrite a location.
 * Making the safe operation the only representable one is stronger than
 * validating against the unsafe one.
 */
settingsRouter.post(
  '/rate-cards/:id/schedules',
  ADMIN,
  validate({ params: RateCardIdParamsSchema, body: RateScheduleCreateSchema }),
  asyncHandler(settingsController.issueSchedule),
);

/**
 * ⚠️ Undo for a schedule issued with the wrong date — and nothing more.
 *
 * The service admits only a schedule that has NOT started yet, and never a
 * card's last one. That is what keeps this from becoming the "edit a rate"
 * operation the POST above deliberately refuses to be: a schedule that has
 * priced work cannot be removed, so nothing already invoiced can move.
 */
settingsRouter.delete(
  '/rate-cards/:id/schedules/:effectiveFrom',
  ADMIN,
  validate({ params: ScheduleParamsSchema }),
  asyncHandler(settingsController.deleteSchedule),
);

settingsRouter.delete(
  '/rate-cards/:id',
  ADMIN,
  validate({ params: RateCardIdParamsSchema }),
  asyncHandler(settingsController.deleteRateCard),
);

/* ── Additional services (M6.5) ──────────────────────────────────────────── */

settingsRouter.post(
  '/additional-services',
  ADMIN,
  validate({ body: AdditionalServiceCreateSchema }),
  asyncHandler(settingsController.createAdditionalService),
);

settingsRouter.patch(
  '/additional-services/:code',
  ADMIN,
  validate({ params: ServiceCodeParamsSchema, body: AdditionalServiceUpdateSchema }),
  asyncHandler(settingsController.updateAdditionalService),
);

settingsRouter.delete(
  '/additional-services/:code',
  ADMIN,
  validate({ params: ServiceCodeParamsSchema }),
  asyncHandler(settingsController.deleteAdditionalService),
);
