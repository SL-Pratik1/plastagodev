import {
  ExtractedFieldSchema,
  ObjectIdSchema,
  PoReviewReasonSchema,
  PoReviewStateSchema,
} from '@plastago/shared';
import * as z from 'zod';

export const ExtractionIdParamsSchema = z
  .object({ id: ObjectIdSchema })
  .meta({ id: 'ExtractionIdParams' });

export const ListExtractionsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    q: z.string().trim().max(120).optional(),
    state: PoReviewStateSchema.optional(),
    /** Filtering by WHY it needs review — the reasons need different fixes. */
    reason: PoReviewReasonSchema.optional(),
    agedOverDays: z.coerce.number().int().min(0).max(365).optional(),
  })
  .meta({ id: 'ListExtractionsQuery' });

export const RejectExtractionSchema = z
  .object({
    /** Required: the rejections are the training data. See the service. */
    note: z
      .string()
      .trim()
      .min(1, 'Say why this is being rejected')
      .max(500),
  })
  .meta({ id: 'RejectExtraction' });

/**
 * The extractor's callback body (I6).
 *
 * ⚠️ Only `extractionId` is read, and that is the design rather than an
 * oversight. The vendor sends the extracted fields inline; acting on them would
 * let an unauthenticated request decide what appears in front of the office. The
 * handler takes the id and re-fetches the document with our own credentials.
 *
 * `event` is accepted and ignored so a vendor that adds a new event type does
 * not start failing validation on a route it retries.
 *
 * Everything else is `.loose()` — the payload is documented loosely and will
 * grow, and a callback rejected for carrying an extra field is a purchase order
 * that never reaches the queue.
 */
const ExtractionIdSchema = z.string().trim().min(1).max(64);

export const ExtractorWebhookSchema = z
  .looseObject({
    /** The vendor's Mongo id for the extraction. The only field acted upon. */
    extractionId: ExtractionIdSchema.optional(),
    event: z.string().trim().max(60).optional(),

    /**
     * The APPLICATION webhook's envelope.
     *
     * ⚠️ The vendor has two webhook kinds and they do not agree on shape. One
     * registered against the tenant posts `{ extractionId }` at the top level;
     * one registered in the Admin Dashboard against the Application posts
     * `{ data: { extractionId, type, … }, error }`. The same extraction, the
     * same handler, two envelopes — and nothing in the vendor's own guide says
     * so, because it documents only the first.
     *
     * Both are accepted because which kind is registered is an operational
     * choice made in someone else's UI, months from now, by somebody who will
     * not think to check which shape this file expects.
     *
     * `nullish` rather than `optional`: the envelope carries a sibling `error`
     * field, and a failed notification sends `data: null`.
     */
    data: z
      .looseObject({
        extractionId: ExtractionIdSchema.optional(),
        type: z.string().trim().max(60).optional(),
      })
      .nullish(),
  })
  .transform((body, ctx) => {
    const extractionId = body.extractionId ?? body.data?.extractionId;

    if (!extractionId) {
      ctx.addIssue({
        code: 'custom',
        path: ['extractionId'],
        message: 'Expected extractionId, either at the top level or inside data',
      });
      return z.NEVER;
    }

    /*
     * Normalised here so the controller sees one shape. `type` is the
     * application envelope's name for what the tenant envelope calls `event`;
     * both are accepted and ignored, for the same reason as before — a vendor
     * adding an event kind must not start failing a route it retries.
     */
    return { extractionId, event: body.event ?? body.data?.type };
  })
  .meta({ id: 'ExtractorWebhook' });

/**
 * What an external extractor posts (M2.12).
 *
 * ⚠️ Everything here is a CLAIM. `state` and `reason` are deliberately absent —
 * the caller is a model, and letting it declare its own output trustworthy
 * would put it in charge of whether a human ever looks. The server decides.
 */
export const IngestExtractionSchema = z
  .object({
    fromAddress: z.string().trim().min(1).max(200),
    subject: z.string().trim().min(1).max(300),
    receivedAt: z.iso.datetime(),
    attachmentName: z.string().trim().min(1).max(200),
    pageCount: z.number().int().min(1).max(200),
    storageKey: z.string().trim().max(400).nullable(),
    documentText: z.string().max(200_000).default(''),

    poNumber: z.string().trim().max(60).nullable(),
    amountExGst: z
      .string()
      .regex(/^-?\d+(\.\d{1,4})?$/, 'Money must be a decimal string')
      .nullable(),

    extractedAreaM2: z.number().nonnegative().max(100_000).nullable(),
    extractedBagAllowance: z.number().int().nonnegative().max(200).nullable(),
    extractedSiteAddress: z.string().trim().max(200).nullable(),
    extractedLotNumber: z.string().trim().max(30).nullable(),
    extractedSupervisorName: z.string().trim().max(80).nullable(),
    extractedSupervisorMobile: z.string().trim().max(20).nullable(),

    /*
     * Constrained to the fields the contract names — exactly what Matt read off
     * the Domain order at 28:12. An extractor sending a key nobody acts on is a
     * contract violation it should hear about at the boundary, rather than a
     * value that lands in the database and is silently never displayed.
     */
    fields: z.array(ExtractedFieldSchema).max(50).default([]),

    suggestedAccountId: ObjectIdSchema.nullable(),
    suggestedAccountName: z.string().trim().max(120).nullable(),
    suggestedJobId: ObjectIdSchema.nullable(),
    suggestedJobNumber: z.number().int().positive().nullable(),

    accountCandidates: z
      .array(
        z.object({
          id: z.string().trim().min(1),
          label: z.string().trim().min(1).max(120),
          detail: z.string().max(200).default(''),
        }),
      )
      .max(20)
      .default([]),
    jobCandidates: z
      .array(
        z.object({
          id: z.string().trim().min(1),
          label: z.string().trim().min(1).max(120),
          detail: z.string().max(200).default(''),
        }),
      )
      .max(20)
      .default([]),

  })
  .meta({ id: 'IngestExtraction' });
