import { IsoDateSchema, RateCardIdSchema, ServiceCodeSchema, ZONES } from '@plastago/shared';
import * as z from 'zod';

/**
 * Request shapes that belong to the transport rather than the domain.
 *
 * `@plastago/shared` already describes what Settings *are*, and those schemas
 * are reused verbatim for the save bodies below — the wire shape and the domain
 * shape are the same thing here, and duplicating them would let the two drift.
 * What lives in this file is only what HTTP adds: path params and query facets.
 */

/**
 * `:id` on the rate-card routes.
 *
 * Validated with the same schema that guards a card being created, so a path
 * that could never name a real card is refused as a 422 before it reaches a
 * database lookup that would 404.
 */
export const RateCardIdParamsSchema = z
  .object({ id: RateCardIdSchema })
  .meta({ id: 'RateCardIdParams' });

/** `:code` on the additional-service routes. */
export const ServiceCodeParamsSchema = z
  .object({ code: ServiceCodeSchema })
  .meta({ id: 'ServiceCodeParams' });

/**
 * A price preview asked for directly (M6).
 *
 * Separate from the job draft on purpose: the office previews a price while the
 * booking form is still incomplete, and requiring a valid draft would mean no
 * price until the very last field. Everything here is what pricing actually
 * needs and nothing more.
 */
export const QuoteQuerySchema = z
  .object({
    rateCardId: RateCardIdSchema,
    zone: z.enum(ZONES),
    /**
     * Nullable, not optional-and-defaulted-to-zero. A fixed-price builder's job
     * genuinely has no area (Matt, 31:04), and a zero would price it as if the
     * customer had asked for nothing.
     */
    expectedAreaM2: z.coerce.number().positive().max(100_000).nullable().optional(),
    bagCount: z.coerce.number().int().min(0).max(500).optional(),
    /**
     * The date to price AS AT (M6.2) — the job's ready date.
     *
     * Optional here and only here, because this endpoint answers "what would
     * this cost?" before there is a job, and the office previews a price while
     * the ready date is still empty. It falls back to today in the controller,
     * which is the honest answer to a question asked with no date in it.
     *
     * ⚠️ `pricingService` itself requires the date. The default lives at the
     * transport edge so no domain caller can quietly inherit it.
     */
    onDate: IsoDateSchema.optional(),
  })
  .meta({ id: 'QuoteQuery' });

/** `:id` on the invoice-template routes. */
export const InvoiceTemplateIdParamsSchema = z
  .object({ id: z.string().trim().min(1).max(60) })
  .meta({ id: 'InvoiceTemplateIdParams' });

/**
 * `:effectiveFrom` on the schedule-removal route.
 *
 * A date in the path rather than a database id, because that is how a schedule
 * is identified everywhere else — the card plus the day it starts. Validated as
 * a real `YYYY-MM-DD` so a malformed path is a 422 with a readable message
 * rather than a lookup that quietly matches nothing.
 */
export const ScheduleParamsSchema = z
  .object({ id: RateCardIdSchema, effectiveFrom: IsoDateSchema })
  .meta({ id: 'ScheduleParams' });

/**
 * Confirming that the logo bytes landed.
 *
 * The key is the one this API minted and handed back with the upload URL; the
 * service refuses anything outside the logo's own prefix, so a caller cannot
 * point the invoices at another object in the bucket.
 */
export const LogoConfirmSchema = z
  .object({ key: z.string().trim().min(1).max(512) })
  .meta({ id: 'LogoConfirm' });
