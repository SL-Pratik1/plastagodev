import type { ApiClient } from '@plastago/api-client';
import {
  API_PREFIX,
  AwaitingPoItemSchema,
  ChargeApprovalDetailSchema,
  ChargeApprovalItemSchema,
  FutileReviewItemSchema,
  FutileReviewSchema,
  LeadAttachmentSchema,
  LeadListItemSchema,
  LeadSchema,
  ObjectIdSchema,
  PoExtractionItemSchema,
  PoExtractionSchema,
  QueueCountsSchema,
  type ChargeDecision,
  type FutileDecision,
  type LeadAttachment,
  type LeadConversion,
  type LeadCreate,
  type LeadUpdate,
  type PoConfirmation,
} from '@plastago/shared';
import * as z from 'zod';
import { ServiceError } from '../service-error.js';
import type { ListQuery, QueueService } from '../types.js';
import { NoContentSchema, listParams, pageOf } from './list-params.js';
import { viaService } from './to-service-error.js';

/**
 * The five office queues — M2.6, M2.7, M7.3, M2.12 and M5 · Journey A.
 *
 * Endpoint paths appear here and nowhere else in the app.
 */

const ChangedSchema = z.object({ changed: z.number().int().nonnegative() });

/** What `POST /queues/leads/:id/attachments` answers with. */
const AttachResponseSchema = z.object({
  attachmentId: ObjectIdSchema,
  upload: z.object({
    key: z.string(),
    uploadUrl: z.string(),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.string(),
  }),
});

