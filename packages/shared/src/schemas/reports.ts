import * as z from 'zod';
import {
  IsoDateSchema,
  IsoDateTimeSchema,
  MoneySchema,
  NonEmptyStringSchema,
  ObjectIdSchema,
} from './primitives.js';
import { ZoneSchema } from './party.js';

/**
 * Reporting (M9.1–M9.3, M9.6) and diversion certificates (M9.5 · F52 · W15).
 *
 * ── Fixed reports, not a report builder ────────────────────────────────────
 * F31 (custom report builder) and W9/W11 (reporting settings and templates) are
 * v1.1, and Risk 5 names the WYSIWYG designer as *"the biggest single scope
 * trap"* in the project. So this contract describes a small set of named reports
 * with parameters — and nothing that could grow into a designer.
 *
 * M9.1 is **parity, not an improvement**: they produce the monthly pickup volume
 * report today and send it to customers, and at least one customer requires it.
 * It has to exist on day 20.
 */

/** The parameters every report accepts. Not every report reads every one. */
export const ReportFiltersSchema = z
  .object({
    from: IsoDateSchema,
    to: IsoDateSchema,
    accountId: ObjectIdSchema.nullable(),
    /**
     * Narrow to one suburb.
     *
     * Was `siteId` until sites were removed (Matt, 0:29). A suburb is the
     * closest thing left, and it is what the office actually asks about — "how
     * much came out of Kellyville last month" rather than "out of lot 214".
     */
    suburb: z.string().nullable(),
    /**
     * ⚠️ A plain string, not an id schema.
     *
     * It IS a zone id, but report filters live in the URL — and a bookmark
     * taken before zones became records carries `?zoneId=sydney`. Refusing that
     * shape would answer a saved report with a 422 about a field nobody typed;
     * the repository ignores anything that is not an id and returns the
     * unfiltered report instead.
     */
    zoneId: z.string().trim().max(40).nullable(),
    driverId: ObjectIdSchema.nullable(),
  })
  .meta({ id: 'ReportFilters' });

/** M9.1 — one row per customer (or per site when a customer is selected). */
export const VolumeRowSchema = z
  .object({
    key: NonEmptyStringSchema,
    label: NonEmptyStringSchema,
    jobs: z.number().int().nonnegative(),
    areaM2: z.number().nonnegative(),
    /** Only populated for accounts that capture weight (M2.3). */
    weightKg: z.number().nonnegative().nullable(),
    bags: z.number().int().nonnegative(),
    chargesExGst: MoneySchema,
  })
  .meta({ id: 'VolumeRow' });

export const MonthlyVolumePointSchema = z
  .object({
    month: NonEmptyStringSchema,
    jobs: z.number().int().nonnegative(),
    areaM2: z.number().nonnegative(),
  })
  .meta({ id: 'MonthlyVolumePoint' });

export const MonthlyVolumeReportSchema = z
  .object({
    filters: ReportFiltersSchema,
    rows: z.array(VolumeRowSchema),
    byMonth: z.array(MonthlyVolumePointSchema),
    totalJobs: z.number().int().nonnegative(),
    totalAreaM2: z.number().nonnegative(),
    totalChargesExGst: MoneySchema,
  })
  .meta({ id: 'MonthlyVolumeReport' });

/** M9.3 — the Sydney / Wollongong / Newcastle split. */
export const ZoneVolumeRowSchema = z
  .object({
    zoneId: ZoneSchema,
    /** The zone's name. Was the raw slug, which read as a name only by luck. */
    label: NonEmptyStringSchema,
    jobs: z.number().int().nonnegative(),
    areaM2: z.number().nonnegative(),
    revenueExGst: MoneySchema,
    /** Zone mix drives margin, because rate and drive distance both vary. */
    averageJobValueExGst: MoneySchema,
  })
  .meta({ id: 'ZoneVolumeRow' });

export const ZoneVolumeReportSchema = z
  .object({
    filters: ReportFiltersSchema,
    rows: z.array(ZoneVolumeRowSchema),
    totalJobs: z.number().int().nonnegative(),
    totalRevenueExGst: MoneySchema,
  })
  .meta({ id: 'ZoneVolumeReport' });

/**
 * M9.6 — the financial summary, restored to scope.
 *
 * Reproduces the margin figure Matt reads today, which applies a flat $100
 * "Reporting Cost (Pickup Rate)" per job (M6.8). Stated as an assumption on the
 * screen rather than presented as a measured cost, because that is what it is.
 */
export const FinancialRowSchema = z
  .object({
    key: NonEmptyStringSchema,
    label: NonEmptyStringSchema,
    jobs: z.number().int().nonnegative(),
    baseRevenueExGst: MoneySchema,
    additionalServicesExGst: MoneySchema,
    totalRevenueExGst: MoneySchema,
    assumedCostExGst: MoneySchema,
    marginExGst: MoneySchema,
    marginPercent: z.number(),
  })
  .meta({ id: 'FinancialRow' });

export const FinancialReportSchema = z
  .object({
    filters: ReportFiltersSchema,
    /** Grouped by account, then the same shape grouped by zone. */
    byAccount: z.array(FinancialRowSchema),
    byZone: z.array(FinancialRowSchema),
    assumedCostPerJobExGst: MoneySchema,
    totalRevenueExGst: MoneySchema,
    totalMarginExGst: MoneySchema,
  })
  .meta({ id: 'FinancialReport' });

