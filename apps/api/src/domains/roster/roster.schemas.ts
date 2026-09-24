import { ObjectIdSchema } from '@plastago/shared';
import * as z from 'zod';

/** Request shapes for the driver roster — transport, not domain. */

export const DriverIdParamsSchema = z
  .object({ id: ObjectIdSchema })
  .meta({ id: 'DriverIdParams' });

/**
 * ⚠️ The `expiry` filter went with credential tracking — it selected on a state
 * derived from a collection nothing could write, so every value but `valid`
 * returned an empty page. See `fleet.ts`.
 */
export const ListDriversQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    sort: z.string().trim().max(40).optional(),
    q: z.string().trim().max(120).optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .meta({ id: 'ListDriversQuery' });
