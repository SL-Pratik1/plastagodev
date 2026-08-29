import * as z from 'zod';

export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 200;

/**
 * Standard list query. `coerce` is deliberate: these arrive as querystrings.
 */
export const PageQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
    sort: z.string().optional().describe('Field name, prefix with "-" for descending'),
    q: z.string().trim().min(1).optional().describe('Free-text search'),
  })
  .meta({ id: 'PageQuery' });

export const PageMetaSchema = z
  .object({
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  })
  .meta({ id: 'PageMeta' });

/**
 * Wraps any item schema in the paged envelope.
 * Generic factory, so list endpoints never redeclare the envelope.
 */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    meta: PageMetaSchema,
  });
}

export type PageQuery = z.infer<typeof PageQuerySchema>;
export type PageMeta = z.infer<typeof PageMetaSchema>;
