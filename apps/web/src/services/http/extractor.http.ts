import type { ApiClient } from '@plastago/api-client';
import { API_PREFIX } from '@plastago/shared';
import * as z from 'zod';
import type { ExtractorService } from '../types.js';
import { NoContentSchema } from './list-params.js';
import { viaService } from './to-service-error.js';

/**
 * I6 — the Extractor tab's session broker.
 *
 * Its own file rather than a method on the settings service: the extractor is
 * an integration with its own credential lifecycle, not a platform setting, and
 * `reference.http.ts` is explicitly the home of "three or four passthrough
 * methods" per domain that read state. This one mints a credential.
 */

/**
 * ⚠️ Validated even though the API is ours.
 *
 * The value is going straight into an iframe `src`. A response shape that
 * changed under us would otherwise produce `?sessionId=undefined` and a vendor
 * error page inside our own frame, which is a much harder failure to read than
 * a schema complaint here.
 */
const ExtractorSessionSchema = z.object({
  sessionId: z.string().min(1),
  expiresAt: z.string().min(1),
});

export function createHttpExtractorService(api: ApiClient): ExtractorService {
  const base = `${API_PREFIX}/extractor`;

  return {
    createSession: () =>
      viaService(() =>
        api.request(`${base}/session`, {
          method: 'POST',
          schema: ExtractorSessionSchema,
        }),
      ),

    forgetSession: async () => {
      await viaService(() =>
        api.request(`${base}/session`, { method: 'DELETE', schema: NoContentSchema }),
      );
    },
  };
}
