import {
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  BRAND_IDS,
  CAPTURE_MODES,
  ObjectIdSchema,
  ONBOARDING_STATES,
  PageQuerySchema,
  PO_POLICIES,
  RATE_CARDS,
} from '@plastago/shared';
import * as z from 'zod';

/**
 * Request shapes that belong to the transport rather than the domain.
 *
 * The contract in `@plastago/shared` describes what an Account *is*; these
 * describe how one is asked for over HTTP — path params and querystring facets.
 * They live here because a route filter is not a domain concept, and putting
 * them in the shared package would ship them to a browser that never sends them.
 */

/** `:id` on every account route. Rejects a malformed id before it reaches Mongo. */
export const AccountIdParamsSchema = z
  .object({ id: ObjectIdSchema })
  .meta({ id: 'AccountIdParams' });

/**
 * The accounts grid, with the facets the office actually filters by.
 *
 * Every facet is optional and every one narrows — there is no parameter here
 * that can widen a customer-role caller's scope, which is applied separately in
 * the repository.
 */
export const ListAccountsQuerySchema = PageQuerySchema.extend({
  status: z.enum(ACCOUNT_STATUSES).optional(),
  accountType: z.enum(ACCOUNT_TYPES).optional(),
  brandId: z.enum(BRAND_IDS).optional(),
  rateCardId: z.enum(RATE_CARDS).optional(),
  poPolicy: z.enum(PO_POLICIES).optional(),
  captureMode: z.enum(CAPTURE_MODES).optional(),
  onboarding: z.enum(ONBOARDING_STATES).optional(),
}).meta({ id: 'ListAccountsQuery' });

/**
 * M4.8b — the risk-assessment toggle.
 *
 * An explicit boolean rather than a bare POST-to-toggle: a retried request must
 * land on the same state it asked for, and a toggle flips twice.
 */
export const RiskAssessmentBodySchema = z
  .object({ required: z.boolean() })
  .meta({ id: 'RiskAssessmentBody' });
