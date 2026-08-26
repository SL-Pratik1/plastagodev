import * as z from 'zod';
import {
  IsoDateSchema,
  IsoDateTimeSchema,
  MoneySchema,
  NonEmptyStringSchema,
  ObjectIdSchema,
} from './primitives.js';
import {
  BrandIdSchema,
  CaptureModeSchema,
  PoPolicySchema,
  RateCardIdSchema,
  ZoneSchema,
} from './party.js';
import { ChargeCodeSchema, ExceptionReasonSchema, JobPhotoSchema } from './jobs.js';

/**
 * The five office queues (M2.6, M2.7, M7.3, M2.12, M5 · Journey A).
 *
 * ── Why these are one module and not five ──────────────────────────────────
 * They are the same *shape* of work: something arrived that a human must decide
 * about, it ages while nobody decides, and the deciding is the product. §13.2
 * lists them as four of the twenty-two admin screens plus the onboarding queue,
 * and the dashboard already counts four of them (`QueueSummary`).
 *
 * ── The thing every one of them must do ────────────────────────────────────
 * **Chase.** TransVirtual has the futile queue today and one entry has sat in it
 * since 28 August 2025 — a year, at $120. So every item here carries the
 * timestamp it entered the queue, and every list can be sorted and filtered by
 * age. A count with no age is the bug, not the feature.
 */

/* ── M2.6 · Futile pickup review ──────────────────────────────────────────── */

/**
 * What the office did about a futile pickup.
 *
 * `pending` is the queue. Both outcomes raise the $120 fee — Matt was explicit:
 * *"either way the futile fee applies"* — so the decision is about the JOB, not
 * about the money, and the UI must not imply otherwise.
 */
export const FUTILE_OUTCOMES = ['pending', 'rescheduled', 'cancelled'] as const;
export const FutileOutcomeSchema = z.enum(FUTILE_OUTCOMES).meta({ id: 'FutileOutcome' });
export type FutileOutcome = z.infer<typeof FutileOutcomeSchema>;

export const FUTILE_OUTCOME_LABELS: Record<FutileOutcome, string> = {
  pending: 'Awaiting decision',
  rescheduled: 'Rescheduled',
  cancelled: 'Cancelled',
};

export const FutileReviewItemSchema = z
  .object({
    id: ObjectIdSchema,
    jobId: ObjectIdSchema,
    jobNumber: z.number().int().positive(),
    brandId: BrandIdSchema,
    accountId: ObjectIdSchema,
    accountName: NonEmptyStringSchema,
    builderName: z.string(),
    siteName: NonEmptyStringSchema,
    suburb: NonEmptyStringSchema,
    zone: ZoneSchema,
    driverId: ObjectIdSchema.nullable(),
    driverName: z.string().nullable(),
    reason: ExceptionReasonSchema,
    note: z.string().nullable(),
    /** When the driver marked it futile — the clock the queue ages against. */
    markedAt: IsoDateTimeSchema,
    readyDate: IsoDateSchema,
    photoCount: z.number().int().nonnegative(),
    /** M4.2 — the position the driver was standing in when they marked it. */
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    feeExGst: MoneySchema,
    outcome: FutileOutcomeSchema,
  })
  .meta({ id: 'FutileReviewItem' });

export const FutileReviewSchema = FutileReviewItemSchema.extend({
  photos: z.array(JobPhotoSchema),
  /** Free-text context the office added when deciding. Never the reason itself. */
  decisionNote: z.string().nullable(),
  decidedAt: IsoDateTimeSchema.nullable(),
  decidedBy: z.string().nullable(),
  /** Set when the outcome was `rescheduled`. */
  newReadyDate: IsoDateSchema.nullable(),
}).meta({ id: 'FutileReview' });

/** M2.4 reuses the same structured reasons; a cancel still needs one. */
export const FutileDecisionSchema = z
  .object({
    outcome: z.enum(['rescheduled', 'cancelled']),
    /** Required when rescheduling, ignored when cancelling. */
    newReadyDate: IsoDateSchema.nullable(),
    /** Required when cancelling — M2.4 forbids a bare cancel. */
    cancelReason: ExceptionReasonSchema.nullable(),
    note: z.string().trim().max(500),
  })
  .meta({ id: 'FutileDecision' });

/* ── M2.7 · Additional service approvals ──────────────────────────────────── */

