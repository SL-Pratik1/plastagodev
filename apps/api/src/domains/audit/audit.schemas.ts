import { AuditActionSchema, AuditEntitySchema, ObjectIdSchema } from '@plastago/shared';
import * as z from 'zod';

/**
 * Request shapes for the audit log — transport concerns, not domain ones.
 *
 * `AuditEntry` itself lives in `@plastago/shared`: the console and the contract
 * must agree on what an entry IS. What is here is how one is asked for.
 */

export const AuditIdParamsSchema = z.object({ id: ObjectIdSchema }).meta({ id: 'AuditIdParams' });

/**
 * The filters the screen offers, and nothing more.
 *
 * ⚠️ Deliberately a closed set, per Risk 5's ruling against generic query
 * endpoints. Every facet here is backed by an index in `audit.model.ts`; an
 * open filter would let a UI ask for a collection scan over seven years of
 * retained entries.
 */
export const ListAuditQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    sort: z.string().trim().max(40).optional(),
    q: z.string().trim().max(120).optional(),

    /** A user id — "everything Priya did". */
    actor: ObjectIdSchema.optional(),
    action: AuditActionSchema.optional(),
    entity: AuditEntitySchema.optional(),
    /**
     * Pinned to one record — "everything that happened to job 61402".
     *
     * Paired with `entity`, this is the index the whole feature is written
     * around, and the direct answer to M1.6's worked example.
     */
    entityId: ObjectIdSchema.optional(),

    /** The screen's window chips. */
    window: z.enum(['today', 'last-24h', 'last-7d', 'last-30d']).optional(),
    /** An explicit range, for "what happened the week of the disputed invoice". */
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
  })
  .meta({ id: 'ListAuditQuery' });
