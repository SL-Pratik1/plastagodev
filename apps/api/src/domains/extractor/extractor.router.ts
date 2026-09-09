import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import { extractorController } from './extractor.controller.js';

/**
 * Router layer — paths and middleware only. No logic.
 *
 * ── Why the whole domain is role-gated at the router ──────────────────────
 * Because there is only one thing to authorise here — "may this person be
 * handed a credential to the extractor tenant" — and the answer does not vary
 * by route. Per-route gates would be four copies of one decision.
 *
 * The gate is the admin surface's four staff roles. Customers and drivers are
 * excluded by omission rather than by a check: the extractor holds every
 * builder's purchase orders at once, which is not a document set that belongs
 * on a customer's screen or a driver's phone.
 *
 * ⚠️ The Settings tab inside the iframe can rotate embed tokens and change the
 * mailbox connection, and the vendor's UI decides what a `member` may do there
 * — not this router. Every PlastaGo user is provisioned as `member` for exactly
 * that reason; see `addToTenant`.
 */
export const extractorRouter = Router();

extractorRouter.use(requireAuth);
extractorRouter.use(requireRole('super-admin', 'operations', 'office-staff', 'allocator'));

extractorRouter.post('/session', asyncHandler(extractorController.session));

extractorRouter.delete('/session', asyncHandler(extractorController.forget));
