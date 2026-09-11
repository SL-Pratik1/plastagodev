import * as z from 'zod';

/**
 * Request shapes for the Xero domain.
 *
 * ── Why these live here rather than in `@plastago/shared` ─────────────────
 * The rule is that anything the CLIENT sends is validated against a shared
 * schema, so the two sides cannot disagree. Nothing here is sent by the
 * client: this is the query string Xero itself puts on its redirect. Putting
 * it in the shared package would publish a third party's wire format to the
 * browser bundle as though PlastaGo owned it.
 */

/**
 * What Xero appends to the callback URL.
 *
 * Every field is optional because a failed or cancelled authorisation returns
 * `error` and no `code`, and a malformed one can return neither. Rejecting the
 * request outright would render the API's JSON error envelope in the address
 * bar of somebody who simply pressed Cancel — so the shape is permissive here
 * and the service decides what each combination means.
 *
 * `.catch(undefined)` on each field rather than a strict object: this input is
 * controlled by a third party, and a validation failure would be an unhandled
 * dead end mid-navigation rather than something a user could act on.
 */
export const XeroCallbackQuerySchema = z
  .object({
    code: z.string().min(1).max(2048).optional().catch(undefined),
    state: z.string().min(1).max(512).optional().catch(undefined),
    error: z.string().min(1).max(256).optional().catch(undefined),
  })
  /*
   * Xero also sends `session_state` and `scope`, which are ignored. Stripping
   * unknown keys is Zod's default and the right one — it keeps whatever else
   * the vendor adds later out of the object the service reads.
   */
  .loose()
  .transform((value) => ({
    code: value.code ?? null,
    state: value.state ?? null,
    error: value.error ?? null,
  }));
