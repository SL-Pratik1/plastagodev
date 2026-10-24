import type { ApiClient } from '@plastago/api-client';
import {
  API_PREFIX,
  PortalTermsStatusSchema,
  PresignedUploadSchema,
  TermsLibrarySchema,
  type TermsSigning,
} from '@plastago/shared';
import * as z from 'zod';
import type { TermsService } from '../types.js';
import { viaService } from './to-service-error.js';

const UrlSchema = z.object({ url: z.string() });
const DocumentSchema = z.object({ url: z.string(), fileName: z.string(), version: z.number() });

/**
 * Terms and conditions (Matt, 21 Oct) — the office's library and the
 * customer's signing, in one file because they are one record seen from two
 * sides.
 */
export function createHttpTermsService(api: ApiClient): TermsService {
  const office = `${API_PREFIX}/terms`;
  const portal = `${API_PREFIX}/portal/terms`;

  return {
    library: () => viaService(() => api.request(office, { schema: TermsLibrarySchema })),

    /**
     * Ask, PUT, confirm — the same three steps as the invoice logo. The bytes go
     * straight to storage with a bare `fetch`; nothing changes until the confirm.
     */
    upload: async (file: File) => {
      const ticket = await viaService(() =>
        api.request(`${office}/upload`, {
          method: 'POST',
          body: { contentType: file.type, contentLength: file.size },
          schema: PresignedUploadSchema,
        }),
      );

      const response = await fetch(ticket.uploadUrl, {
        method: 'PUT',
        headers: ticket.headers,
        body: file,
      });
      if (!response.ok) {
        throw new Error(`The terms could not be uploaded (${String(response.status)})`);
      }

      return viaService(() =>
        api.request(office, {
          method: 'PUT',
          body: { key: ticket.key, fileName: file.name },
          schema: TermsLibrarySchema,
        }),
      );
    },

    versionUrl: async (version: number) =>
      (
        await viaService(() =>
          api.request(`${office}/versions/${String(version)}/url`, { schema: UrlSchema }),
        )
      ).url,

    signedCopyUrl: async (accountId: string) =>
      (
        await viaService(() => api.request(`${office}/signed/${accountId}/url`, { schema: UrlSchema }))
      ).url,

    status: () => viaService(() => api.request(portal, { schema: PortalTermsStatusSchema })),

    mySignedCopyUrl: async () =>
      (await viaService(() => api.request(`${portal}/signed`, { schema: UrlSchema }))).url,

    currentDocument: () =>
      viaService(() => api.request(`${portal}/document`, { schema: DocumentSchema })),

    sign: (input: TermsSigning) =>
      viaService(() =>
        api.request(`${portal}/sign`, {
          method: 'POST',
          body: input,
          schema: PortalTermsStatusSchema,
        }),
      ),
  };
}
