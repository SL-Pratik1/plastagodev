import type { ApiClient } from '@plastago/api-client';
import { API_PREFIX } from '@plastago/shared';
import * as z from 'zod';
import type { SupportService } from '../types.js';
import { NoContentSchema } from './list-params.js';
import { viaService } from './to-service-error.js';

/**
 * The support bubble's session broker (Sortd).
 *
 * Its own file for the same reason as `extractor.http.ts`: an integration
 * with its own credential lifecycle, not a setting or a passthrough read.
 */

/**
 * ⚠️ Validated even though the API is ours. The session id and base URL go
 * straight into a script tag; a changed response shape must fail here, not
 * load `undefined/embed.js` on every screen.
 */
const SupportSessionSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    baseUrl: z.url({ protocol: /^https?$/ }),
    sessionId: z.string().min(1),
    expiresAt: z.string().min(1),
  }),
]);

export function createHttpSupportService(api: ApiClient): SupportService {
  const base = `${API_PREFIX}/sortd`;

  return {
    session: () =>
      viaService(() => api.request(`${base}/session`, { schema: SupportSessionSchema })),

    revoke: async () => {
      await viaService(() =>
        api.request(`${base}/session`, { method: 'DELETE', schema: NoContentSchema }),
      );
    },
  };
}
