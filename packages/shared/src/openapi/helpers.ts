import type * as z from 'zod';
import { ApiErrorSchema } from '../schemas/envelope.js';

/** Shorthand for a JSON response body, so path declarations stay readable. */
export function jsonResponse(description: string, schema: z.ZodType) {
  return {
    description,
    content: { 'application/json': { schema } },
  };
}

/**
 * The error responses every authenticated endpoint can return.
 * Spread this into an operation's `responses` so the contract stays honest
 * without repeating six blocks per route.
 */
export function errorResponses(...codes: Array<'400' | '401' | '403' | '404' | '409' | '429'>) {
  const catalogue = {
    '400': 'Malformed request or failed validation',
    '401': 'Missing or expired credentials',
    '403': 'Authenticated but not permitted for this role',
    '404': 'Resource does not exist or is not visible to this role',
    '409': 'Conflicts with current state',
    '429': 'Rate limit exceeded',
  } as const;

  return Object.fromEntries(
    codes.map((code) => [code, jsonResponse(catalogue[code], ApiErrorSchema)]),
  );
}
