import * as z from 'zod';
import {
  AbnSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  MoneySchema,
  NonEmptyStringSchema,
  ObjectIdSchema,
} from './primitives.js';
import {
  AccountTypeSchema,
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
  /** Null on a fixed-price builder's job — the PO carries no area. */
  expectedAreaM2: z.number().nonnegative().nullable(),
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
/**
 * The fields pulled off a purchase order, each with its own confidence.
 *
 * Per field rather than per document, because they fail independently: a Domain
 * PO's number is printed large at the top and its site supervisor's mobile is in
 * eight-point type at the bottom, and one being unreadable should not send the
 * other back to a human.
 *
 * The list is exactly what Matt read out of the Domain order at 28:12 — order
 * number, address down to the lot, square metres, bag allowance, supervisor and
 * their mobile. Anything else on the page is not something PlastaGo acts on.
 */
export const ExtractedFieldSchema = z
  .object({
    key: z.enum([
      'poNumber',
      'accountName',
      'siteAddress',
      'lotNumber',
      'customerReference',
      'areaM2',
      'bagAllowance',
      'siteSupervisorName',
      'siteSupervisorMobile',
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

/* ── The purchase order itself (M2.12 · I6) ──────────────────────────────── */

/**
 * What a builder's purchase order actually contains.
 *
 * ── A PO is two documents at once ─────────────────────────────────────────
 * It is **permission to invoice** — a builder's accounts system rejects any
 * invoice that does not quote a valid PO number — and it is also the **job
 * spec**. Matt walked through a Domain PO at 28:12: *"you get the order number…
 * the site address, lot number, street number, street name, suburb… 823.41
 * square metres… they're only allowed two bags on this job… and they're giving
 * you the site supervisor down the bottom as Matthew French with his mobile
 * number."*
 *
 * Storing only \`poNumber\` — which is all the system did before — keeps the money
 * half and throws away the spec half, leaving the office to retype figures that
 * arrived in machine-readable form. Every field below is one Matt named.
 *
 * ── It arrives months early, and does not schedule anything ───────────────
 * *"We'll receive this probably three to four months before we actually do the
 * job"* (28:40). What schedules the work is a separate call-up email a week out
 * (see \`CallUpSchema\`). A PO that created a live job would put a pickup on the
 * board for a house that has not been plastered yet.
 */
export const PurchaseOrderSchema = z
  .object({
    id: ObjectIdSchema,
    poNumber: NonEmptyStringSchema,
    accountId: ObjectIdSchema,
    accountName: NonEmptyStringSchema,
    receivedAt: IsoDateTimeSchema,

    /* ── The site, as the PO gives it ─────────────────────────────────── */
    /** Greenfield estates have no street number yet — the lot is the address. */
    lotNumber: z.string().nullable(),
    addressLine: z.string().nullable(),
    suburb: z.string().nullable(),
    postcode: z.string().nullable(),

    /* ── The job, as the PO specifies it ──────────────────────────────── */
    /**
     * Null on a fixed-price account, and that is not a failed extraction.
     *
     * Matt, 31:04: *"if you look at the **Wisdom PO**, it's a little different
     * because we're on a fixed price with them. So they don't actually give us
     * square metres… they just give us a line item."* Treating the absence as a
     * low-confidence read would send every Wisdom order to the review queue for
     * a human to confirm that the number genuinely is not there.
     */
    expectedAreaM2: z.number().nonnegative().nullable(),
    /** Roughly one per 500 m², and the builder states the allowance (28:12). */
    bagAllowance: z.number().int().nonnegative().nullable(),

    /* ── Who is on site ───────────────────────────────────────────────── */
    siteSupervisorName: z.string().nullable(),
    siteSupervisorMobile: z.string().nullable(),
    /**
     * The portal login provisioned for that person, once there is one.
     *
     * Null where the order named nobody, where the account is a contractor, or
     * where that mobile already belongs to somebody else's login — see the
     * field on the model.
     */
    siteSupervisorUserId: ObjectIdSchema.nullable(),

    amountExGst: MoneySchema.nullable(),
    /** The stored original. The office reads figures off it during review. */
    documentUrl: z.string().nullable(),
  })
  .meta({ id: 'PurchaseOrder' });

export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>;

/**
 * The call-up — the email that actually schedules the work.
 *
 * ── Why this is a separate record from the purchase order ─────────────────
 * Matt, 28:50: *"We'll then get an email from them a week or so out, giving us
 * that PO number and that address and **a date**."* The PO arrived three months
 * earlier and said what the job is; the call-up says it is happening now.
 *
 * Collapsing the two would mean either a board full of jobs for houses that are
 * still being framed, or throwing the PO away and re-keying it when the call-up
 * lands. Keeping them apart is also what makes the failure case recoverable:
 * *"sometimes that call-up email fails and the site supervisor needs to book the
 * job himself"* (29:03) — the PO is already there, so the supervisor books
 * against it in two taps rather than filling in a form they cannot answer.
 */
export const CALL_UP_SOURCES = ['email', 'portal', 'phone'] as const;
export const CallUpSourceSchema = z.enum(CALL_UP_SOURCES).meta({ id: 'CallUpSource' });
export type CallUpSource = z.infer<typeof CallUpSourceSchema>;

export const CALL_UP_SOURCE_LABELS: Record<CallUpSource, string> = {
  email: 'Call-up email',
  portal: 'Booked in the portal',
  phone: 'Phoned in',
};

/**
 * What a call-up is telling us to do — Matt's own colour coding (24:07).
 *
 * He reads these off the builder's portal without opening them: *"this one here
 * is, it's in green, it's been rescheduled from this date to this date… Green
 * means it's been rescheduled from another day, whereas blue is a brand new
 * notification. There are red ones which are like job cancellations, but I've
 * probably had 10 of them in the last four years, so they're very rare."*
 *
 * ⚠️ `cancel` is rare and must still be handled. Ten in four years is ten
 * trucks that drove to a site with nothing on it — the cost of ignoring it is
 * not proportional to how often it happens.
 */
export const CALL_UP_KINDS = ['new', 'reschedule', 'cancel'] as const;
export const CallUpKindSchema = z.enum(CALL_UP_KINDS).meta({ id: 'CallUpKind' });
export type CallUpKind = z.infer<typeof CallUpKindSchema>;

export const CALL_UP_KIND_LABELS: Record<CallUpKind, string> = {
  new: 'New booking',
  reschedule: 'Rescheduled',
  cancel: 'Cancelled',
};

/**
 * Whether the call-up actually moved the work, or is waiting for a human.
 *
 * Same rule as the purchase-order queue: never silently guess. A call-up naming
 * a PO nobody has on file is not a booking, and inventing a job for it would put
 * a truck on a road for work that was never ordered.
 */
export const CALL_UP_STATES = ['applied', 'needs-review', 'rejected'] as const;
export const CallUpStateSchema = z.enum(CALL_UP_STATES).meta({ id: 'CallUpState' });
export type CallUpState = z.infer<typeof CallUpStateSchema>;

export const CALL_UP_STATE_LABELS: Record<CallUpState, string> = {
  applied: 'Scheduled',
  'needs-review': 'Needs review',
  rejected: 'Rejected',
};

/** Why a call-up could not be applied on its own. */
export const CALL_UP_REVIEW_REASONS = [
  /** No confirmed purchase order carries that number. */
  'no-matching-po',
  /** More than one order matches, so which job to move is a guess. */
  'ambiguous-po',
  /** A reschedule or cancellation for an order that has no job yet. */
  'no-job-to-change',
  /** The job is already collected or invoiced — too late to move it. */
  'job-finished',
  /** The order's suburb is not one we service, so the job cannot be priced. */
  'unknown-suburb',
  /** A new booking for an order that already produced a job. */
  'already-booked',
] as const;
export const CallUpReviewReasonSchema = z
  .enum(CALL_UP_REVIEW_REASONS)
  .meta({ id: 'CallUpReviewReason' });
export type CallUpReviewReason = z.infer<typeof CallUpReviewReasonSchema>;

export const CALL_UP_REVIEW_REASON_LABELS: Record<CallUpReviewReason, string> = {
  'no-matching-po': 'No purchase order on file with that number',
  'ambiguous-po': 'More than one order has that number',
  'no-job-to-change': 'No job booked against that order yet',
  'job-finished': 'That job is already finished',
  'unknown-suburb': 'The order’s suburb is not one we service',
  'already-booked': 'That order already has a job',
};

export const CallUpSchema = z
  .object({
    id: ObjectIdSchema,
    /**
     * The order this call-up releases.
     *
     * ⚠️ Nullable, unlike the original sketch of this record. A call-up naming a
     * PO number nobody has on file still has to be STORED — it is a real email
     * about real work, and dropping it means the job never happens and there is
     * no trace of why. It lands unmatched, with `needs-review`.
     */
    purchaseOrderId: ObjectIdSchema.nullable(),
    /** The number as it arrived. The only handle on an unmatched call-up. */
    poNumber: NonEmptyStringSchema,
    accountId: ObjectIdSchema.nullable(),
    accountName: z.string().nullable(),
    receivedAt: IsoDateTimeSchema,
    source: CallUpSourceSchema,
    kind: CallUpKindSchema,
    /**
     * The date the board plans against — the whole point of the call-up.
     *
     * ⚠️ Null on a cancellation, which names no date. Null is not "today".
     */
    readyDate: IsoDateSchema.nullable(),
    /** The date it moved FROM, on a reschedule. Context for the office. */
    previousReadyDate: IsoDateSchema.nullable(),
    state: CallUpStateSchema,
    /** Why it is waiting for a human. Null once applied. */
    reason: CallUpReviewReasonSchema.nullable(),
    /** Set once the call-up has produced or changed a job. */
    jobId: ObjectIdSchema.nullable(),
    jobNumber: z.number().int().positive().nullable(),
    note: z.string(),
    resolvedAt: IsoDateTimeSchema.nullable(),
    resolvedBy: z.string().nullable(),
  })
  .meta({ id: 'CallUp' });

export type CallUp = z.infer<typeof CallUpSchema>;

/**
 * Calling a purchase order up by hand (Matt, 29:03 and 30:40).
 *
 * *"Sometimes the builder's systems that aren't work, we don't get this email.
 * So there's still the manual ability… he can log into his portal and that job,
 * that PO that we got will be sitting there on his account and he can go call
 * this up for the 21st."*
 *
 * Deliberately only a date and a note: everything else about the job is already
 * on the order, which is the whole reason the supervisor can do this in two taps
 * rather than filling in a form they cannot answer.
 */
export const CallUpRequestSchema = z
  .object({
    readyDate: IsoDateSchema,
    note: z.string().trim().max(500).default(''),
  })
  .meta({ id: 'CallUpRequest' });

export type CallUpRequest = z.infer<typeof CallUpRequestSchema>;

/**
 * What calling up an order actually did.
 *
 * ── Why the caller is told, rather than just given a 201 ──────────────────
 * Because "recorded" and "scheduled" are different outcomes and look identical
 * from outside. A supervisor who picks a date and gets a bare success would
 * reasonably believe a truck is coming; if the order's suburb is not one we
 * service, it went to the office queue instead. The screen has to be able to say
 * which, so the shape says which.
 */
export const CallUpOutcomeSchema = z
  .object({
    id: ObjectIdSchema,
    state: CallUpStateSchema,
    /** Why it is waiting for the office. Null once applied. */
    reason: CallUpReviewReasonSchema.nullable(),
    jobId: ObjectIdSchema.nullable(),
    jobNumber: z.number().int().positive().nullable(),
  })
  .meta({ id: 'CallUpOutcome' });

export type CallUpOutcome = z.infer<typeof CallUpOutcomeSchema>;

/**
 * A confirmed order with no job yet — Matt's *"sitting there waiting"* (21:30).
 *
 * The office list this feeds is the answer to "what have we been told about that
 * has not been booked in?", which before this had no screen at all.
 */
export const AwaitingCallUpSchema = z
  .object({
    purchaseOrderId: ObjectIdSchema,
    poNumber: NonEmptyStringSchema,
    accountId: ObjectIdSchema,
    accountName: NonEmptyStringSchema,
    receivedAt: IsoDateTimeSchema,
    lotNumber: z.string().nullable(),
    addressLine: z.string().nullable(),
    suburb: z.string().nullable(),
    expectedAreaM2: z.number().nullable(),
    bagAllowance: z.number().int().nullable(),
    siteSupervisorName: z.string().nullable(),
    /** Whether the order's suburb resolves to a place we service. */
    serviceable: z.boolean(),
  })
  .meta({ id: 'AwaitingCallUp' });

export type AwaitingCallUp = z.infer<typeof AwaitingCallUpSchema>;

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

    /*
     * The job spec, as read off the document.
     *
     * These are what make the extraction worth doing: without them the office
     * still retypes the area, the bag allowance and the supervisor from a PDF
     * that already had them in machine-readable form (Matt, 25:40: *"it should
     * pull out of the purchase order"*).
     */
    extractedAreaM2: z.number().nonnegative().nullable(),
    extractedBagAllowance: z.number().int().nonnegative().nullable(),
    extractedSiteAddress: z.string().nullable(),
    extractedLotNumber: z.string().nullable(),
    extractedSupervisorName: z.string().nullable(),
    extractedSupervisorMobile: z.string().nullable(),

    overallConfidence: z.number().min(0).max(1),
    reason: PoReviewReasonSchema,
    state: PoReviewStateSchema,
  })
  .meta({ id: 'PoExtractionItem' });

export const PoExtractionSchema = PoExtractionItemSchema.extend({
  /**
   * A short-lived link to the stored original, shown beside the fields.
   *
   * Matt, 28:30, on reviewing an extraction: *"do they see a copy of that PDF
   * on the review screen? …I'd be looking at a copy of the PDF too."* Checking
   * eight extracted values against nothing is not a review, so the page it came
   * off has to be on screen next to them.
   *
   * ⚠️ Null where the copy could not be taken — `storeOriginal` swallows a
   * failed download rather than dropping a real purchase order, so an
   * extraction with no stored original is a normal state, not an error. The
   * screen falls back to the OCR text in that case.
   *
   * Presigned and short-lived, so it is minted per request and never stored.
   */
  documentUrl: z.string().nullable(),
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
    /**
     * Null when the PO arrived before any job existed — the normal case.
     *
     * A builder's order lands three to four months ahead of the work (Matt,
     * 28:40), so at confirmation time there is usually nothing to attach it to.
     * Requiring a job here is what would force the office to invent one, and a
     * job dated three months out clutters every board between now and then.
     */
    jobId: ObjectIdSchema.nullable(),

    /*
     * The corrected spec.
     *
     * Sent back even when unchanged, because the correction rate is the accuracy
     * metric — a confirm that only returned ids would throw away the signal that
     * says which fields the extractor keeps getting wrong.
     */
    expectedAreaM2: z.number().nonnegative().nullable(),
    bagAllowance: z.number().int().nonnegative().nullable(),
    lotNumber: z.string().trim().max(30).nullable(),
    addressLine: z.string().trim().max(160).nullable(),
    suburb: z.string().trim().max(80).nullable(),
    siteSupervisorName: z.string().trim().max(80).nullable(),
    siteSupervisorMobile: z.string().trim().max(20).nullable(),

    amountExGst: MoneySchema.nullable(),
  })
  .meta({ id: 'PoConfirmation' });

/* ── M5 · Journey A — leads and onboarding ────────────────────────────────── */

export const LEAD_STATUSES = ['new', 'contacted', 'quoted', 'won', 'lost'] as const;
export const LeadStatusSchema = z.enum(LEAD_STATUSES).meta({ id: 'LeadStatus' });
export type LeadStatus = z.infer<typeof LeadStatusSchema>;

/**
 * The statuses a human may set by hand.
 *
 * ⚠️ `won` is absent on purpose, and that absence is the whole point.
 *
 * A lead is won when it becomes an ACCOUNT — which is A.4, where the customer
 * code, the rate card and the terms are decided. Letting the status dropdown
 * write `won` produced a lead that claimed to be a customer with no account,
 * no rate card and nothing to invoice against, and it did so silently: the
 * console warned and then saved it anyway. Those rows then poisoned the
 * conversion figures, because they were the only "wins" the grid could see.
 *
 * `lost` stays — closing an enquiry that went nowhere is a genuine by-hand
 * decision with nothing downstream of it.
 */
export const LEAD_WORKABLE_STATUSES = ['new', 'contacted', 'quoted', 'lost'] as const;
export const LeadWorkableStatusSchema = z
  .enum(LEAD_WORKABLE_STATUSES)
  .meta({ id: 'LeadWorkableStatus' });
export type LeadWorkableStatus = z.infer<typeof LeadWorkableStatusSchema>;

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

/**
 * A file attached to a lead — in practice, a PDF proposal.
 *
 * Matt, 5:53: *"if we're able to attach like a PDF file to those leads… we do
 * generate PDF proposals for some builders and it would help us keep track of
 * that."*
 *
 * ── Why it belongs on the lead and not on the account ─────────────────────
 * A proposal is the thing that exists *before* there is an account, and it is
 * the document the office needs when the builder rings back three weeks later
 * asking what was quoted. Filing it against the account it might become would
 * mean the ones that never convert have nowhere to live — which is exactly the
 * set you most want to be able to look up.
 *
 * ⚠️ The lead is a sales record and the file is evidence of what was offered.
 * Attachments are therefore append-and-remove, never edit-in-place: a proposal
 * that can be silently swapped is not evidence of anything.
 */
/**
 * What may be filed against a lead (Matt, 5:53).
 *
 * ── Why this is shared rather than a set in the service ───────────────────
 * The API enforces it and the console's file pickers advertise it, and those
 * two lists disagreeing is the whole problem: a picker offering `image/*` lets
 * somebody choose a GIF, wait for the dialog, and then be told no. The picker
 * should not offer what the server will refuse.
 *
 * ⚠️ Every type here needs an extension in the API's storage `EXTENSIONS` map,
 * or its key is built as `.bin` and the file reads back with no type at all.
 */
export const LEAD_ATTACHABLE_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

/**
 * The `accept` attribute for a lead file picker.
 *
 * Extensions as well as media types on purpose: Windows reports no type at all
 * for some files, and a picker that filters on media type alone then hides the
 * .docx the user is looking straight at.
 */
export const LEAD_ATTACHMENT_ACCEPT = [
  ...LEAD_ATTACHABLE_TYPES,
  '.pdf',
  '.jpg',
  '.jpeg',
  '.png',
  '.docx',
].join(',');

export const LeadAttachmentSchema = z
  .object({
    id: ObjectIdSchema,
    fileName: NonEmptyStringSchema,
    /** Bytes. Shown so somebody can tell a one-page quote from a scan. */
    sizeBytes: z.number().int().nonnegative(),
    contentType: NonEmptyStringSchema,
    uploadedAt: IsoDateTimeSchema,
    uploadedBy: NonEmptyStringSchema,
    /** Where the stored file lives. Null while the upload is still in flight. */
    url: z.string().nullable(),
  })
  .meta({ id: 'LeadAttachment' });

export type LeadAttachment = z.infer<typeof LeadAttachmentSchema>;

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
  /** PDF proposals and anything else sent to this lead (Matt, 5:53). */
  attachments: z.array(LeadAttachmentSchema),
}).meta({ id: 'Lead' });

export const LeadUpdateSchema = z
  .object({
    // Not `LeadStatusSchema` — see the warning on LEAD_WORKABLE_STATUSES.
    // Converting is the only route to `won`.
    status: LeadWorkableStatusSchema,
    ownerName: z.string().trim().max(80),
    note: z.string().trim().max(1000),
  })
  .meta({ id: 'LeadUpdate' });

/**
 * A.1 — take a lead by hand, for the enquiries that never touch the web form.
 *
 * ── Why this exists at all ────────────────────────────────────────────────
 * `LEAD_SOURCES` has always carried `phone`, `referral` and `other`, and the
 * queue has always been able to filter by them — but nothing could ever *write*
 * one. The only door into the queue was the public enquiry form, so a builder
 * who rang 1300 395 438 either lived in somebody's notebook or was typed
 * straight in as a job — which is the exact "leads arrive disguised as jobs"
 * problem this queue was built to end.
 *
 * ── Why so much of it is optional ─────────────────────────────────────────
 * A web form can insist. A phone call cannot: the caller is on the line, and a
 * required "expected frequency" is a reason to abandon the record and lose the
 * lead entirely. So what is required is only what makes the lead *chaseable* —
 * who they are and how to reach them — and everything that shapes the eventual
 * quote is optional, to be filled in on the second call. A thin lead in the
 * queue beats a perfect one in a notebook.
 *
 * ⚠️ `status` is deliberately absent. Every lead starts `new`; letting intake
 * set it would allow a lead to be created already `won`, which would bypass A.4
 * and so bypass the rate card, the terms and the account that "won" is supposed
 * to mean. Progressing a lead is `LeadUpdate`'s job and converting it is
 * `LeadConversion`'s; neither is an intake decision.
 */
export const LeadCreateSchema = z
  .object({
    companyName: z.string().trim().min(1, 'Enter the company name').max(120),
    contactName: z.string().trim().min(1, 'Enter who you spoke to').max(80),
    email: z.email('Enter a valid email address').max(160),
    /**
     * Optional, because a lead can legitimately be email-only — the grid already
     * renders that case as "Email only" rather than as a gap.
     */
    mobile: z.string().trim().max(20),
    source: LeadSourceSchema,
    /**
     * A.2 infers the zone from a postcode. There is no postcode → zone lookup
     * anywhere in this build, so it is asked for rather than guessed — and
     * `null` is a real answer, not a missing one: it means a lead we probably
     * cannot service, which the queue filters for on purpose.
     */
    zone: ZoneSchema.nullable(),
    suburbs: z.string().trim().max(200),
    /** Nullable rather than 0 — "they did not say" is not "no plasterboard". */
    typicalVolumeM2: z
      .number()
      .nonnegative('Square metres cannot be negative')
      .max(100000, 'That looks too large — check the figure')
      .nullable(),
    expectedFrequency: z.string().trim().max(80),
    heardAbout: z.string().trim().max(200),
    ownerName: z.string().trim().max(80),
    /** The call itself. Becomes the first entry in the lead's note thread. */
    note: z.string().trim().max(1000),
  })
  .meta({ id: 'LeadCreate' });

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
    abn: AbnSchema,
    /**
     * Builder or contractor — the two journeys (Matt, 21:55).
     *
     * ── Why this is asked and not assumed ─────────────────────────────────
     * It decides whether the customer gets site supervisors and whether their
     * booking form asks for the area and bag count, and it is set once: there
     * is no screen that changes an account's journey afterwards. Conversion
     * defaulted it to `builder` for every lead, so a contractor arriving
     * through this queue got supervisors they do not use and a short form
     * missing the only figures they can supply.
     */
    accountType: AccountTypeSchema,
    brandId: BrandIdSchema,
    rateCardId: RateCardIdSchema,
    poPolicy: PoPolicySchema,
    captureMode: CaptureModeSchema,
    paymentTermsDays: z.number().int().min(0).max(90),
    primaryZone: ZoneSchema,
    /*
     * No first site.
     *
     * It was optional (Matt, 6:31) and is now absent entirely: there is no Site
     * record to create (0:29). An account is a commercial relationship — a rate
     * card, terms and a signed set of conditions. Where the truck goes is typed
     * on the first booking.
     */
    /** A.4 finishes by sending the welcome email; skipping it is a choice. */
    sendInvitation: z.boolean(),
  })
  .meta({ id: 'LeadConversion' });

