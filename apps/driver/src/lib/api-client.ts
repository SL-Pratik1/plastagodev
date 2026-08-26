import { createApiClient } from '@plastago/api-client';
import { env } from '@/config/env';

/**
 * The driver app's client instance — same implementation as the web app, so
 * request, parse and error semantics cannot drift between surfaces.
 *
 * ⚠️ When auth lands: the native Flutter shell stores its token in
 * Keychain/Keystore (§9), NOT in localStorage. The PWA keeps using the httpOnly
 * cookie. Wire that difference through `getHeaders` here rather than inside
 * `@plastago/api-client`, so the shared package stays surface-agnostic.
 */
export const api = createApiClient({ baseUrl: env.VITE_API_BASE_URL });

export { ApiRequestError } from '@plastago/api-client';
