import * as z from 'zod';

/**
 * Machine-readable error codes. Add to this union rather than inventing strings
 * at the call site, so clients can branch on them safely.
 */
export const ErrorCodeSchema = z
  .enum([
    'BAD_REQUEST',
    'VALIDATION_FAILED',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'CONFLICT',
    'RATE_LIMITED',
    'DEPENDENCY_UNAVAILABLE',
    'INTERNAL_ERROR',
  ])
  .meta({ id: 'ErrorCode' });

/** One field-level validation failure, flattened from a Zod issue. */
export const FieldIssueSchema = z
  .object({
    path: z.string().describe('Dot path to the offending field, e.g. "site.postcode"'),
    message: z.string(),
  })
  .meta({ id: 'FieldIssue' });

/**
 * The ONLY error shape the API returns. Every client can rely on it.
 */
export const ApiErrorSchema = z
  .object({
    error: z.object({
      code: ErrorCodeSchema,
      message: z.string().describe('Human-readable, safe to surface in the UI'),
      issues: z.array(FieldIssueSchema).optional(),
      requestId: z.string().describe('Correlates the response with the server log line'),
    }),
  })
  .meta({ id: 'ApiError' });

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type FieldIssue = z.infer<typeof FieldIssueSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
