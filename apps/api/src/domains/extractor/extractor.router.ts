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
 * The gate is the Administrator alone. Everybody else — staff, customers and
 * drivers alike — is excluded by omission rather than by a check: the extractor
 * holds every builder's purchase orders at once, which is not a document set
 * that belongs on a customer's screen or a driver's phone.
 *
 * ⚠️ The reason the other three staff roles are NOT here, having been here
 * once: the Settings tab inside the iframe can rotate embed tokens and change
 * the mailbox connection, and the vendor's UI decides what its own roles may do
 * there — not this router. Everyone who gets through here is provisioned at the
 * vendor as `admin` (see `addMember`), which is what makes that tab usable at
 * all, so this router cannot narrow what the frame offers once it is open.
 * Where the blast radius cannot be trimmed, the door is — and widening this
 * gate now hands the mailbox connection to whoever is let in.
 *
 * ⚠️ This is NOT the purchase-order review queue. Confirming an extraction into
 * a real purchase order is `queues:action` in `po-review.service.ts`, and the
 * office keeps it — the daily intake work is untouched by this gate.
 */
export const extractorRouter = Router();

extractorRouter.use(requireAuth);
extractorRouter.use(requireRole('super-admin'));

extractorRouter.post('/session', asyncHandler(extractorController.session));

extractorRouter.delete('/session', asyncHandler(extractorController.forget));
