import * as z from 'zod';
import {
  IsoDateSchema,
  IsoDateTimeSchema,
  MoneySchema,
  NonEmptyStringSchema,
  ObjectIdSchema,
} from './primitives.js';
import { BrandIdSchema, ZoneSchema } from './party.js';

/**
 * Jobs (M2, M4, M6).
 *
 * ── The status set is deliberately small ───────────────────────────────────
 * These are the six statuses actually used across all 5,079 production jobs,
 * plus the one we add. **We are not building a 20-state machine nobody uses.**
 *
 *   booked → assigned → acknowledged → in-transit → arrived → completed
 *                                                        → admin-complete
 *   exception branch: futile
 *
 * `arrived` does not exist in TransVirtual but the workflow depends on it: it
 * triggers the Site Risk Assessment and starts the job clock — "the time
 * between Arrived and Complete Job, that's the logged time for that job" —
 * which is almost certainly the basis of the Extra Load Time charge.
 *
 * `booked` covers the pre-allocation state the office sees as "unallocated";
 * `cancelled` is the M2.4 cancel-with-reason outcome.
 */
export const JOB_STATUSES = [
  'booked',
  'assigned',
  'acknowledged',
  'in-transit',
  'arrived',
  'completed',
  'admin-complete',
  'futile',
  'cancelled',
] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES).meta({ id: 'JobStatus' });
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  booked: 'Booked',
  assigned: 'Assigned',
  acknowledged: 'Acknowledged',
  'in-transit': 'En route',
  arrived: 'On site',
  completed: 'Completed',
  'admin-complete': 'Admin complete',
  futile: 'Futile',
  cancelled: 'Cancelled',
};

/** Statuses that are still in play — the office's working set. */
export const OPEN_JOB_STATUSES: readonly JobStatus[] = [
  'booked',
  'assigned',
  'acknowledged',
  'in-transit',
  'arrived',
];

export const SERVICE_LEVELS = ['standard', 'urgent'] as const;
export const ServiceLevelSchema = z.enum(SERVICE_LEVELS).meta({ id: 'ServiceLevel' });
export type ServiceLevel = z.infer<typeof ServiceLevelSchema>;

/** The freight items in current use, including the hooklift bins. */
export const FREIGHT_ITEMS = [
  'plasterboard-bagged',
  'plasterboard-hand-load',
  'hook-bin-5',
  'hook-bin-10',
  'hook-bin-15',
] as const;
export const FreightItemSchema = z.enum(FREIGHT_ITEMS).meta({ id: 'FreightItem' });
export type FreightItem = z.infer<typeof FreightItemSchema>;

export const FREIGHT_ITEM_LABELS: Record<FreightItem, string> = {
  'plasterboard-bagged': 'Plasterboard — bagged',
  'plasterboard-hand-load': 'Plasterboard — hand load',
  'hook-bin-5': 'Hook bin 5 m³',
  'hook-bin-10': 'Hook bin 10 m³',
  'hook-bin-15': 'Hook bin 15 m³',
};

/**
 * M2.5 — structured reason codes, never free text, so delays become reportable
 * and chargeable where the customer certified otherwise.
 */
export const EXCEPTION_REASONS = [
  'site-not-ready',
  'access-blocked',
  'crane-unavailable',
  'nobody-on-site',
  'site-closed',
  'weather',
  'customer-request',
  'other',
] as const;
export const ExceptionReasonSchema = z.enum(EXCEPTION_REASONS).meta({ id: 'ExceptionReason' });
export type ExceptionReason = z.infer<typeof ExceptionReasonSchema>;

export const EXCEPTION_REASON_LABELS: Record<ExceptionReason, string> = {
  'site-not-ready': 'Site not ready',
  'access-blocked': 'Truck access blocked',
  'crane-unavailable': 'Crane unavailable',
  'nobody-on-site': 'Nobody on site',
  'site-closed': 'Site closed',
  weather: 'Weather',
  'customer-request': 'Customer request',
  other: 'Other',
};

