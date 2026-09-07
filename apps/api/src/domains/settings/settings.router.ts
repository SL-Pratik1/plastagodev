import {
  CredentialTypeSettingSchema,
  GeneralSettingsSchema,
  InvoicingSettingsSchema,
  NotificationSettingsSchema,
} from '@plastago/shared';
import { Router } from 'express';
import * as z from 'zod';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { settingsController } from './settings.controller.js';
import {
  IntegrationCheckBodySchema,
  IntegrationIdParamsSchema,
  QuoteQuerySchema,
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

settingsRouter.put(
  '/general',
  ADMIN,
  validate({ body: GeneralSettingsSchema }),
  asyncHandler(settingsController.saveGeneral),
);

settingsRouter.put(
  '/notifications',
  ADMIN,
  validate({ body: NotificationSettingsSchema }),
  asyncHandler(settingsController.saveNotifications),
);

settingsRouter.put(
  '/invoicing',
  ADMIN,
  validate({ body: InvoicingSettingsSchema }),
  asyncHandler(settingsController.saveInvoicing),
);

settingsRouter.put(
  '/credential-types',
  ADMIN,
  validate({ body: z.array(CredentialTypeSettingSchema) }),
  asyncHandler(settingsController.saveCredentialTypes),
);

/**
 * POST, not PUT — this records that a check HAPPENED, which is an event rather
 * than a state the caller sets.
 */
settingsRouter.post(
  '/integrations/:id/check',
  ADMIN,
  validate({ params: IntegrationIdParamsSchema, body: IntegrationCheckBodySchema }),
  asyncHandler(settingsController.recordIntegrationCheck),
);
