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
 * These are the statuses actually used across all 5,079 production jobs, plus
 * the one we add. **We are not building a 20-state machine nobody uses.**
 *
 * `acknowledged` was dropped: the driver app raised it from an "Accept job" tap,
 * and a job that is already dispatched to a named driver gives them nothing to
 * accept or reject. One less tap before the truck moves.
 *
 *   booked → assigned → in-transit → arrived → completed
 *                                             → admin-complete
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
  /**
   * Bags collected beyond what the purchase order allowed for (Matt, 07:37).
   *
   * ⚠️ A separate code from `recycling-bags` on purpose, and not an adjustment
   * to it. The base invoice has to leave the site matching the builder's order
   * exactly — Matt, 09:55: *"the original invoice for the job… has to go out
   * exactly matching what the build has given us"* — so the excess cannot be
   * folded into the ordered line. It is raised with `source: 'driver'`, which
   * is what routes it onto the additional-charges invoice with no PO number and
   * into the awaiting-PO queue until the builder issues a second order.
   */
  'extra-bags',
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
  'extra-bags': 'Extra bags (not on the original PO)',
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
    body: z.string().trim().min(1, 'Write something before posting').max(2000, 'Keep a comment under 2000 characters'),
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
 * M4.3 — whether a recovered weight was measured or worked out.
 *
 * Matt, 56:11: *"we want to mark that weight as an **estimated** weight, not an
 * actual weight. So for jobs where they actually weigh, the driver weighs them,
 * in the job card, we want to record the weight of that job as an **actual**
 * weight. And in the jobs where it's calculated based off weighbridge total, we
 * want to record that as an estimated weight."*
 *
 * Carried as a field rather than inferred from `loadType` at read time: the
 * basis is a fact about the number that was stored, and a job whose load type is
 * corrected later must not silently restate a measurement as a guess.
 */
export const WEIGHT_BASES = ['actual', 'estimated'] as const;
export const WeightBasisSchema = z.enum(WEIGHT_BASES).meta({ id: 'WeightBasis' });
export type WeightBasis = z.infer<typeof WeightBasisSchema>;

export const WEIGHT_BASIS_LABELS: Record<WeightBasis, string> = {
  actual: 'Actual',
  estimated: 'Estimated',
};

export const WEIGHT_BASIS_HINTS: Record<WeightBasis, string> = {
  actual: 'Weighed on the crane scale by the driver',
  estimated: 'Worked out from the weighbridge total, by job size',
};

/**
 * M4.8b — the PDF the assessment produces.
 *
 * Matt, 1:03:25: *"even if the PDF that it produces just gets attached to the
 * job card… once it generates the PDF, just attaches it to that job and **gives
 * the driver a copy** he can upload onto the builder's site."*
 *
 * Two destinations, not one: the office needs it filed against the job, and the
 * driver needs it in their hand at the fence because some builders only accept
 * it through their own portal.
 */
export const SraDocumentSchema = z
  .object({
    documentId: NonEmptyStringSchema,
    fileName: NonEmptyStringSchema,
    /** Null until generation finishes — the driver sees "preparing". */
    generatedAt: IsoDateTimeSchema.nullable(),
    pageCount: z.number().int().positive(),
    sizeBytes: z.number().int().nonnegative(),
  })
  .meta({ id: 'SraDocument' });