/** M6.5 — all nine additional services, fixed and percentage. */
export const CHARGE_CODES = [
  'service-fee',
  'area-charge',
  'recycling-bags',
  'contamination',
  'extra-load-time',
  'futile-pickup',
  'fuel-levy',
  'fuel-levy-wisdom',
  'fuel-levy-percent',
  'tipping-fuel-levy-percent',
  'out-of-area',
] as const;
export const ChargeCodeSchema = z.enum(CHARGE_CODES).meta({ id: 'ChargeCode' });
export type ChargeCode = z.infer<typeof ChargeCodeSchema>;

export const CHARGE_CODE_LABELS: Record<ChargeCode, string> = {
  'service-fee': 'Service fee',
  'area-charge': 'Weight charge (per m²)',
  'recycling-bags': 'Recycling bags',
  contamination: 'Contamination charge',
  'extra-load-time': 'Extra load time',
  'futile-pickup': 'Futile pickup',
  'fuel-levy': 'Fuel levy',
  'fuel-levy-wisdom': 'Fuel levy — Wisdom',
  'fuel-levy-percent': 'Fuel levy (10%)',
  'tipping-fuel-levy-percent': 'Tipping fuel levy (7.5%)',
  'out-of-area': 'Out of area',
};

/**
 * M6.6 — charge provenance and approval state.
 *
 * Who raised a charge decides whether it needs approving: `driver` charges queue
 * for office review with photo evidence, `system` charges are auto-generated
 * (Extra Load Time arrives as *Created By: System*), `office` charges are manual.
 */
export const CHARGE_SOURCES = ['office', 'driver', 'system'] as const;
export const ChargeSourceSchema = z.enum(CHARGE_SOURCES).meta({ id: 'ChargeSource' });
export type ChargeSource = z.infer<typeof ChargeSourceSchema>;

export const CHARGE_APPROVAL_STATES = ['not-required', 'pending', 'approved', 'rejected'] as const;
export const ChargeApprovalStateSchema = z
  .enum(CHARGE_APPROVAL_STATES)
  .meta({ id: 'ChargeApprovalState' });
export type ChargeApprovalState = z.infer<typeof ChargeApprovalStateSchema>;

/**
 * One invoice line.
 *
 * `quantity × unitRate = amount` is a functional GAIN over TransVirtual, which
 * cannot render quantities — Matt wants "2 residential recycling bags at $30
 * each, equalling $60". Money is a decimal STRING throughout (§6A.10 #1).
 */
export const JobChargeSchema = z
  .object({
    id: ObjectIdSchema,
    code: ChargeCodeSchema,
    description: NonEmptyStringSchema,
    quantity: z.number(),
    unitRate: MoneySchema,
    amount: MoneySchema,
    source: ChargeSourceSchema,
    approvalState: ChargeApprovalStateSchema,
    raisedBy: z.string().nullable(),
    raisedAt: IsoDateTimeSchema,
    /** Driver-raised charges carry their evidence (M2.7). */
    photoCount: z.number().int().nonnegative(),
    note: z.string().nullable(),
  })
  .meta({ id: 'JobCharge' });

/** M2.3 — the timeline of status changes, with timestamps and actors. */
export const JobEventSchema = z
  .object({
    id: ObjectIdSchema,
    at: IsoDateTimeSchema,
    label: NonEmptyStringSchema,
    actor: z.string(),
    status: JobStatusSchema.nullable(),
    detail: z.string().nullable(),
    /** M4.2 — status changes captured on the driver app carry a position. */
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
  })
  .meta({ id: 'JobEvent' });