export function createHttpQueueService(api: ApiClient): QueueService {
  const base = `${API_PREFIX}/queues`;

  return {
    /** One call for every nav badge. Polled by the shell, not by each screen. */
    counts: () => viaService(() => api.request(`${base}/counts`, { schema: QueueCountsSchema })),

    /* ── M2.6 · futile review ─────────────────────────────────────────────── */

    futileList: (query: ListQuery) =>
      viaService(() =>
        api.request(`${base}/futile`, {
          searchParams: listParams(query),
          schema: pageOf(FutileReviewItemSchema),
        }),
      ),

    futileGet: (id: string) =>
      viaService(() => api.request(`${base}/futile/${id}`, { schema: FutileReviewSchema })),

    futileDecide: async (id: string, decision: FutileDecision) => {
      await viaService(() =>
        api.request(`${base}/futile/${id}/decision`, {
          method: 'POST',
          // The decision is about the JOB, never the money: either way the
          // futile fee stands, so nothing here touches the charge.
          body: decision,
          schema: NoContentSchema,
        }),
      );
    },

    /* ── M2.7 · additional service approvals ──────────────────────────────── */

    approvalList: (query: ListQuery) =>
      viaService(() =>
        api.request(`${base}/approvals`, {
          searchParams: listParams(query),
          schema: pageOf(ChargeApprovalItemSchema),
        }),
      ),

    approvalGet: (id: string) =>
      viaService(() =>
        api.request(`${base}/approvals/${id}`, { schema: ChargeApprovalDetailSchema }),
      ),

    approvalDecide: async (ids: readonly string[], decision: ChargeDecision) => {
      /*
       * ids and the decision travel in ONE body rather than the ids in the path.
       * The queue is worked in batches, and the count comes back rather than an
       * error because a grid selection is expected to contain rows somebody else
       * already actioned.
       */
      const { changed } = await viaService(() =>
        api.request(`${base}/approvals/decision`, {
          method: 'POST',
          body: { ids, ...decision },
          schema: ChangedSchema,
        }),
      );
      return changed;
    },

    /* ── M7.3 · awaiting a purchase order ─────────────────────────────────── */

    awaitingPoList: (query: ListQuery) =>
      viaService(() =>
        api.request(`${base}/awaiting-po`, {
          searchParams: listParams(query),
          schema: pageOf(AwaitingPoItemSchema),
        }),
      ),

    awaitingPoChase: async (ids: readonly string[]) => {
      const { changed } = await viaService(() =>
        api.request(`${base}/awaiting-po/chase`, {
          method: 'POST',
          body: { ids },
          schema: ChangedSchema,
        }),
      );
      return changed;
    },

    /* ── M2.12 · AI purchase-order review ─────────────────────────────────── */

    poReviewList: (query: ListQuery) =>
      viaService(() =>
        api.request(`${base}/po-review`, {
          searchParams: listParams(query),
          schema: pageOf(PoExtractionItemSchema),
        }),
      ),

    poReviewGet: (id: string) =>
      viaService(() => api.request(`${base}/po-review/${id}`, { schema: PoExtractionSchema })),

    poReviewConfirm: async (id: string, input: PoConfirmation) => {
      await viaService(() =>
        api.request(`${base}/po-review/${id}/confirm`, {
          method: 'POST',
          body: input,
          // 202 with a body describing what was created. The screen navigates
          // away and refetches, so the payload is parsed loosely and dropped.
          schema: z.unknown(),
        }),
      );
    },

    poReviewReject: async (id: string, note: string) => {
      await viaService(() =>
        api.request(`${base}/po-review/${id}/reject`, {
          method: 'POST',
          body: { note },
          schema: NoContentSchema,
        }),
      );
    },

    /* ── M5 · Journey A — leads ───────────────────────────────────────────── */

    leadList: (query: ListQuery) =>
      viaService(() =>
        api.request(`${base}/leads`, {
          searchParams: listParams(query),
          schema: pageOf(LeadListItemSchema),
        }),
      ),

    leadGet: (id: string) =>
      viaService(() => api.request(`${base}/leads/${id}`, { schema: LeadSchema })),

    leadCreate: (input: LeadCreate) =>
      viaService(() =>
        api.request(`${base}/leads`, {
          method: 'POST',
          body: input,
          // The full lead, not the list shape: the caller goes straight to the
          // detail screen to keep working it.
          schema: LeadSchema,
        }),
      ),

    leadUpdate: (id: string, input: LeadUpdate) =>
      viaService(() =>
        api.request(`${base}/leads/${id}`, {
          method: 'PATCH',
          body: input,
          schema: LeadListItemSchema,
        }),
      ),

    /**
     * Attach a PDF proposal to a lead (Matt, 5:53).
     *
     * ── Three steps, and why the bytes do not go through the API ──────────
     * §6A.10 #9: uploads are presigned and direct to S3. So the API is told
     * ABOUT the file and answers with a signed URL; the browser PUTs the bytes
     * straight to storage; then the lead is re-read so the caller gets the
     * server's own record of the attachment rather than one assembled here.
     *
     * The third call is worth it. Constructing the `LeadAttachment` locally
     * would mean inventing `uploadedAt` and `url`, and a list rendering a
     * client-guessed timestamp beside server-written ones is a list that
     * disagrees with itself after a refresh.
     */
    leadAttach: async (leadId: string, file: File): Promise<LeadAttachment> => {
      const { attachmentId, upload } = await viaService(() =>
        api.request(`${base}/leads/${leadId}/attachments`, {
          method: 'POST',
          body: { fileName: file.name, contentType: file.type, sizeBytes: file.size },
          schema: AttachResponseSchema,
        }),
      );

      // Straight to storage — this one request does NOT go through the api
      // client, because it is not going to the API.
      const stored = await fetch(upload.uploadUrl, {
        method: 'PUT',
        headers: upload.headers,
        body: file,
      }).catch(() => null);

      if (!stored?.ok) {
        throw new ServiceError('UNEXPECTED', 'The file could not be uploaded');
      }

      const lead = await viaService(() =>
        api.request(`${base}/leads/${leadId}`, { schema: LeadSchema }),
      );

      const attachment = lead.attachments.find((row) => row.id === attachmentId);
      if (!attachment) {
        throw new ServiceError('UNEXPECTED', 'The attachment was not recorded');
      }

      return LeadAttachmentSchema.parse(attachment);
    },

    leadDetach: async (leadId: string, attachmentId: string) => {
      await viaService(() =>
        api.request(`${base}/leads/${leadId}/attachments/${attachmentId}`, {
          method: 'DELETE',
          schema: NoContentSchema,
        }),
      );
    },

    leadConvert: (id: string, input: LeadConversion) =>
      viaService(() =>
        api.request(`${base}/leads/${id}/convert`, {
          method: 'POST',
          body: input,
          schema: z.object({ accountId: ObjectIdSchema, customerCode: z.string() }),
        }),
      ),
  };
}
