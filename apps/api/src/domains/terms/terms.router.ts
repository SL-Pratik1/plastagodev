import { TermsConfirmSchema, TermsUploadRequestSchema } from '@plastago/shared';
import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { termsController } from './terms.controller.js';
import { TermsAccountParamsSchema, TermsVersionParamsSchema } from './terms.schemas.js';

/**
 * Router layer — the office's side of the terms (Matt, 21 Oct). The portal's
 * side lives on the portal router, beside the gate it lifts.
 *
 * Who may upload is decided again in the service; the role gate here is only
 * the door.
 */
export const termsRouter = Router();

termsRouter.use(requireAuth);
termsRouter.use(requireRole('super-admin', 'operations', 'office-staff'));

termsRouter.get('/', asyncHandler(termsController.library));

/* Two steps, like the invoice logo: ask, PUT the bytes, confirm. */
termsRouter.post(
  '/upload',
  validate({ body: TermsUploadRequestSchema }),
  asyncHandler(termsController.presignUpload),
);

termsRouter.put('/', validate({ body: TermsConfirmSchema }), asyncHandler(termsController.confirmUpload));

termsRouter.get(
  '/versions/:version/url',
  validate({ params: TermsVersionParamsSchema }),
  asyncHandler(termsController.documentUrl),
);

/** What a customer signed: the terms with the signing page appended. */
termsRouter.get(
  '/signed/:accountId/url',
  validate({ params: TermsAccountParamsSchema }),
  asyncHandler(termsController.signedCopyUrl),
);