export type SraDocument = z.infer<typeof SraDocumentSchema>;

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
    /** The generated PDF, filed against this job. Null while it is being made. */
    document: SraDocumentSchema.nullable(),
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

    /* ── Where the job is ─────────────────────────────────────────────────
     *
     * The address lives ON the job. There is no Site record behind it.
     *
     * Matt, 0:29: *"sites is its own section and then jobs seem to be assigned
     * to a site. I don't really think that's necessary — the job should just
     * have the site on it as part of the details for the job."* And on why:
     * *"we don't ever really visit a site more than once… they build them, we go
     * there, we collect the stuff, we move on and someone moves into that"*
     * (3:28).
     *
     * He is describing greenfield housing. A site is a house being built; once
     * it is finished somebody lives there and it is never a pickup again. A
     * reusable Site record models a permanence this business does not have, and
     * the cost of pretending otherwise was a whole module to maintain, a foreign
     * key on every job, and an address that could be edited out from under a
     * completed job's own history.
     *
     * ⚠️ Nothing here is a lookup. Every field a driver or the board needs is
     * on the record, frozen at creation — which also means a job's address is
     * what it was on the day, not what somebody typed later.
     */

    /** The human name for the place — "Lot 214 (#46) Allambie Circuit". */
    siteName: NonEmptyStringSchema,
    /**
     * The lot number, where there is one.
     *
     * Load-bearing in a half-built estate: the street number does not exist yet
     * and the lot is how the site is identified on the ground.
     */
    lotNumber: z.string().nullable(),
    addressLine: NonEmptyStringSchema,
    suburb: NonEmptyStringSchema,
    postcode: z.string(),
    /**
     * Decides the rate (M6.3) — resolved from the chosen place, never typed.
     *
     * With no site to carry it, this comes off the suburb picker at booking. See
     * `PlaceSchema`.
     */
    zone: ZoneSchema,
    /** The pin. Drives the dispatch map, route optimisation and navigation. */
    latitude: z.number(),
    longitude: z.number(),

    /* ── Getting a truck in ───────────────────────────────────────────────
     * Formerly on the site, now typed per job. Matt accepted the retyping as
     * the price of dropping the module (2:07).
     */
    accessNotes: z.string(),
    gateHours: z.string().nullable(),
    inductionRequired: z.boolean(),
    craneAvailable: z.boolean(),
    siteContactName: z.string().nullable(),
    siteContactMobile: z.string().nullable(),
    /**
     * Where this job's completion photos go, on top of the account's contacts.
     *
     * Matt, 14:16 — often the *builder's* supervisor, who has no login here. It
     * moved from the site to the job with everything else; the cost is that it
     * is retyped per booking rather than set once per address.
     */
    siteContactEmail: z.string().nullable(),
    /**
     * The customer's own reference — PO number, job number, whatever they use.
     *
     * ── One field, not two ────────────────────────────────────────────────
     * Matt, 9:08: *"customer reference and purchase order number… they're really
     * interchangeable. Either a customer gives us a purchase order number or
     * they'll give us a job reference number. **They are one and the same, we
     * don't need both of them.**"*
     *
     * ⚠️ Named `poNumber` and printed as the PO on the invoice, deliberately —
     * 9:56: *"it needs to be referenced as a PO number, like PO slash job
     * reference. Because if we don't list PO on the invoice, then sometimes I
     * have trouble getting paid."* Whatever the customer calls it, the builder's
     * accounts system is looking for a PO line, and an invoice without one does
     * not get paid.
     */
    poNumber: z.string().nullable(),
    /**
     * Who raised this pickup, as a name to show.
     *
     * Matt, 18:15: *"I don't mind the column. That will probably come in handy…
     * I just want to make sure site supervisors can submit their jobs and be
     * able to see the jobs they've submitted."*
     *
     * A denormalised name rather than a user id, because it has to survive the
     * person leaving: a job booked in 2026 by a supervisor who is off the
     * account by 2027 must still say who booked it. Null for the older jobs and
     * for anything that arrived by email or phone before this was recorded.
     */
    bookedByName: z.string().nullable(),
    /**
     * The user who raised it — the site supervisor's SCOPE.
     *
     * ⚠️ This is an authorisation field, not a display one. Until sites were
     * removed, a supervisor was scoped by the list of sites assigned to them
     * (M1.5): it is what stopped Clarendon's supervisor seeing Domaine's work.
     * With no site records there is nothing left to scope on, so the boundary
     * moves to "the jobs this person raised".
     *
     * Matt asked for exactly this visibility at 18:15 on the earlier call: *"I
     * just want to make sure site supervisors can submit their jobs and be able
     * to see the jobs they've submitted."*
     *
     * Null on anything booked before this existed, or keyed in by the office. A
     * null is invisible to every supervisor, which is the safe direction.
     */
    bookedByUserId: ObjectIdSchema.nullable(),
    /** How it reached us — a supervisor in the portal, or the office by phone. */
    bookedBySource: z.enum(['portal', 'office', 'call-up']).nullable(),
    readyDate: IsoDateSchema,
    /** M2.4a — ready date + 5 business days. */
    targetDate: IsoDateSchema,
    serviceLevel: ServiceLevelSchema,
    driverId: ObjectIdSchema.nullable(),
    driverName: z.string().nullable(),
    /**
     * Null when nobody has told us the area yet — which is not an edge case.
     *
     * Matt, 31:04: *"if you look at the **Wisdom PO**, it's a little different
     * because we're on a fixed price with them. So they don't actually give us
     * square metres… they just give us a line item."* A builder's supervisor
     * booking a pickup does not know it either (29:21).
     *
     * ⚠️ Null is not zero, and the difference is money. Zero prices the job at
     * the call-out fee alone, and it silently takes a hand-load stop out of the
     * m²-weighted tip-off split — handing its share of recovered tonnage to
     * everyone else on the run, on a figure that ends up on a diversion
     * certificate. Every consumer must branch on it rather than `?? 0`.
     */
    expectedAreaM2: z.number().nonnegative().nullable(),
    recoveredWeightKg: z.number().nonnegative().nullable(),
    /** How that weight was arrived at. Null where there is no weight at all. */
    recoveredWeightBasis: WeightBasisSchema.nullable(),
    /**
     * The allowance the purchase order authorised, frozen at booking.
     *
     * ⚠️ This is the quantity the base invoice is priced on, so it must keep
     * matching the builder's order (Matt, 09:55). What the driver actually
     * found is `collectedBagCount`; the two are only equal by coincidence.
     */
    bagCount: z.number().int().nonnegative(),
    /**
     * What the driver counted on site. Null until the weights are captured.
     *
     * Anything over `bagCount` is charged separately and needs its own purchase
     * order (Matt, 08:28) — see the `extra-bags` charge code.
     */
    collectedBagCount: z.number().int().nonnegative().nullable(),
    /**
     * Null for a caller who may not see money — today the allocator (M1.5:
     * "the allocator sees the job, the site, the driver and the dates — never
     * what it is worth"). The server nulls it rather than the console hiding a
     * value it was sent; see `redactPricing` in `job.service.ts`.
     */
    totalExGst: MoneySchema.nullable(),
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
  /** Null for a caller who may not see money — see `totalExGst` above. */
  gst: MoneySchema.nullable(),
  totalIncGst: MoneySchema.nullable(),
  /** M4.8 — the safety record, readable by the office. */
  compliance: JobComplianceSchema,
}).meta({ id: 'Job' });

