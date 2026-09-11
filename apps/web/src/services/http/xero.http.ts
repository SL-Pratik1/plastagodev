import type { ApiClient } from '@plastago/api-client';
import { API_PREFIX } from '@plastago/shared';
import * as z from 'zod';
import type { XeroService } from '../types.js';
import { NoContentSchema } from './list-params.js';
import { viaService } from './to-service-error.js';

/**
 * I1 · M7.8 — the Xero connection.
 *
 * Its own file for the same reason the extractor has one: Xero is an
 * integration with a credential lifecycle of its own, not a platform setting.
 * Nothing here carries a secret — the tokens never leave the API, and the page
 * only ever sees a status and a URL to navigate to.
 */

const XeroStatusSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  organisationName: z.string().nullable(),
  connectedByName: z.string().nullable(),
  connectedAt: z.string().nullable(),
  lastRefreshAt: z.string().nullable(),
  state: z.enum(['connected', 'needs-reconnect', 'expiring', 'disconnected']),
  message: z.string().nullable(),
  refreshExpiresAt: z.string().nullable(),
  invoiceStatus: z.enum(['DRAFT', 'AUTHORISED']),
});

/**
 * ⚠️ Validated, and the URL constrained to Xero.
 *
 * This value is handed to `window.location.assign`. An open redirect here
 * would let anything that could influence the API response send a signed-in
 * administrator anywhere — and the page they would land on is one that has
 * just asked them for their accounting password. Pinning the host means the
 * worst case is a broken button rather than a convincing phishing hop.
 */
const XeroConnectSchema = z.object({
  authorizeUrl: z
    .string()
    .url()
    .refine(
      (value) => {
        try {
          return new URL(value).origin === 'https://login.xero.com';
        } catch {
          return false;
        }
      },
      { message: 'The sign-in URL must be on login.xero.com' },
    ),
});

export function createHttpXeroService(api: ApiClient): XeroService {
  const base = `${API_PREFIX}/xero`;

  return {
    status: () =>
      viaService(() => api.request(`${base}/status`, { method: 'GET', schema: XeroStatusSchema })),

    beginConnect: () =>
      viaService(() =>
        api.request(`${base}/connect`, { method: 'POST', schema: XeroConnectSchema }),
      ),

    disconnect: async () => {
      await viaService(() =>
        api.request(`${base}/connection`, { method: 'DELETE', schema: NoContentSchema }),
      );
    },
  };
}
