import { createApiClient } from '@plastago/api-client';
import { env } from '@/config/env';

/**
 * This app's configured client instance.
 *
 * The implementation lives in `@plastago/api-client` so the driver PWA uses the
 * exact same request, parse and error semantics. Only the base URL differs.
 */
export const api = createApiClient({ baseUrl: env.VITE_API_BASE_URL });

export { ApiRequestError } from '@plastago/api-client';