/* ── Pipeline stats, for the cards above the leads grid ──────────────── */

/**
 * The Won / Conversion figures above the leads grid.
 *
 * ⚠️ Counted on the SERVER, across every lead, never on the page the grid
 * happens to be showing. These cards used to be derived from the visible rows,
 * which made them the most quotable wrong number on the screen: the grid hides
 * converted leads by default, so "Won" could only ever count leads somebody had
 * typed as won WITHOUT converting — precisely the ones that are not wins.
 */
export const LeadPipelineStatsSchema = z
  .object({
    /** Still being chased: not converted, not lost. */
    open: z.number().int().nonnegative(),
    /**
     * Leads that became an account.
     *
     * Counted on `convertedAccountId`, not on `status: 'won'`. Conversion is the
     * only thing that creates an account, so the account reference is the fact;
     * the status is a label that older rows may carry without one.
     */
    won: z.number().int().nonnegative(),
    lost: z.number().int().nonnegative(),
  })
  .meta({ id: 'LeadPipelineStats' });

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
    /**
     * M2.12b — confirmed orders nobody has given us a date for.
     *
     * ⚠️ Counts the WAITING ORDERS, not the call-ups needing review. Matt's
     * question is *"what have we been told about that has not been booked in?"*
     * (21:30), and a badge showing failed emails would answer a different and
     * much rarer one — most of these are simply orders whose call-up has not
     * arrived yet, which is normal until it is not.
     */
    awaitingCallUp: z.number().int().nonnegative(),
    /**
     * M2.12b — call-ups that arrived and could not be applied.
     *
     * ⚠️ A separate count from `awaitingCallUp`, and the more urgent of the two.
     * A waiting order is normal until it is not; a call-up sitting in the queue
     * means a builder has already told us a date and we have not acted on it.
     */
    callUpReview: z.number().int().nonnegative(),
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
export type LeadCreate = z.infer<typeof LeadCreateSchema>;
export type LeadConversion = z.infer<typeof LeadConversionSchema>;
export type LeadPipelineStats = z.infer<typeof LeadPipelineStatsSchema>;
export type QueueCounts = z.infer<typeof QueueCountsSchema>;