export const ChargeApprovalItemSchema = z
  .object({
    /** The charge's own id — the queue is per charge, not per job. */
    id: ObjectIdSchema,
    jobId: ObjectIdSchema,
    jobNumber: z.number().int().positive(),
    accountId: ObjectIdSchema,
    accountName: NonEmptyStringSchema,
    siteName: NonEmptyStringSchema,
    suburb: NonEmptyStringSchema,
    code: ChargeCodeSchema,
    description: NonEmptyStringSchema,
    quantity: z.number(),
    unitRate: MoneySchema,
    amountExGst: MoneySchema,
    raisedBy: z.string().nullable(),
    raisedAt: IsoDateTimeSchema,
    note: z.string().nullable(),
    photoCount: z.number().int().nonnegative(),
    /**
     * M2.7's closing sentence: an approved charge on a PO-required account moves
     * to the *awaiting PO* queue rather than blocking the main invoice. Shown in
     * the row so the approver knows what approving actually triggers.
     */
    poRequired: z.boolean(),
    /** M4.2 — where the driver was when they raised it. */
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
  })
  .meta({ id: 'ChargeApprovalItem' });

export const ChargeApprovalDetailSchema = ChargeApprovalItemSchema.extend({
  photos: z.array(JobPhotoSchema),
  /** Enough job context to decide without leaving the queue. */
  jobStatus: NonEmptyStringSchema,
  expectedAreaM2: z.number().nonnegative(),
  onSiteMinutes: z.number().int().nonnegative().nullable(),
}).meta({ id: 'ChargeApprovalDetail' });

export const ChargeDecisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    /** Required on reject: the driver is told why, so it must say something. */
    note: z.string().trim().max(500),
  })
  .meta({ id: 'ChargeDecision' });

/* ── M7.3 · Approved charges awaiting a PO ────────────────────────────────── */

export const AwaitingPoItemSchema = z
  .object({
    /** The additional-charges invoice id, so the row links straight to it. */
    id: ObjectIdSchema.or(z.string()),
    invoiceNumber: z.number().int().positive(),
    jobId: ObjectIdSchema,
    jobNumber: z.number().int().positive(),
    accountId: ObjectIdSchema,
    accountName: NonEmptyStringSchema,
    siteName: NonEmptyStringSchema,
    /** Who to chase, and how — the queue exists to produce a phone call. */
    contactName: z.string().nullable(),
    contactEmail: z.string().nullable(),
    totalExGst: MoneySchema,
    totalIncGst: MoneySchema,
    /** The charges holding it up, so the chaser can say what it is for. */
    chargeSummary: NonEmptyStringSchema,
    /** When the charge was approved — the age that matters, not the job date. */
    approvedAt: IsoDateTimeSchema,
    lastChasedAt: IsoDateTimeSchema.nullable(),
    chaseCount: z.number().int().nonnegative(),
  })
  .meta({ id: 'AwaitingPoItem' });

/* ── M2.12 · AI purchase-order review ─────────────────────────────────────── */

/**
 * Why an extraction is sitting in a human queue instead of auto-attaching.
 *
 * Risk 9's first design rule is **never silently guess** — so the reason is a
 * first-class field, shown on the row. "Below threshold" and "no account match"
 * are different problems needing different corrections, and lumping them into
 * one "needs review" state hides that.
 */
export const PO_REVIEW_REASONS = [
  'below-threshold',
  'no-account-match',
  'ambiguous-account',
  'no-job-match',
  'duplicate-po',
] as const;
export const PoReviewReasonSchema = z.enum(PO_REVIEW_REASONS).meta({ id: 'PoReviewReason' });
export type PoReviewReason = z.infer<typeof PoReviewReasonSchema>;

export const PO_REVIEW_REASON_LABELS: Record<PoReviewReason, string> = {
  'below-threshold': 'Low OCR confidence',
  'no-account-match': 'No matching account',
  'ambiguous-account': 'More than one account matches',
  'no-job-match': 'No matching job',
  'duplicate-po': 'PO number already used',
};

export const PO_REVIEW_STATES = ['needs-review', 'confirmed', 'rejected'] as const;
export const PoReviewStateSchema = z.enum(PO_REVIEW_STATES).meta({ id: 'PoReviewState' });
export type PoReviewState = z.infer<typeof PoReviewStateSchema>;

export const PO_REVIEW_STATE_LABELS: Record<PoReviewState, string> = {
  'needs-review': 'Needs review',
  confirmed: 'Confirmed',
  rejected: 'Rejected',
};

