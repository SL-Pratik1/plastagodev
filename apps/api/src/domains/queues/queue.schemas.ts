import {
  ChangeRequestDecisionSchema, ObjectIdSchema } from '@plastago/shared';
import * as z from 'zod';

/**
 * Request shapes that belong to the transport rather than the domain.
 *
 * The DECISIONS (`FutileDecisionSchema`, `ChargeDecisionSchema`) live in
 * `@plastago/shared` because the office console and the portal must agree on
 * them. What is here is how a worklist is asked for over HTTP.
 */

export const QueueIdParamsSchema = z.object({ id: ObjectIdSchema }).meta({ id: 'QueueIdParams' });

/**
 * A worklist's query.
 *
 * `agedOverDays` is the facet that makes these queues useful: the office's real
 * question is "what has been sitting here too long", and without it every list
 * is just a pile.
 */
export const QueueListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    sort: z.string().trim().max(40).optional(),
    q: z.string().trim().max(120).optional(),
    account: ObjectIdSchema.optional(),
    agedOverDays: z.coerce.number().int().min(0).max(365).optional(),
  })
  .meta({ id: 'QueueListQuery' });

/**
 * A bulk decision's payload.
 *
 * Bounded at 200 for the same reason as the invoice bulk actions: an unbounded
 * list is a way to make one request rewrite the whole table.
 */
export const QueueIdsSchema = z
  .object({
    ids: z
      .array(ObjectIdSchema)
      .min(1, 'Select at least one row')
      .max(200, 'Select fewer rows — up to 200 at a time'),
  })
  .meta({ id: 'QueueIds' });

/** M2.7 — the bulk charge decision, ids plus the decision itself. */
export const ChargeDecisionBodySchema = z
  .object({
    ids: z
      .array(ObjectIdSchema)
      .min(1, 'Select at least one charge')
      .max(200, 'Select fewer charges — up to 200 at a time'),
    decision: z.enum(['approve', 'reject']),
    /** Required on reject — it is the only record of why. Checked in the service. */
    note: z.string().trim().max(500).default(''),
  })
  .meta({ id: 'ChargeDecisionBody' });

/**
 * The body of a change-request decision.
 *
 * Re-exported from the shared contract rather than redeclared, so the office
 * console and the API cannot drift on what a decision is.
 */
export const ChangeRequestDecisionBodySchema = ChangeRequestDecisionSchema;
