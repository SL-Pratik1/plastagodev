import * as z from 'zod';

/**
 * Client-side environment. Everything here is PUBLIC — Vite inlines `VITE_*`
 * into the bundle.
 */
const EnvSchema = z.object({
  VITE_API_BASE_URL: z.string().default(''),
});

const parsed = EnvSchema.safeParse(import.meta.env);

if (!parsed.success) {
  throw new Error(`Invalid client environment:\n${z.prettifyError(parsed.error)}`);
}

export const env = parsed.data;
