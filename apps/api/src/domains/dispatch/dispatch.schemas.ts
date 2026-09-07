import { IsoDateSchema, ObjectIdSchema } from '@plastago/shared';
import * as z from 'zod';

/**
 * Request shapes that belong to the transport rather than the domain.
 *
 * `CreateRunInput` already lives in `@plastago/shared` and is reused verbatim —
 * the wire shape and the domain shape are the same thing there. What is here is
 * only what HTTP adds: path params and the small bodies that are not themselves
 * domain objects.
 */

/** `:id` on every run route. */
export const RunIdParamsSchema = z.object({ id: ObjectIdSchema }).meta({ id: 'RunIdParams' });

/** `:id/jobs/:jobId` — removing a stop names both. */
export const RunStopParamsSchema = z
  .object({ id: ObjectIdSchema, jobId: ObjectIdSchema })
  .meta({ id: 'RunStopParams' });

/**
 * The board and the map are both "one date".
 *
 * Required rather than defaulted to today: the allocator plans tomorrow as
 * often as today, and a screen that silently shows a different day than the one
 * in the URL is how somebody assigns a run to the wrong morning.
 */
export const DateQuerySchema = z.object({ date: IsoDateSchema }).meta({ id: 'DateQuery' });

export const RenameRunBodySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name the run — dispatch and drivers both call it by name')
      .max(60),
  })
  .meta({ id: 'RenameRunBody' });

/** Adding a stop. The job is named in the body so the path stays about the run. */
export const AddStopBodySchema = z
  .object({ jobId: ObjectIdSchema })
  .meta({ id: 'AddStopBody' });

/**
 * A hand reorder.
 *
 * ⚠️ Must be a PERMUTATION of the run's current stops — the service checks
 * membership, not just length. A partial list would silently drop the stops it
 * omitted, and a stop that vanishes off a run sheet is a collection that does
 * not happen.
 */
export const ReorderRunBodySchema = z
  .object({ jobIds: z.array(ObjectIdSchema).min(1, 'Send the stops in their new order') })
  .meta({ id: 'ReorderRunBody' });

export const AssignRunBodySchema = z
  .object({ driverId: ObjectIdSchema })
  .meta({ id: 'AssignRunBody' });