/**
 * M2.1 — what the create-job form collects.
 *
 * ── The account is an id; the address is typed ────────────────────────────
 * The account still comes from a picker — that field being free text is exactly
 * why leads used to arrive disguised as jobs. The address does not, because
 * there is no longer a Site record to pick from (Matt, 0:29).
 *
 * ⚠️ The SUBURB is still a chosen value, not typed. It carries the zone that
 * prices the job and the coordinate that plots it, and neither can be guessed
 * from free text — see `PlaceSchema`. Everything else about the address is
 * genuinely free text, because it is a house that did not exist last year.
 */
export const JobDraftSchema = z
  .object({
    accountId: ObjectIdSchema,

    /* ── The address ──────────────────────────────────────────────────── */
    siteName: z.string().trim().min(1, 'Name the place — drivers navigate by it').max(120, 'Keep the site name under 120 characters'),
    lotNumber: z.string().trim().max(30, 'A lot number is at most 30 characters'),
    addressLine: z.string().trim().min(1, 'Enter the street address').max(160, 'Keep the address under 160 characters'),
    /** From the suburb picker. Supplies suburb, postcode, zone and the pin. */
    placeId: z.string().trim().min(1, 'Choose the suburb from the list'),
    builderName: z.string().trim().max(120, 'Keep the builder name under 120 characters'),

    /* ── Getting a truck in ───────────────────────────────────────────── */
    accessNotes: z.string().trim().max(1000, 'Keep access notes under 1000 characters'),
    gateHours: z.string().trim().max(120, 'Keep gate hours under 120 characters'),
    inductionRequired: z.boolean(),
    craneAvailable: z.boolean(),
    siteContactName: z.string().trim().max(80, 'Keep the contact name under 80 characters'),
    siteContactMobile: z.string().trim().max(20, 'A mobile number is at most 20 characters'),
    siteContactEmail: z.string().trim().max(160, 'Keep the email under 160 characters'),
    /**
     * PO number or job reference — one field. See `Job.poNumber`.
     *
     * ⚠️ IGNORED when `purchaseOrderId` is set. The confirmed order's own number
     * wins, because that is the number the builder's accounts system matches on
     * and a typed one can disagree with it by a character.
     */
    poNumber: z.string().trim().max(60, 'A PO or job reference is at most 60 characters'),
    /**
     * M2.12 — the confirmed purchase order this pickup is being booked against.
     *
     * ── Why an id and not the figures off the order ────────────────────────
     * Because the area PRICES the job (M6.3), and a caller that could send its
     * own area could name its own price. The server resolves the order and takes
     * the area, the bag allowance and the PO number from the stored record —
     * the same reason `placeId` is sent rather than a zone.
     *
     * Null for a booking with no purchase order behind it, which is every
     * contractor and most phone bookings.
     */
    purchaseOrderId: ObjectIdSchema.nullable().default(null),
    readyDate: IsoDateSchema,
    serviceLevel: ServiceLevelSchema,
    freightItem: FreightItemSchema,
    /**
     * ⚠️ IGNORED when `purchaseOrderId` is set — see that field.
     *
     * Zero means "nobody has told us yet", which is the fixed-price builder's
     * normal case, not an area of nothing (`Job.expectedAreaM2`).
     */
    expectedAreaM2: z.number().nonnegative().max(100000, 'That looks too large — check the figure'),
    /** ⚠️ IGNORED when `purchaseOrderId` is set — the order states the allowance. */
    bagCount: z.number().int().nonnegative().max(200, 'That looks too many — check the figure'),
    notes: z.string().trim().max(2000, 'Keep notes under 2000 characters'),
  })
  .meta({ id: 'JobDraft' });

