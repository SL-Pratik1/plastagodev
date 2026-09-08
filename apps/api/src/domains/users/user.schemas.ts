import { BrandIdSchema, ObjectIdSchema, RoleSchema, UserStatusSchema } from '@plastago/shared';
import * as z from 'zod';

/**
 * Request shapes that belong to the transport rather than the domain.
 *
 * `UserDraft` lives in `@plastago/shared` — the console and the contract must
 * agree on what a user IS. What is here is how one is asked for over HTTP.
 */

export const UserIdParamsSchema = z.object({ id: ObjectIdSchema }).meta({ id: 'UserIdParams' });

export const ListUsersQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    sort: z.string().trim().max(40).optional(),
    q: z.string().trim().max(120).optional(),
    /** The MAIN role, not the array — see the note in the repository. */
    role: RoleSchema.optional(),
    status: UserStatusSchema.optional(),
    brandId: BrandIdSchema.optional(),
    account: ObjectIdSchema.optional(),
  })
  .meta({ id: 'ListUsersQuery' });

/**
 * Activate, suspend or re-invite.
 *
 * Deliberately its own request rather than a field on the edit form: changing
 * somebody's access is a different decision from correcting their job title,
 * and folding them together lets a routine edit suspend somebody by accident.
 */
export const SetUserStatusSchema = z
  .object({ status: UserStatusSchema })
  .meta({ id: 'SetUserStatus' });
