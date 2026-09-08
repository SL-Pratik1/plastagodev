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
          confidence: z.number().min(0).max(1),
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
          confidence: z.number().min(0).max(1),
        }),
      )
      .max(20)
      .default([]),

    overallConfidence: z.number().min(0).max(1),
  })
  .meta({ id: 'IngestExtraction' });
