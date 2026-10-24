import { AppError } from '../../lib/app-error.js';
import { asyncHandler } from '../../lib/async-handler.js';
import { termsCallerFrom } from './terms.controller.js';
import { termsService } from './terms.service.js';

/**
 * The portal paths a customer can use before signing — the signing steps
 * themselves, and the scope the portal needs to know it has to ask.
 */
const OPEN_BEFORE_SIGNING = new Set(['/scope', '/onboarding', '/terms', '/terms/document', '/terms/sign']);

export function isOpenBeforeSigning(path: string): boolean {
  return OPEN_BEFORE_SIGNING.has(path.replace(/\/+$/, '') || '/');
}

/**
 * Matt, 21 Oct — a customer administrator who has to sign does so BEFORE using
 * the portal. The screens redirect them; this is the refusal behind the
 * redirect, so a bookmark or a script cannot step round it.
 */
export const requireSignedTerms = asyncHandler(async (req, _res, next) => {
  if (isOpenBeforeSigning(req.path)) {
    next();
    return;
  }

  if (await termsService.pendingFor(termsCallerFrom(req))) {
    throw AppError.forbidden(
      'Finish setting up your account first — your details, the director’s guarantee and the terms',
    );
  }

  next();
});