/**
 * One field Mistral pulled off the document, with the confidence it had.
 *
 * Confidence travels per field rather than only per document, because that is
 * what lets the UI highlight the two fields that are actually shaky instead of
 * making a human re-read all eight. M2.12: *"log confidence and correction rate
 * from day one, so accuracy is a measured number."*
 */
export const ExtractedFieldSchema = z
  .object({
    key: z.enum([
      'poNumber',
      'accountName',
      'siteAddress',
      'customerReference',
      'areaM2',
      'amountExGst',
      'issuedOn',
    ]),
    label: NonEmptyStringSchema,
    value: z.string().nullable(),
    confidence: z.number().min(0).max(1),
  })
  .meta({ id: 'ExtractedField' });

/** A candidate the extraction was matched against, with why it scored. */
export const MatchCandidateSchema = z
  .object({
    id: ObjectIdSchema,
    label: NonEmptyStringSchema,
    detail: z.string(),
    confidence: z.number().min(0).max(1),
  })
  .meta({ id: 'MatchCandidate' });

export const PoExtractionItemSchema = z
  .object({
    id: ObjectIdSchema,
    /** From the monitored M365 mailbox (I6). */
    fromAddress: NonEmptyStringSchema,
    subject: NonEmptyStringSchema,
    receivedAt: IsoDateTimeSchema,
    attachmentName: NonEmptyStringSchema,
    pageCount: z.number().int().positive(),
    poNumber: z.string().nullable(),
    /** Best-guess account, null when nothing matched. */
    suggestedAccountId: ObjectIdSchema.nullable(),
    suggestedAccountName: z.string().nullable(),
    suggestedJobId: ObjectIdSchema.nullable(),
    suggestedJobNumber: z.number().int().positive().nullable(),
    amountExGst: MoneySchema.nullable(),
    overallConfidence: z.number().min(0).max(1),
    reason: PoReviewReasonSchema,
    state: PoReviewStateSchema,
  })
  .meta({ id: 'PoExtractionItem' });

export const PoExtractionSchema = PoExtractionItemSchema.extend({
  /** Plain-text rendering of the source document, shown beside the fields. */
  documentText: z.string(),
  fields: z.array(ExtractedFieldSchema),
  accountCandidates: z.array(MatchCandidateSchema),
  jobCandidates: z.array(MatchCandidateSchema),
  reviewedAt: IsoDateTimeSchema.nullable(),
  reviewedBy: z.string().nullable(),
}).meta({ id: 'PoExtraction' });

/**
 * What a human confirms.
 *
 * The corrected values come back as well as the ids, because the correction rate
 * is the accuracy metric — a confirm that only sent ids would throw away the
 * training signal the design rules ask for.
 */
export const PoConfirmationSchema = z
  .object({
    poNumber: z.string().trim().min(1, 'Enter the PO number from the document').max(60),
    accountId: ObjectIdSchema,
    jobId: ObjectIdSchema,
    amountExGst: MoneySchema.nullable(),
  })
  .meta({ id: 'PoConfirmation' });

/* ── M5 · Journey A — leads and onboarding ────────────────────────────────── */

export const LEAD_STATUSES = ['new', 'contacted', 'quoted', 'won', 'lost'] as const;
export const LeadStatusSchema = z.enum(LEAD_STATUSES).meta({ id: 'LeadStatus' });
export type LeadStatus = z.infer<typeof LeadStatusSchema>;

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  quoted: 'Quoted',
  won: 'Won',
  lost: 'Lost',
};

export const LEAD_SOURCES = ['enquiry-form', 'phone', 'referral', 'other'] as const;
export const LeadSourceSchema = z.enum(LEAD_SOURCES).meta({ id: 'LeadSource' });
export type LeadSource = z.infer<typeof LeadSourceSchema>;

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  'enquiry-form': 'Website enquiry',
  phone: 'Phone — 1300 395 438',
  referral: 'Referral',
  other: 'Other',
};

export const LeadNoteSchema = z
  .object({
    id: ObjectIdSchema,
    at: IsoDateTimeSchema,
    author: NonEmptyStringSchema,
    body: NonEmptyStringSchema,
  })
  .meta({ id: 'LeadNote' });

