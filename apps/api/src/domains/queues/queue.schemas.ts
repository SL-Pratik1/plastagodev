import {
  ChangeRequestDecisionSchema,
  ChargeCodeSchema,
  ExceptionReasonSchema,
  ObjectIdSchema,
} from '@plastago/shared';
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
 * How long a review has been waiting, as the filter bar asks it.
 *
 * A token rather than `agedOverDays`, because two of the four are not "older
 * than N days" at all — "Today" and "This week" are windows with a near edge,
 * and expressing them as a single lower bound loses that.
 */
export const QUEUE_AGES = ['today', 'this-week', 'over-week', 'over-month'] as const;
export const QueueAgeSchema = z.enum(QUEUE_AGES).meta({ id: 'QueueAge' });
export type QueueAge = z.infer<typeof QueueAgeSchema>;

/**
 * The futile queue's list query.
 *
 * ⚠️ Every facet below was already drawn in the filter bar and sent on the
 * query string, and none of them existed here. Zod strips what a schema does
 * not name, so the server received `?outcome=rescheduled&reason=weather` and
 * silently answered with the unfiltered, pending-only list — the controls moved
 * and the grid never changed. Adding them here is what makes that bar real.
 */
export const FutileListQuerySchema = QueueListQuerySchema.extend({
  /**
   * Absent means `pending`: this is a worklist first, and the nav badge counts
   * the same thing. `any` is how the screen asks for the decided ones too.
   */
  outcome: z.enum(['pending', 'rescheduled', 'cancelled', 'any']).optional(),
  reason: ExceptionReasonSchema.optional(),
  driver: ObjectIdSchema.optional(),
  zoneId: ObjectIdSchema.optional(),
  age: QueueAgeSchema.optional(),
}).meta({ id: 'FutileListQuery' });

/**
 * The approvals queue's list query — the shared one, plus the decision.
 *
 * ── Why the approvals queue needs a state and the others do not ───────────
 * Because approving is what removes a row. The queue was pending-only with no
 * way to ask for anything else, so a decision erased the charge from the only
 * screen that lists charges and "what did we approve, and on what evidence?"
 * had no answer. The futile queue has offered exactly this since M2.6 — its
 * filter reads "Actioned and not" — so this is bringing one queue into line
 * with the other rather than inventing a concept.
 *
 * Absent means `pending`: this is a worklist first, and the nav badge counts
 * the same thing.
 */
export const ApprovalListQuerySchema = QueueListQuerySchema.extend({
  approvalState: z.enum(['pending', 'approved', 'rejected', 'any']).optional(),
  /*
   * ⚠️ Every facet below was drawn in the filter bar and sent on the query
   * string, and none of them existed here — so Zod stripped them, and picking
   * "PO required", a charge type, a driver, "Has photos" or a waiting time
   * moved the control and left the grid exactly as it was. Same fault the
   * futile queue had, fixed the same way.
   */
  code: ChargeCodeSchema.optional(),
  /** The driver who raised it. A driver's charges come off their own job. */
  driver: ObjectIdSchema.optional(),
  po: z.enum(['required', 'not-required']).optional(),
  /** Whether the charge has photos of ITS evidence — see `evidencePurposeForCharge`. */
  evidence: z.enum(['with-photos', 'no-photos']).optional(),
  age: QueueAgeSchema.optional(),
}).meta({ id: 'ApprovalListQuery' });

/**
 * The awaiting-PO queue's list query.
 *
 * `chased` and `age` were drawn in its filter bar and silently stripped here,
 * like the approvals facets above.
 */
export const AwaitingPoListQuerySchema = QueueListQuerySchema.extend({
  chased: z.enum(['yes', 'no']).optional(),
  age: QueueAgeSchema.optional(),
}).meta({ id: 'AwaitingPoListQuery' });

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
