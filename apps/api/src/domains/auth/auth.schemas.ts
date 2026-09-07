import { ObjectIdSchema } from '@plastago/shared';
import * as z from 'zod';

/**
 * The resend request body.
 *
 * ⚠️ THE ONE SCHEMA IN THIS DOMAIN THAT IS NOT IN `@plastago/shared`, and it is
 * here under protest.
 *
 * `identity.ts` defines `OtpRequestSchema` and `OtpVerifySchema` but no resend
 * body — the frontend's `AuthService.resendCode(challengeId)` takes a bare
 * string, so no wire shape was ever needed for it. The contract is frozen and
 * `schemas/` is being edited by another workstream, so adding it there was not
 * mine to do.
 *
 * The VALUE is still contract-governed: `ObjectIdSchema` comes from shared, so
 * the thing being validated cannot drift. Only the one-key envelope lives here.
 *
 * → When the contract next opens, move this to `schemas/identity.ts` as
 *   `OtpResendSchema` and delete this file. `openapi/document.ts` declares the
 *   same one-key object inline for the same reason and should be updated with it.
 */
export const OtpResendSchema = z
  .object({
    challengeId: ObjectIdSchema,
  })
  .meta({ id: 'OtpResend' });

export type OtpResend = z.infer<typeof OtpResendSchema>;