/**
 * M9.5 · F52 — the diversion certificate.
 *
 * ⚠️ Two things this contract is careful about, both from the scope:
 *
 *  1. **The tonnage is the RECOVERED weight**, reconciled against the tip-off
 *     weighbridge total (M4.4) — NOT derived from the m² used for pricing. These
 *     documents go into builders' Green Star and NABERS submissions and have to
 *     be defensible under audit.
 *  2. **Both m² and tonnage appear**, in Matt's own words: *"Your job of X amount
 *     of square metres had X amount of waste, and that has been successfully
 *     diverted from landfill."*
 *
 * ð Still blocked on a sample from Matt (Q35) before the exact data points and
 * wording are fixed, so the screen says so rather than inventing a layout.
 */
export const CERTIFICATE_SCOPES = ['job', 'site', 'account', 'period'] as const;
export const CertificateScopeSchema = z.enum(CERTIFICATE_SCOPES).meta({ id: 'CertificateScope' });
export type CertificateScope = z.infer<typeof CertificateScopeSchema>;

export const CERTIFICATE_SCOPE_LABELS: Record<CertificateScope, string> = {
  job: 'Single job',
  site: 'Site',
  account: 'Whole account',
  period: 'Date range',
};

export const CERTIFICATE_STATES = ['draft', 'issued'] as const;
export const CertificateStateSchema = z.enum(CERTIFICATE_STATES).meta({ id: 'CertificateState' });
export type CertificateState = z.infer<typeof CertificateStateSchema>;

/**
 * How the tonnage on a certificate was arrived at.
 *
 * ⚠️ Only `weighed` is ever issued today, and that is a COMPLIANCE decision,
 * not an oversight. Matt, 32:11: *"this is only for weighed jobs. If it's an
 * estimated job, we're unable to provide a certificate because it's an
 * estimated weight and it doesn't meet compliance regulation."*
 *
 * `apportioned` — a hand-load's share of the weighbridge remainder, split by m²
 * (M4.4) — is named here anyway, for two reasons. It is the value the certificate
 * would carry if that rule is ever relaxed, and naming it is what lets the
 * eligibility filter be a comparison against a documented enum rather than a bare
 * string nobody can look up. The basis is FROZEN onto the certificate rather than
 * read back off the job, so a reprint in five years still says what it was based
 * on even after a late reconciliation has moved the job.
 */
export const CERTIFICATE_WEIGHT_BASES = ['weighed', 'apportioned'] as const;
export const CertificateWeightBasisSchema = z
  .enum(CERTIFICATE_WEIGHT_BASES)
  .meta({ id: 'CertificateWeightBasis' });
export type CertificateWeightBasis = z.infer<typeof CertificateWeightBasisSchema>;

/** What the method line on the document reads. */
export const CERTIFICATE_WEIGHT_BASIS_LABELS: Record<CertificateWeightBasis, string> = {
  weighed: 'Weighed — calibrated crane scale on collection',
  apportioned: 'Apportioned from the weighbridge docket by area',
};

export const CertificateSchema = z
  .object({
    id: ObjectIdSchema,
    reference: NonEmptyStringSchema,
    scope: CertificateScopeSchema,
    state: CertificateStateSchema,
    accountId: ObjectIdSchema,
    accountName: NonEmptyStringSchema,
    /** Set when the scope is a single site or job. */
    siteName: z.string().nullable(),
    /**
     * The site as it is printed — an auditor matches the certificate to a
     * development by its address, not by whatever the site was nicknamed.
     */
    siteAddress: z.string().nullable(),
    jobNumber: z.number().int().positive().nullable(),
    /** The day the material left the site. Null on a multi-job certificate. */
    collectedOn: IsoDateSchema.nullable(),
    periodFrom: IsoDateSchema,
    periodTo: IsoDateSchema,
    jobs: z.number().int().nonnegative(),
    /**
     * Null where no job in scope has a recorded area — a fixed-price builder's
     * POs carry none (Matt, 31:04). The certificate is still valid: the figure
     * that matters on it is `tonnesDiverted`, which comes from the weighbridge.
     */
    areaM2: z.number().nonnegative().nullable(),
    /** From the tip-off reconciliation, not from the priced m². */
    tonnesDiverted: z.number().nonnegative(),

    /* ── The audit trail, frozen at preparation ─────────────────────────── */

    /** How the tonnage was measured. See `CertificateWeightBasisSchema`. */
    weightBasis: CertificateWeightBasisSchema,
    /**
     * The weighbridge docket the load was tipped against.
     *
     * Null where the run has no docket recorded yet. It is evidence the material
     * reached a facility, which is the half of "diverted from landfill" the
     * crane scale on its own cannot show.
     */
    docketNumber: z.string().nullable(),
    /** When the load was tipped, as distinct from when it was collected. */
    tippedOffAt: IsoDateTimeSchema.nullable(),

    issuedAt: IsoDateTimeSchema.nullable(),
    issuedTo: z.string().nullable(),
    /** Who pressed Issue. Printed on the document, so the office owns it. */
    issuedByName: z.string().nullable(),
    /**
     * Whether the rendered PDF exists in storage.
     *
     * A boolean rather than the key: the key is an internal storage path, and a
     * customer's browser has no business knowing the bucket layout. Downloads go
     * through an endpoint that mints a short-lived link.
     */
    hasPdf: z.boolean(),
  })
  .meta({ id: 'Certificate' });

export type ReportFilters = z.infer<typeof ReportFiltersSchema>;
export type VolumeRow = z.infer<typeof VolumeRowSchema>;
export type MonthlyVolumePoint = z.infer<typeof MonthlyVolumePointSchema>;
export type MonthlyVolumeReport = z.infer<typeof MonthlyVolumeReportSchema>;
export type ZoneVolumeRow = z.infer<typeof ZoneVolumeRowSchema>;
export type ZoneVolumeReport = z.infer<typeof ZoneVolumeReportSchema>;
export type FinancialRow = z.infer<typeof FinancialRowSchema>;
export type FinancialReport = z.infer<typeof FinancialReportSchema>;
export type Certificate = z.infer<typeof CertificateSchema>;
