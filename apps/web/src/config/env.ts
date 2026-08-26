import * as z from 'zod';

/**
 * Client-side environment, validated at module load.
 *
 * Everything here is PUBLIC — Vite inlines `VITE_*` into the bundle. Secrets
 * (Twilio, Mistral, Xero, S3) belong on the API only; nothing that must stay
 * private may ever appear in this file.
 */
const EnvSchema = z.object({
  /** Same-origin by default so the dev proxy and production both just work. */
  VITE_API_BASE_URL: z.string().default(''),
  VITE_ENABLE_MOCKS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

const parsed = EnvSchema.safeParse(import.meta.env);

if (!parsed.success) {
  throw new Error(`Invalid client environment:\n${z.prettifyError(parsed.error)}`);
}

export const env = parsed.data;
