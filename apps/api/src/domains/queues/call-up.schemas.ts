import { CallUpStateSchema, ObjectIdSchema } from '@plastago/shared';
import * as z from 'zod';

/** Route-shape validation for call-ups (M2.12b). No business rules here. */

export const CallUpIdParamsSchema = z
  .object({ id: ObjectIdSchema })
  .meta({ id: 'CallUpIdParams' });

export const PurchaseOrderIdParamsSchema = z
  .object({ purchaseOrderId: ObjectIdSchema })
  .meta({ id: 'PurchaseOrderIdParams' });

export const ListCallUpsQuerySchema = z
  .object({
    /**
     * Omitted means every state.
     *
     * The office's default view is `needs-review` — the ones that could not be
     * applied — but the applied history is what answers *"when did that job get
     * moved, and who moved it?"*, so it has to be reachable.
     */
    state: CallUpStateSchema.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .meta({ id: 'ListCallUpsQuery' });

/**
 * Why a reviewer is setting a call-up aside.
 *
 * Required, like a purchase-order rejection: "not a call-up" and "the builder
 * cancelled this months ago" are different facts, and a queue of bare dismissals
 * says only that something was wrong sometimes.
 */
export const RejectCallUpSchema = z
  .object({ note: z.string().trim().min(1, 'Say why, in a few words').max(500) })
  .meta({ id: 'RejectCallUp' });

export const ListAwaitingQuerySchema = z
  .object({
    accountId: ObjectIdSchema.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .meta({ id: 'ListAwaitingQuery' });
