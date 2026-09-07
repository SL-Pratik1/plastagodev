import { INTEGRATION_IDS, RATE_CARDS, ZONES } from '@plastago/shared';
import * as z from 'zod';

/**
 * Request shapes that belong to the transport rather than the domain.
 *
 * `@plastago/shared` already describes what Settings *are*, and those schemas
 * are reused verbatim for the save bodies below — the wire shape and the domain
 * shape are the same thing here, and duplicating them would let the two drift.
 * What lives in this file is only what HTTP adds: path params and query facets.
 */

/** `:id` on the integration routes. */
export const IntegrationIdParamsSchema = z
  .object({ id: z.enum(INTEGRATION_IDS) })
  .meta({ id: 'IntegrationIdParams' });

/**
 * W7 — the result of a connection check.
 *
 * `detail` is what gets shown on the settings card when a check fails, so it is
 * bounded: an unbounded error string from a third-party SDK is a stack trace on
 * somebody's screen.
 */
export const IntegrationCheckBodySchema = z
  .object({
    ok: z.boolean(),
    detail: z.string().max(300).optional(),
  })
  .meta({ id: 'IntegrationCheckBody' });

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
    rateCardId: z.enum(RATE_CARDS),
    zone: z.enum(ZONES),
    /**
     * Nullable, not optional-and-defaulted-to-zero. A fixed-price builder's job
     * genuinely has no area (Matt, 31:04), and a zero would price it as if the
     * customer had asked for nothing.
     */
    expectedAreaM2: z.coerce.number().positive().max(100_000).nullable().optional(),
    bagCount: z.coerce.number().int().min(0).max(500).optional(),
  })
  .meta({ id: 'QuoteQuery' });
