import * as z from 'zod';

/**
 * Request shapes that belong to the transport rather than the domain.
 *
 * `@plastago/shared` describes what a Place *is*; this describes how one is
 * asked for over HTTP.
 */

/**
 * The type-ahead query.
 *
 * Optional and defaulted to empty, so the control can open with something in it
 * rather than an empty box the user has to guess at. Bounded because a 4,000
 * character "suburb" is not a search, it is a probe.
 */
export const SearchPlacesQuerySchema = z
  .object({ q: z.string().trim().max(80).optional().default('') })
  .meta({ id: 'SearchPlacesQuery' });
