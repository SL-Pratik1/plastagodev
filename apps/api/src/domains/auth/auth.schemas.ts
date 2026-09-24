import { ObjectIdSchema, RoleSchema } from '@plastago/shared';
import * as z from 'zod';

/**
 * The role a signed-in user is asking to work as.
 *
 * `RoleSchema` only says the value is one of the seven that exist — whether it
 * is one of THEIRS is a rule about a person, not about a string, so the service
 * checks it against `roles` and refuses with a 403. Validating shape here and
 * entitlement there is the split §6A.3 asks for, and it is the difference
 * between a switcher and a role-granting endpoint.
 */
export const ActiveRoleSchema = z
  .object({
    role: RoleSchema,
  })
  .meta({ id: 'ActiveRoleRequest' });

export type ActiveRoleRequest = z.infer<typeof ActiveRoleSchema>;

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
