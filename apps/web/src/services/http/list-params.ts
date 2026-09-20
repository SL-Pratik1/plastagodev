import { PageMetaSchema } from '@plastago/shared';
import * as z from 'zod';
import type { ListQuery } from '../types.js';

/**
 * Turns a `ListQuery` into query-string parameters.
 *
 * ── Why `filters` is flattened rather than sent as an object ──────────────
 * The API's list schemas take their facets as top-level query parameters —
 * `?status=active&role=driver` — because that is what a Zod query schema can
 * validate and what an index can serve. The UI groups them under `filters` so a
 * grid can pass its facet state around as one value. This is the one place the
 * two shapes meet.
 *
 * ⚠️ Empty strings are DROPPED, not sent. A cleared dropdown posts `''`, and
 * `?status=` reaches the server as an empty string that fails an enum check —
 * so the user sees a validation error for a filter they just turned off.
 */
export function listParams(
  query: ListQuery,
): Record<string, string | number | undefined> {
  const params: Record<string, string | number | undefined> = {
    page: query.page,
    pageSize: query.pageSize,
  };

  if (query.sort) params.sort = query.sort;
  if (query.q) params.q = query.q;

  for (const [key, value] of Object.entries(query.filters ?? {})) {
    if (value === undefined || value === '') continue;
    params[key] = value;
  }

  return params;
}

/**
 * The paged envelope, for any item schema.
 *
 * Mirrors `pageOf()` in `@plastago/shared` so the two cannot drift — every list
 * response is parsed against this, which is what makes a contract change fail at
 * the boundary instead of as `undefined` inside a table row.
 */
export function pageOf<TItem extends z.ZodType>(
  item: TItem,
): z.ZodObject<{ data: z.ZodArray<TItem>; meta: typeof PageMetaSchema }> {
  return z.object({ data: z.array(item), meta: PageMetaSchema });
}

/**
 * A 204, or a 202 whose body the caller ignores.
 *
 * The api client yields `null` for an empty body, so that is what the schema has
 * to accept. `unknown` on the 202 side because "queued" responses carry a job id
 * nothing in the UI currently reads.
 */
export const NoContentSchema = z.null();
export const AcceptedSchema = z.unknown();

/**
 * A short-lived link to something in object storage.
 *
 * The endpoints that mint these return the URL and never the storage key —
 * the key is a bucket path, and the browser's only legitimate question is
 * where to send the user next.
 */
export const SignedUrlSchema = z.object({ url: z.string() });