export const LeadListItemSchema = z
  .object({
    id: ObjectIdSchema,
    companyName: NonEmptyStringSchema,
    contactName: NonEmptyStringSchema,
    email: NonEmptyStringSchema,
    mobile: z.string().nullable(),
    status: LeadStatusSchema,
    source: LeadSourceSchema,
    /** A.2 — inferred from the postcode, not asked for. */
    zone: ZoneSchema.nullable(),
    suburbs: z.string(),
    typicalVolumeM2: z.number().nonnegative().nullable(),
    expectedFrequency: z.string(),
    ownerName: z.string().nullable(),
    createdAt: IsoDateTimeSchema,
    lastActivityAt: IsoDateTimeSchema,
    /** Set once A.4 has run. A converted lead is history, not work. */
    convertedAccountId: ObjectIdSchema.nullable(),
  })
  .meta({ id: 'LeadListItem' });

export const LeadSchema = LeadListItemSchema.extend({
  heardAbout: z.string(),
  notes: z.array(LeadNoteSchema),
}).meta({ id: 'Lead' });

export const LeadUpdateSchema = z
  .object({
    status: LeadStatusSchema,
    ownerName: z.string().trim().max(80),
    note: z.string().trim().max(1000),
  })
  .meta({ id: 'LeadUpdate' });

/**
 * A.4 — Convert Lead → Account, in one flow.
 *
 * Every field here is one the account genuinely cannot exist without: M2.8 lists
 * customer code, ABN, brand, rate card, PO policy, capture configuration and
 * payment terms, and A.4 adds the first site and the invitation. Nothing is
 * defaulted silently — a wrong rate card is a pricing incident.
 */
export const LeadConversionSchema = z
  .object({
    customerCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}[0-9]{3}$/, 'Three letters then three digits, e.g. NEW001'),
    legalName: z.string().trim().min(1, 'Enter the registered company name').max(120),
    abn: z
      .string()
      .trim()
      .regex(/^\d{11}$/, 'An ABN is 11 digits'),
    brandId: BrandIdSchema,
    rateCardId: RateCardIdSchema,
    poPolicy: PoPolicySchema,
    captureMode: CaptureModeSchema,
    paymentTermsDays: z.number().int().min(0).max(90),
    primaryZone: ZoneSchema,
    siteName: z.string().trim().min(1, 'Give the first site a name').max(120),
    siteSuburb: z.string().trim().min(1, 'Enter the suburb').max(80),
    /** A.4 finishes by sending the welcome email; skipping it is a choice. */
    sendInvitation: z.boolean(),
  })
  .meta({ id: 'LeadConversion' });

/* ── Counts, for the nav badges ───────────────────────────────────────────── */

/**
 * One small call the shell polls, rather than five list calls.
 *
 * The nav shows a badge per queue; loading five paginated lists to render five
 * numbers would be five round trips on every page load. This is the number, and
 * nothing else.
 */
export const QueueCountsSchema = z
  .object({
    futileReview: z.number().int().nonnegative(),
    serviceApprovals: z.number().int().nonnegative(),
    awaitingPo: z.number().int().nonnegative(),
    poReview: z.number().int().nonnegative(),
    leads: z.number().int().nonnegative(),
  })
  .meta({ id: 'QueueCounts' });

export type FutileReviewItem = z.infer<typeof FutileReviewItemSchema>;
export type FutileReview = z.infer<typeof FutileReviewSchema>;
export type FutileDecision = z.infer<typeof FutileDecisionSchema>;
export type ChargeApprovalItem = z.infer<typeof ChargeApprovalItemSchema>;
export type ChargeApprovalDetail = z.infer<typeof ChargeApprovalDetailSchema>;
export type ChargeDecision = z.infer<typeof ChargeDecisionSchema>;
export type AwaitingPoItem = z.infer<typeof AwaitingPoItemSchema>;
export type ExtractedField = z.infer<typeof ExtractedFieldSchema>;
export type MatchCandidate = z.infer<typeof MatchCandidateSchema>;
export type PoExtractionItem = z.infer<typeof PoExtractionItemSchema>;
export type PoExtraction = z.infer<typeof PoExtractionSchema>;
export type PoConfirmation = z.infer<typeof PoConfirmationSchema>;
export type LeadNote = z.infer<typeof LeadNoteSchema>;
export type LeadListItem = z.infer<typeof LeadListItemSchema>;
export type Lead = z.infer<typeof LeadSchema>;
export type LeadUpdate = z.infer<typeof LeadUpdateSchema>;
export type LeadConversion = z.infer<typeof LeadConversionSchema>;
export type QueueCounts = z.infer<typeof QueueCountsSchema>;
