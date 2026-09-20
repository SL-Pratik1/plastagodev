import {
  EXCEPTION_REASONS,
  IsoDateSchema,
  JOB_STATUSES,
  ObjectIdSchema,
  PageQuerySchema,
  SERVICE_LEVELS,
} from '@plastago/shared';
import * as z from 'zod';

/**
 * Request shapes that belong to the transport rather than the domain.
 *
 * The contract in `@plastago/shared` describes what a Job *is*; these describe
 * how one is asked for over HTTP — path params, querystring facets and the
 * small bodies that are not themselves domain objects.
 */

/** `:id` on every job route. Rejects a malformed id before it reaches Mongo. */
export const JobIdParamsSchema = z.object({ id: ObjectIdSchema }).meta({ id: 'JobIdParams' });

/**
 * Relative date windows, matching how the office phrases a filter.
 *
 * A single token rather than a pair of dates, because "the next three days" is
 * the question being asked — and a client computing its own boundaries would
 * disagree with the server about when today ends.
 */
export const READY_WINDOWS = ['overdue', 'today', 'next-3', 'next-7', 'last-7', 'last-30'] as const;

/**
 * The jobs grid.
 *
 * Every facet is optional and every one NARROWS. There is nothing here that can
 * widen a customer's view — that boundary is applied separately in the
 * repository, after these are folded in.
 */
export const ListJobsQuerySchema = PageQuerySchema.extend({
  status: z.enum(JOB_STATUSES).optional(),
  /** An account id, or absent. Ignored when the caller's scope already pins one. */
  account: ObjectIdSchema.optional(),
  builder: z.string().trim().max(120).optional(),
  /**
   * A driver id, or the literal `unallocated` — the first column of the
   * dispatch board and the question the office asks every morning.
   */
  driver: z.union([z.literal('unallocated'), ObjectIdSchema]).optional(),
  /**
   * ⚠️ A plain string, not an id schema.
   *
   * It IS a zone id, but this is a grid filter read out of the URL — and a
   * bookmark taken before zones became records carries `?zoneId=sydney`.
   * Validating the shape here would answer that bookmark with a 422 about a
   * field nobody typed; the repository drops anything that is not an id and
   * shows the unfiltered grid instead, which is something the office can see
   * and act on.
   */
  zoneId: z.string().trim().max(40).optional(),
  invoiceStatus: z.enum(['not-invoiced', 'awaiting-po', 'invoiced', 'paid']).optional(),
  serviceLevel: z.enum(SERVICE_LEVELS).optional(),
  readyWindow: z.enum(READY_WINDOWS).optional(),
  /** Open jobs whose target date has passed — the SLA breach being chased. */
  risk: z.literal('at-risk').optional(),
}).meta({ id: 'ListJobsQuery' });

/**
 * M2.4 — cancelling.
 *
 * The reason is an ENUM, not free text: a reason people pick from a list can be
 * counted, and "how many jobs did we lose to access problems last quarter" is a
 * question the office should be able to answer without reading notes. The note
 * is the free-text part, and it is optional.
 */
/**
 * M2.12 — the purchase-order picker on the booking form.
 *
 * `accountId` is required rather than inferred from the session, because the
 * office books on behalf of any account. The service still resolves it through
 * the caller's own scope, so a customer passing somebody else's id gets a 404.
 */
export const PurchaseOrderOptionsQuerySchema = z
  .object({
    accountId: ObjectIdSchema,
    /** Matches the START of a PO number — see the repository for why. */
    q: z.string().trim().max(60).optional(),
  })
  .meta({ id: 'PurchaseOrderOptionsQuery' });

export const CancelJobBodySchema = z
  .object({
    reason: z.enum(EXCEPTION_REASONS),
    note: z.string().trim().max(1000).optional().default(''),
  })
  .meta({ id: 'CancelJobBody' });

/** M2.4a — a new ready date. The SLA clock restarts from it. */
export const RescheduleJobBodySchema = z
  .object({ readyDate: IsoDateSchema })
  .meta({ id: 'RescheduleJobBody' });