export const JobPhotoSchema = z
  .object({
    id: ObjectIdSchema,
    /** Their protocol: front of site · pile before · pile after · site closed · cars on site. */
    caption: NonEmptyStringSchema,
    takenAt: IsoDateTimeSchema,
    takenBy: z.string(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
  })
  .meta({ id: 'JobPhoto' });

export const JobDocumentSchema = z
  .object({
    id: ObjectIdSchema,
    name: NonEmptyStringSchema,
    kind: z.enum(['purchase-order', 'swms', 'risk-assessment', 'weighbridge-docket', 'other']),
    uploadedAt: IsoDateTimeSchema,
    uploadedBy: z.string(),
    sizeKb: z.number().int().positive(),
  })
  .meta({ id: 'JobDocument' });

/**
 * Who can see a comment on a job (M2.11, M8.6).
 *
 * ── Why `driver` is a visibility and not a chat product ───────────────────
 * M8.6 is explicit: *job-scoped comment threads plus push notification, rather
 * than a general chat product*. Full real-time chat (F20) is v1.1. Matt
 * confirmed the shape — *"it's between the office and the driver"* — so there is
 * no driver-to-driver and no group channel, and modelling it as a third
 * visibility on the job keeps the conversation attached to the job it is about.
 * That is better than chat for auditability, which is the point.
 *
 *  • `internal` — office only. The driver never sees it.
 *  • `driver`   — office ↔ the allocated driver. Pushes to their app.
 *  • `customer` — visible in the customer portal.
 */
export const COMMENT_VISIBILITIES = ['internal', 'driver', 'customer'] as const;
export const CommentVisibilitySchema = z
  .enum(COMMENT_VISIBILITIES)
  .meta({ id: 'CommentVisibility' });
export type CommentVisibility = z.infer<typeof CommentVisibilitySchema>;

export const COMMENT_VISIBILITY_LABELS: Record<CommentVisibility, string> = {
  internal: 'Internal',
  driver: 'Driver',
  customer: 'Customer',
};

export const JobCommentSchema = z
  .object({
    id: ObjectIdSchema,
    body: NonEmptyStringSchema,
    author: NonEmptyStringSchema,
    at: IsoDateTimeSchema,
    visibility: CommentVisibilitySchema,
    /**
     * M8.6 — a driver comment carries a push state, because "did they get it"
     * is the first question anyone asks about a message to someone on the road.
     * Null on internal and customer comments, which are not pushed to an app.
     */
    deliveredAt: IsoDateTimeSchema.nullable(),
    /** True when the driver wrote it, so the thread reads as a conversation. */
    fromDriver: z.boolean(),
  })
  .meta({ id: 'JobComment' });

/** What the comment box submits. */
export const JobCommentDraftSchema = z
  .object({
    body: z.string().trim().min(1, 'Write something before posting').max(2000),
    visibility: CommentVisibilitySchema,
  })
  .meta({ id: 'JobCommentDraft' });

/**
 * M4.8b — where an assessment has got to in the five-step sequence.
 *
 * Declared in THIS module rather than beside the rest of the driver schemas,
 * because `driver.ts` imports from here and the reverse would be a cycle.
 */
export const SRA_STEP_STATES = ['pending', 'queued', 'uploaded', 'failed'] as const;
export const SraUploadStateSchema = z.enum(SRA_STEP_STATES).meta({ id: 'SraUploadState' });
export type SraUploadState = z.infer<typeof SraUploadStateSchema>;

/**
 * M4.8 — the compliance record the office can READ BACK.
 *
 * ── Why this exists as its own block on the job ───────────────────────────
 * The driver already fills in a pre-start checklist and, on some sites, a Site
 * Risk Assessment. Both were write-only: the forms went into the outbox and
 * there was no screen anywhere in the console that showed whether they had been
 * done. For a Chain of Responsibility obligation that is the wrong way round —
 * the record's whole purpose is being produced when someone asks for it.
 *
 * ── Why it is NOT in the timeline ─────────────────────────────────────────
 * `events` answers "what happened, in order". This answers "was the obligation
 * met", which is a different question asked by different people at different
 * times — usually an auditor or a builder, months later. Burying it in a
 * chronological feed would mean scrolling to prove a negative.
 */
export const JobPreStartRecordSchema = z
  .object({
    completedAt: IsoDateTimeSchema,
    driverName: NonEmptyStringSchema,
    vehicleRego: z.string(),
    odometerKm: z.number().int().nonnegative(),
    /**
     * Only the items the driver marked FAIL, with their note.
     *
     * Deliberately not all fourteen: a wall of green ticks is noise, and the
     * office is looking for the one line that says the brakes felt soft. The
     * count of everything checked is `itemsChecked`.
     */
    failedItems: z.array(
      z.object({
        key: NonEmptyStringSchema,
        label: NonEmptyStringSchema,
        note: z.string(),
      }),
    ),
    itemsChecked: z.number().int().nonnegative(),
  })
  .meta({ id: 'JobPreStartRecord' });

export const JobRiskAssessmentRecordSchema = z
  .object({
    completedAt: IsoDateTimeSchema,
    driverName: NonEmptyStringSchema,
    /** Resolved to labels here — the office should not need the key table. */
    hazards: z.array(NonEmptyStringSchema),
    controls: z.array(NonEmptyStringSchema),
    note: z.string(),
    /** False means the driver judged the site unsafe and stopped. */
    safeToProceed: z.boolean(),
    swmsVersion: NonEmptyStringSchema,
    /** Scanned off the site fence. Null where the site has no QR sign. */
    builderPortalCode: z.string().nullable(),
    /** Step 5 of the five-step workflow — the handoff to the builder's portal. */
    uploadState: SraUploadStateSchema,
  })
  .meta({ id: 'JobRiskAssessmentRecord' });

export const JobComplianceSchema = z
  .object({
    /**
     * Resolved from the account default and the site's override at the moment
     * the job was created — NOT read live.
     *
     * A job completed in March must still show the rule that applied in March;
     * re-deriving it from today's settings would silently rewrite history and
     * make a past job look non-compliant because a flag changed since.
     */
    riskAssessmentRequired: z.boolean(),
    riskAssessment: JobRiskAssessmentRecordSchema.nullable(),
    preStart: JobPreStartRecordSchema.nullable(),
  })
  .meta({ id: 'JobCompliance' });

/** The grid row. Kept deliberately flat — a list must not need a join to render. */
export const JobListItemSchema = z
  .object({
    id: ObjectIdSchema,
    /** M1.4 — continues the existing sequence from ~61,300. */
    jobNumber: z.number().int().positive(),
    status: JobStatusSchema,
    brandId: BrandIdSchema,
    accountId: ObjectIdSchema,
    accountName: NonEmptyStringSchema,
    builderName: z.string(),
    siteId: ObjectIdSchema,
    siteName: NonEmptyStringSchema,
    suburb: NonEmptyStringSchema,
    zone: ZoneSchema,
    customerReference: z.string().nullable(),
    poNumber: z.string().nullable(),
    readyDate: IsoDateSchema,
    /** M2.4a — ready date + 5 business days. */
    targetDate: IsoDateSchema,
    serviceLevel: ServiceLevelSchema,
    driverId: ObjectIdSchema.nullable(),
    driverName: z.string().nullable(),
    expectedAreaM2: z.number().nonnegative(),
    recoveredWeightKg: z.number().nonnegative().nullable(),
    bagCount: z.number().int().nonnegative(),
    totalExGst: MoneySchema,
    invoiceStatus: z.enum(['not-invoiced', 'awaiting-po', 'invoiced', 'paid']),
    hasPendingCharges: z.boolean(),
    completedAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'JobListItem' });

export const JobSchema = JobListItemSchema.extend({
  freightItem: FreightItemSchema,
  notes: z.string(),
  exceptionReason: ExceptionReasonSchema.nullable(),
  exceptionNote: z.string().nullable(),
  /** M4.2 — Arrived → Complete is the logged on-site duration. */
  arrivedAt: IsoDateTimeSchema.nullable(),
  onSiteMinutes: z.number().int().nonnegative().nullable(),
  charges: z.array(JobChargeSchema),
  events: z.array(JobEventSchema),
  photos: z.array(JobPhotoSchema),
  documents: z.array(JobDocumentSchema),
  comments: z.array(JobCommentSchema),
  invoiceNumber: z.number().int().positive().nullable(),
  invoicedAt: IsoDateTimeSchema.nullable(),
  gst: MoneySchema,
  totalIncGst: MoneySchema,
  /** M4.8 — the safety record, readable by the office. */
  compliance: JobComplianceSchema,
}).meta({ id: 'Job' });

/**
 * M2.1 — what the create-job form collects.
 *
 * Account, builder and site are IDs from pickers, not free text — the field
 * being free text today is exactly why leads arrive disguised as jobs.
 */
export const JobDraftSchema = z
  .object({
    accountId: ObjectIdSchema,
    siteId: ObjectIdSchema,
    customerReference: z.string().trim().max(60),
    poNumber: z.string().trim().max(60),
    readyDate: IsoDateSchema,
    serviceLevel: ServiceLevelSchema,
    freightItem: FreightItemSchema,
    expectedAreaM2: z.number().nonnegative().max(100000),
    bagCount: z.number().int().nonnegative().max(200),
    notes: z.string().trim().max(2000),
  })
  .meta({ id: 'JobDraft' });

/**
 * M2.1 / M6.9 — the price shown BEFORE saving.
 *
 * "Estimated $356.80 ex GST — Sydney zone, $220 service + 855 m² × $0.16." That
 * figure is real: it is invoice 104071, reproduced to the cent.
 *
 * ⚠️ The frontend never computes this. Pricing is a three-dimensional,
 * effective-dated lookup with per-component overrides, and it must match
 * TransVirtual to the cent (Risk 1) — so it is resolved server-side and the UI
 * only renders the answer. A second implementation in the browser would be a
 * second thing to keep correct.
 */
export const PricePreviewLineSchema = z
  .object({
    code: ChargeCodeSchema,
    description: NonEmptyStringSchema,
    quantity: z.number(),
    unitRate: MoneySchema,
    amount: MoneySchema,
  })
  .meta({ id: 'PricePreviewLine' });

export const PricePreviewSchema = z
  .object({
    zone: ZoneSchema,
    rateCardLabel: NonEmptyStringSchema,
    lines: z.array(PricePreviewLineSchema),
    subtotalExGst: MoneySchema,
    gst: MoneySchema,
    totalIncGst: MoneySchema,
    /** Set when the estimate is provisional — e.g. rates not yet effective. */
    caveat: z.string().nullable(),
  })
  .meta({ id: 'PricePreview' });

export type JobCharge = z.infer<typeof JobChargeSchema>;
export type JobEvent = z.infer<typeof JobEventSchema>;
export type JobPhoto = z.infer<typeof JobPhotoSchema>;
export type JobDocument = z.infer<typeof JobDocumentSchema>;
export type JobComment = z.infer<typeof JobCommentSchema>;
export type JobCommentDraft = z.infer<typeof JobCommentDraftSchema>;
export type JobListItem = z.infer<typeof JobListItemSchema>;
export type Job = z.infer<typeof JobSchema>;
export type JobCompliance = z.infer<typeof JobComplianceSchema>;
export type JobPreStartRecord = z.infer<typeof JobPreStartRecordSchema>;
export type JobRiskAssessmentRecord = z.infer<typeof JobRiskAssessmentRecordSchema>;
export type JobDraft = z.infer<typeof JobDraftSchema>;
export type PricePreviewLine = z.infer<typeof PricePreviewLineSchema>;
export type PricePreview = z.infer<typeof PricePreviewSchema>;
