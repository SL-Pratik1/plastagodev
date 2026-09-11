import {
  AdditionalServiceCreateSchema,
  AdditionalServiceUpdateSchema,
  InvoiceTemplateWriteSchema,
  InvoicingSettingsSchema,
  RateCardCreateSchema,
  RateCardUpdateSchema,
  RateScheduleCreateSchema,
} from '@plastago/shared';
import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { settingsController } from './settings.controller.js';
import {
  InvoiceTemplateIdParamsSchema,
  QuoteQuerySchema,
  RateCardIdParamsSchema,
  ServiceCodeParamsSchema,
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

/* ── Rate cards (M6.1, M6.2) ─────────────────────────────────────────────── */

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
