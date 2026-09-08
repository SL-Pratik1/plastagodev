import { LeadSourceSchema, LeadStatusSchema, ObjectIdSchema, ZoneSchema } from '@plastago/shared';
import * as z from 'zod';

/**
 * Request shapes that belong to the transport rather than the domain.
 *
 * `LeadCreate`, `LeadUpdate` and `LeadConversion` live in `@plastago/shared`
 * because the console and the public enquiry form must agree on them.
 */

export const LeadIdParamsSchema = z.object({ id: ObjectIdSchema }).meta({ id: 'LeadIdParams' });

export const LeadAttachmentParamsSchema = z
  .object({ id: ObjectIdSchema, attachmentId: ObjectIdSchema })
  .meta({ id: 'LeadAttachmentParams' });

export const ListLeadsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    sort: z.string().trim().max(40).optional(),
    q: z.string().trim().max(120).optional(),
    status: LeadStatusSchema.optional(),
    source: LeadSourceSchema.optional(),
    /**
     * `null` is a real value here — it finds leads outside the three
     * serviceable zones, which is a list somebody genuinely wants.
     */
    zone: ZoneSchema.or(z.literal('none').transform(() => null)).optional(),
    owner: z.string().trim().max(80).optional(),
    /** Converted leads are history and stay hidden unless asked for. */
    includeConverted: z.coerce.boolean().optional(),
    agedOverDays: z.coerce.number().int().min(0).max(365).optional(),
  })
  .meta({ id: 'ListLeadsQuery' });

/**
 * Asking for somewhere to put a proposal.
 *
 * The bytes never reach this API — the browser PUTs them to object storage with
 * the presigned URL returned here, the same path as a driver's photo.
 */
export const AttachLeadFileSchema = z
  .object({
    fileName: z.string().trim().min(1, 'The file needs a name').max(200),
    contentType: z.string().trim().min(1),
    sizeBytes: z.number().int().positive(),
  })
  .meta({ id: 'AttachLeadFile' });
