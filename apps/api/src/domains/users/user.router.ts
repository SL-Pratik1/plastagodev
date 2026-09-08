import { UserDraftSchema } from '@plastago/shared';
import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { userController } from './user.controller.js';
import {
  ListUsersQuerySchema,
  SetUserStatusSchema,
  UserIdParamsSchema,
} from './user.schemas.js';

/**
 * Router layer — paths and middleware only. No logic.
 *
 * ── Why the whole router is gated ─────────────────────────────────────────
 * Every route here reads or writes who can get into the system. There is no
 * scoped view of that for anybody else: a driver has no business knowing the
 * office roster, and a customer administrator manages their supervisors through
 * the portal, against their own account.
 *
 * The finer rule — only a super-admin may GRANT super-admin — lives in the
 * service, next to the reasoning, because it is about the payload rather than
 * the route.
 */
export const userRouter = Router();

userRouter.use(requireAuth);
userRouter.use(requireRole('super-admin', 'operations'));

userRouter.get(
  '/',
  validate({ query: ListUsersQuerySchema }),
  asyncHandler(userController.list),
);

userRouter.get(
  '/:id',
  validate({ params: UserIdParamsSchema }),
  asyncHandler(userController.get),
);

userRouter.post('/', validate({ body: UserDraftSchema }), asyncHandler(userController.create));

userRouter.patch(
  '/:id',
  validate({ params: UserIdParamsSchema, body: UserDraftSchema }),
  asyncHandler(userController.update),
);

/**
 * Activate, suspend or re-invite.
 *
 * ⚠️ Never a delete. Their name is frozen onto every job they booked and every
 * charge they approved — removing the row would make that unattributable rather
 * than removing it.
 */
userRouter.post(
  '/:id/status',
  validate({ params: UserIdParamsSchema, body: SetUserStatusSchema }),
  asyncHandler(userController.setStatus),
);

userRouter.post(
  '/:id/resend-invite',
  validate({ params: UserIdParamsSchema }),
  asyncHandler(userController.resendInvite),
);
