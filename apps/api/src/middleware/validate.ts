import type { Request, RequestHandler } from 'express';
import type { FieldIssue } from '@plastago/shared';
import type * as z from 'zod';
import { AppError } from '../lib/app-error.js';

export interface ValidationSchemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

type Part = keyof ValidationSchemas;

export type ValidatedData<S extends ValidationSchemas> = {
  [K in keyof S & Part]: S[K] extends z.ZodType ? z.output<S[K]> : never;
};

/** Use as the request type in a controller so `req.validated` is fully typed. */
export type ValidatedRequest<S extends ValidationSchemas> = Request & {
  validated: ValidatedData<S>;
};

/**
 * Zod validation as middleware (§6A.7) — mandatory on every route that accepts
 * input, sourced from `@plastago/shared` so the client and server can never
 * disagree about a shape.
 *
 * Parsed output is written to `req.validated`, not back onto `req.body`/`req.query`:
 * Express 5 exposes `query` as a getter, and keeping the raw input intact means
 * the log middleware still sees what the client actually sent.
 *
 *   router.get(
 *     '/',
 *     validate({ query: PageQuerySchema }),
 *     asyncHandler(listThings),
 *   );
 *
 *   async function listThings(req: ValidatedRequest<{ query: typeof PageQuerySchema }>, res) {
 *     const { page, pageSize } = req.validated.query;  // fully typed, coerced
 *   }
 */
export function validate<const S extends ValidationSchemas>(schemas: S): RequestHandler {
  const parts = Object.keys(schemas) as Part[];

  return (req, _res, next) => {
    const validated: Record<string, unknown> = {};
    const issues: FieldIssue[] = [];

    for (const part of parts) {
      const schema = schemas[part];
      if (!schema) continue;

      const result = schema.safeParse(req[part]);
      if (result.success) {
        validated[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          issues.push({
            path: [part, ...issue.path.map(String)].join('.'),
            message: issue.message,
          });
        }
      }
    }

    if (issues.length > 0) {
      next(AppError.validation('Request validation failed', issues));
      return;
    }

    req.validated = validated;
    next();
  };
}
