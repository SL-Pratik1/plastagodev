import * as z from 'zod';

/**
 * Carrying the tenant's EXISTING embed token onto a database that has none.
 *
 * ⚠️ The field is named `token` on purpose: `lib/logger.ts` redacts
 * `req.body.token`, so the credential never reaches a request log line.
 * Renaming it would silently undo that.
 *
 * `ownerEmail` is the address the tenant was onboarded as, not the caller's.
 * It is asked for rather than assumed because the vendor checks the pair: the
 * token is proven by minting a session AS this owner before anything is saved.
 */
export const RestoreEmbedTokenSchema = z
  .object({
    token: z.string().trim().min(20).max(500),
    ownerEmail: z.string().trim().toLowerCase().email().max(254),
  })
  .meta({ id: 'RestoreEmbedToken' });

export type RestoreEmbedTokenInput = z.infer<typeof RestoreEmbedTokenSchema>;
