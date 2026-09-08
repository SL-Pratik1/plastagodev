import {
  CertificateScopeSchema,
  IsoDateSchema,
  ObjectIdSchema,
  ZoneSchema,
} from '@plastago/shared';
import * as z from 'zod';

/**
 * Request shapes that belong to the transport rather than the domain.
 *
 * ⚠️ Notice what is NOT here: any shape that could describe an arbitrary
 * query. Every report is named and takes the same fixed filters — F31's report
 * builder is v1.1, and Risk 5 calls the designer the biggest scope trap in the
 * project. A `groupBy` or a `fields[]` parameter is how that starts.
 */

/**
 * The filters every report accepts. Not every report reads every one.
 *
 * Dates are required rather than defaulted: a report with no range is a report
 * over everything, and the office's real questions are months and quarters.
 */
export const ReportFiltersQuerySchema = z
  .object({
    from: IsoDateSchema,
    to: IsoDateSchema,
    accountId: ObjectIdSchema.nullable().default(null),
    /**
     * Was `siteId` until sites were removed (Matt, 0:29). A suburb is what the
     * office actually asks about — "how much came out of Kellyville".
     */
    suburb: z.string().trim().max(80).nullable().default(null),
    zone: ZoneSchema.nullable().default(null),
    driverId: ObjectIdSchema.nullable().default(null),
  })
  .meta({ id: 'ReportFiltersQuery' });

export const CertificateIdParamsSchema = z
  .object({ id: ObjectIdSchema })
  .meta({ id: 'CertificateIdParams' });

export const ListCertificatesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    state: z.enum(['draft', 'issued']).optional(),
  })
  .meta({ id: 'ListCertificatesQuery' });

/**
 * M9.5 — preparing a certificate.
 *
 * `jobId` and `siteName` narrow the scope; both are absent on an account- or
 * period-wide one. The scope field says which reading applies, rather than
 * being inferred from which of the two happens to be set.
 */
export const PrepareCertificateSchema = z
  .object({
    scope: CertificateScopeSchema,
    accountId: ObjectIdSchema,
    from: IsoDateSchema,
    to: IsoDateSchema,
    jobId: ObjectIdSchema.nullable().default(null),
    siteName: z.string().trim().max(120).nullable().default(null),
  })
  .meta({ id: 'PrepareCertificate' });
