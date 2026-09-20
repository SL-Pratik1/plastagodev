import { JobChargeDraftSchema, JobCommentDraftSchema, JobDraftSchema } from '@plastago/shared';
import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { jobController } from './job.controller.js';
import {
  CancelJobBodySchema,
  JobIdParamsSchema,
  ListJobsQuerySchema,
  PurchaseOrderOptionsQuerySchema,
  RescheduleJobBodySchema,
} from './job.schemas.js';

/**
 * Router layer — paths and middleware only. No logic.
 *
 * ── Two layers of access control, doing different jobs ────────────────────
 * `requireRole` answers "may this KIND of user reach this endpoint at all" — a
 * coarse gate a browser cannot be trusted to apply. It does NOT decide which
 * rows come back: a site supervisor legitimately reaches `GET /` and must see
 * only the jobs they raised. That narrowing happens in the repository
 * (§6A.3 #5), because a filter applied here is one somebody can forget.
 */
export const jobRouter = Router();

// Every route below is authenticated. Mounted once rather than per-route so a
// new endpoint cannot be added unprotected by omission.
jobRouter.use(requireAuth);

/**
 * The coarse gate the note above describes. It was documented but never
 * applied — `requireRole` was not so much as imported here.
 *
 * This is the OFFICE's view of a job. The other two surfaces have their own,
 * and both are narrower on purpose:
 *
 * ⚠️ The DRIVER never belonged here. Nothing narrows a driver in the
 * repository, so `GET /jobs` handed them every job on the system and
 * `GET /jobs/:id` handed them any one in full — the customer's charge lines and
 * totals, the site contact's mobile, and the INTERNAL comment thread the office
 * keeps about the job. Their own work comes from `/driver/*`, which returns
 * their run and nothing else.
 *
 * ⚠️ CUSTOMER roles do not belong here either, and this is the fix for a real
 * leak rather than tidying. M1.5 is explicit that a site supervisor "cannot see
 * pricing"; `/portal/*` honours that exactly — it nulls `totalIncGst` for a
 * supervisor and returns it for an administrator — while this router handed a
 * supervisor `totalExGst`, `gst` and the charge lines in full. The portal is
 * their whole surface: `portal.http.ts` calls nothing but `/portal/*`, and
 * booking reaches `jobService.create` through the portal service, so no
 * customer flow loses anything.
 */
jobRouter.use(requireRole('super-admin', 'operations', 'office-staff', 'allocator'));

jobRouter.get('/', validate({ query: ListJobsQuerySchema }), asyncHandler(jobController.list));

/**
 * Booking is open to customer roles as well as the office — that is the portal
 * (M5). A site supervisor raising a pickup is the flow Matt asked for at 18:15.
 * The service still resolves the account through the caller's own scope, so a
 * customer cannot book against somebody else's account.
 */
jobRouter.post('/', validate({ body: JobDraftSchema }), asyncHandler(jobController.create));

jobRouter.post('/preview', validate({ body: JobDraftSchema }), asyncHandler(jobController.preview));

/**
 * M2.12 — the purchase orders a pickup can be booked against.
 *
 * Mounted BEFORE `/:id`, or Express matches "purchase-orders" as a job id and
 * answers 422 on an invalid ObjectId.
 */
jobRouter.get(
  '/purchase-orders',
  validate({ query: PurchaseOrderOptionsQuerySchema }),
  asyncHandler(jobController.purchaseOrders),
);

jobRouter.get('/:id', validate({ params: JobIdParamsSchema }), asyncHandler(jobController.get));

/**
 * Cancelling and rescheduling are not office-only: a customer administrator
 * manages their own bookings in the portal. A site supervisor is refused in the
 * service — they raise pickups, and cancelling one their site is waiting on is
 * a decision for whoever runs the account.
 */
jobRouter.post(
  '/:id/cancel',
  validate({ params: JobIdParamsSchema, body: CancelJobBodySchema }),
  asyncHandler(jobController.cancel),
);

jobRouter.post(
  '/:id/reschedule',
  validate({ params: JobIdParamsSchema, body: RescheduleJobBodySchema }),
  asyncHandler(jobController.reschedule),
);

jobRouter.post(
  '/:id/comments',
  validate({ params: JobIdParamsSchema, body: JobCommentDraftSchema }),
  asyncHandler(jobController.addComment),
);

/**
 * M6.5 — the office applies a configured extra to a job.
 *
 * Office-only, and refused in the service rather than here: a customer
 * administrator can legitimately reach the other three routes above for their
 * own jobs, so the guard is about the ACT, not the route.
 */
jobRouter.post(
  '/:id/charges',
  validate({ params: JobIdParamsSchema, body: JobChargeDraftSchema }),
  asyncHandler(jobController.addCharge),
);