/**
 * M2.12 — a confirmed purchase order, as the booking form offers it.
 *
 * ── Why the form shows the figures it cannot change ───────────────────────
 * The area and the bag allowance are resolved server-side from this record, so
 * the form does not send them. It still has to SHOW them, because somebody
 * choosing an order needs to see that they are choosing 823.41 m² — a picker
 * that silently changed the price would be worse than one that asked.
 */
export const BookablePurchaseOrderSchema = z
  .object({
    id: ObjectIdSchema,
    poNumber: NonEmptyStringSchema,
    accountId: ObjectIdSchema,
    accountName: NonEmptyStringSchema,
    receivedAt: z.iso.datetime(),
    lotNumber: z.string().nullable(),
    addressLine: z.string().nullable(),
    suburb: z.string().nullable(),
    postcode: z.string().nullable(),
    /**
     * ⚠️ Null on a fixed-price order, and that is a REAL answer — the builder
     * genuinely does not state an area (Matt, 31:04). The form must say "fixed
     * price" rather than render a zero.
     */
    expectedAreaM2: z.number().nullable(),
    bagAllowance: z.number().int().nullable(),
    siteSupervisorName: z.string().nullable(),
    siteSupervisorMobile: z.string().nullable(),
    /**
     * The supervisor's portal login, so a job booked against this order can be
     * scoped to them (Matt, 33:57). Null where nobody was provisioned.
     */
    siteSupervisorUserId: ObjectIdSchema.nullable(),
    amountExGst: MoneySchema.nullable(),
    /**
     * The job already booked against this order, if there is one.
     *
     * Present rather than filtered out: *"PO-88214 is on job 61,412"* is the
     * answer somebody hunting for it needs. Hiding the row makes them think the
     * extraction failed and key the order in by hand.
     */
    usedByJobNumber: z.number().int().positive().nullable(),
  })
  .meta({ id: 'BookablePurchaseOrder' });

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
export type BookablePurchaseOrder = z.infer<typeof BookablePurchaseOrderSchema>;
export type PricePreviewLine = z.infer<typeof PricePreviewLineSchema>;
export type PricePreview = z.infer<typeof PricePreviewSchema>;
