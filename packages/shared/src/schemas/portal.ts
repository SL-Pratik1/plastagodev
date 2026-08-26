import * as z from 'zod';
import {
  IsoDateSchema,
  IsoDateTimeSchema,
  MoneySchema,
  NonEmptyStringSchema,
  ObjectIdSchema,
} from './primitives.js';
import { ZoneSchema } from './party.js';
import { JobPhotoSchema, JobStatusSchema, ServiceLevelSchema, type JobStatus } from './jobs.js';

/**
 * The customer portal (M5 Part 1).
 *
 * ── Why the portal has its own types and not the admin ones ────────────────
 * Because the audience is different in a way that matters legally and
 * commercially, not just visually. A site supervisor at GJ Gardner *must not*
 * see pricing, other sites, or any other builder's work (M1.5's worked example).
 * Reusing `JobListItem` here would mean shipping every field to the browser and
 * hiding some in CSS — which is not hiding anything at all.
 *
 * So these are narrower shapes, and the money fields are **nullable**: the
 * server nulls them for a site supervisor rather than the client choosing not to
 * render them. One type, two legitimate payloads, and the difference is decided
 * where it can be enforced.
 *
 * ── Nothing here takes an accountId ───────────────────────────────────────
 * Every portal request is scoped from the SESSION. A client-supplied account or
 * site id is the classic authorisation bug: it works perfectly until someone
 * changes the number in the URL. The scope call below tells the UI what it is
 * allowed to show; the server enforces it regardless.
 */

/* ── Who am I, and what may I see ─────────────────────────────────────────── */

/**
 * Resolved from the session, on every portal page load.
 *
 * `siteIds` is `null` for a Customer Administrator — meaning *all of this
 * account's sites* — and an explicit list for a Site Supervisor. Null and empty
 * are deliberately different: empty means "no sites yet", which is a real state
 * for a freshly invited supervisor and needs its own empty screen.
 */
export const PortalScopeSchema = z
  .object({
    accountId: ObjectIdSchema,
    accountName: NonEmptyStringSchema,
    customerCode: NonEmptyStringSchema,
    /** Whether this account records recovered weight as well as area (M2.3). */
    capturesWeight: z.boolean(),
    /** M2.10 — whether their invoices need a PO. Changes the booking form. */
    poRequired: z.boolean(),
    /** M1.5 — false for every site supervisor. */
    canSeePricing: z.boolean(),
    /** `null` = every site on the account. */
    siteIds: z.array(ObjectIdSchema).nullable(),
    siteCount: z.number().int().nonnegative(),
  })
  .meta({ id: 'PortalScope' });

/* ── Dashboard (M5.7 · F26) ───────────────────────────────────────────────── */

/**
 * M5.7's whole purpose: *"replaces phoning the office to ask."*
 *
 * So the fields answer the questions that generate those calls — where is my
 * pickup, is anything late, what did we divert — and nothing else. A dashboard
 * that answers a question nobody rings about is a dashboard nobody opens.
 */
export const PortalDashboardSchema = z
  .object({
    generatedAt: IsoDateTimeSchema,
    openJobs: z.number().int().nonnegative(),
    /** The next pickup, because "when are you coming" is call number one. */
    nextPickup: z
      .object({
        jobId: ObjectIdSchema,
        jobNumber: z.number().int().positive(),
        siteName: NonEmptyStringSchema,
        readyDate: IsoDateSchema,
        status: JobStatusSchema,
        driverName: z.string().nullable(),
      })
      .nullable(),
    /** M2.4a — past, or about to pass, ready date + 5 business days. */
    atRiskJobs: z.number().int().nonnegative(),
    completedThisMonth: z.number().int().nonnegative(),
    areaThisMonthM2: z.number().nonnegative(),
    /** Null on m²-only accounts — a zero would read as "nothing recovered". */
    tonnesThisMonth: z.number().nonnegative().nullable(),
    /** Null for a site supervisor (M1.5). */
    outstandingInvoiceCount: z.number().int().nonnegative().nullable(),
    outstandingInvoiceTotalIncGst: MoneySchema.nullable(),
    /**
     * M8.3 · F17 + F65 — jobs whose readiness the site has not yet confirmed.
     * This is the direct attack on futile pickups: the reminder asks, and this
     * is where an unanswered ask becomes visible.
     */
    awaitingReadinessConfirmation: z.number().int().nonnegative(),
  })
  .meta({ id: 'PortalDashboard' });

/* ── Jobs (M5.7, M5.8, M5.9) ──────────────────────────────────────────────── */

export const PortalJobListItemSchema = z
  .object({
    id: ObjectIdSchema,
    jobNumber: z.number().int().positive(),
    status: JobStatusSchema,
    siteId: ObjectIdSchema,
    siteName: NonEmptyStringSchema,
    suburb: NonEmptyStringSchema,
    reference: z.string().nullable(),
    poNumber: z.string().nullable(),
    readyDate: IsoDateSchema,
    targetDate: IsoDateSchema,
    serviceLevel: ServiceLevelSchema,
    expectedAreaM2: z.number().nonnegative(),
    recoveredWeightKg: z.number().nonnegative().nullable(),
    bagCount: z.number().int().nonnegative(),
    /** ⚠️ Null for a site supervisor. Nulled by the SERVER, not the client. */
    totalIncGst: MoneySchema.nullable(),
    completedAt: IsoDateTimeSchema.nullable(),
    photoCount: z.number().int().nonnegative(),
    /**
     * M5.4 — the client's own rule: a job can be edited freely until it is on a
     * run sheet; after that a change is a *request* that routes to the office.
     * Computed server-side so the two surfaces cannot disagree about it.
     */
    editable: z.boolean(),
    /** M5.2 — has someone certified this job ready? */
    readinessCertifiedAt: IsoDateTimeSchema.nullable(),
    readinessCertifiedBy: z.string().nullable(),
  })
  .meta({ id: 'PortalJobListItem' });

/** One step in the customer-facing progress trail. */
export const PortalJobStepSchema = z
  .object({
    id: ObjectIdSchema,
    label: NonEmptyStringSchema,
    at: IsoDateTimeSchema,
    /** The office actor is deliberately NOT named to the customer. */
    by: z.string().nullable(),
  })
  .meta({ id: 'PortalJobStep' });

export const PortalJobSchema = PortalJobListItemSchema.extend({
  builderName: z.string(),
  zone: ZoneSchema,
  notes: z.string(),
  driverName: z.string().nullable(),
  arrivedAt: IsoDateTimeSchema.nullable(),
  /** M5.9 — the full completion record, all photos included. */
  photos: z.array(JobPhotoSchema),
  steps: z.array(PortalJobStepSchema),
  /** Comments the office marked customer-visible (M2.11). */
  messages: z.array(
    z.object({
      id: ObjectIdSchema,
      body: NonEmptyStringSchema,
      author: NonEmptyStringSchema,
      at: IsoDateTimeSchema,
      fromCustomer: z.boolean(),
    }),
  ),
  /** Diversion certificate for this job, once issued (M9.5 · F52). */
  certificateReference: z.string().nullable(),
}).meta({ id: 'PortalJob' });

/**
 * The statuses where "is it ready?" is still a live question (M5.2).
 *
 * Lives in the contract, not in a component, because three separate consumers
 * need the same answer: the row badge, the list filter and the dashboard
 * counter. They disagreed once — the filter matched completed pickups, which
 * carry no readiness badge and have nothing left to action, so "not yet
 * confirmed" returned rows showing a dash and the count did not match the list
 * it linked to. One definition, one behaviour.
 */
export const PENDING_READINESS_STATUSES: readonly JobStatus[] = [
  'booked',
  'assigned',
  'acknowledged',
];

/* ── Booking (M5.1 · F9, F21, W88 + M5.2 · W86) ───────────────────────────── */

/**
 * M5.2 — the three certifications, captured against a named authenticated user.
 *
 * ── Why these are three booleans and not one checkbox ─────────────────────
 * Because they are three different promises, and the futile charge stands or
 * falls on which one was broken. *"David Chen, GJ Gardner, certified on 12 Aug
 * at 14:32 that this job would be ready"* is only defensible if what he
 * certified is recorded separately from what he did not.
 *
 * All three are required to book. That is the point: today the equivalent is a
 * typed name in a text box.
 */
export const ReadinessCertificationSchema = z
  .object({
    jobReady: z.literal(true, {
      error: 'Confirm the board will be stacked and ready on the ready date',
    }),
    truckAccessible: z.literal(true, {
      error: 'Confirm a truck can get to the pile — this is the top cause of futile pickups',
    }),
    freeOfContaminants: z.literal(true, {
      error: 'Confirm the plasterboard is free of timber, insulation and other waste',
    }),
  })
  .meta({ id: 'ReadinessCertification' });

/**
 * M5.1 — roughly four fields, against today's seventeen.
 *
 * Account, builder, address and contact are all absent BY DESIGN: the session
 * already knows them, and the account name being a free-text field is exactly
 * why leads currently arrive disguised as jobs.
 */
export const PortalBookingDraftSchema = z
  .object({
    siteId: ObjectIdSchema.refine((value) => value.length > 0, 'Choose the site'),
    readyDate: IsoDateSchema,
    expectedAreaM2: z
      .number({ error: 'Enter the expected square metres' })
      .positive('Must be more than zero')
      .max(100000, 'That is larger than any job on record — check the figure'),
    bagCount: z.number().int().min(0).max(200),
    serviceLevel: ServiceLevelSchema,
    reference: z.string().trim().max(60),
    /** Required only where the account's PO policy demands it (M2.10). */
    poNumber: z.string().trim().max(60),
    notes: z.string().trim().max(1000),
    certification: ReadinessCertificationSchema,
  })
  .meta({ id: 'PortalBookingDraft' });

/** M5.4 — an edit to a job that is still editable. No certification re-ask. */
export const PortalJobEditSchema = z
  .object({
    readyDate: IsoDateSchema,
    expectedAreaM2: z.number().positive().max(100000),
    bagCount: z.number().int().min(0).max(200),
    serviceLevel: ServiceLevelSchema,
    reference: z.string().trim().max(60),
    poNumber: z.string().trim().max(60),
    notes: z.string().trim().max(1000),
  })
  .meta({ id: 'PortalJobEdit' });

/** M5.4 — once the job is on a run sheet, a change becomes a request. */
export const PortalChangeRequestSchema = z
  .object({
    kind: z.enum(['reschedule', 'cancel', 'other']),
    requestedDate: IsoDateSchema.nullable(),
    note: z.string().trim().min(1, 'Tell the office what you need changed').max(500),
  })
  .meta({ id: 'PortalChangeRequest' });

/* ── Sites (M5.3 · W87, W98 + M5.6 · F46, W92) ────────────────────────────── */

export const PortalSiteSchema = z
  .object({
    id: ObjectIdSchema,
    name: NonEmptyStringSchema,
    lotNumber: z.string().nullable(),
    addressLine: NonEmptyStringSchema,
    suburb: NonEmptyStringSchema,
    postcode: z.string(),
    zone: ZoneSchema,
    builderName: z.string(),
    /** M5.3 — the fields the supervisor maintains themselves. */
    accessNotes: z.string(),
    gateHours: z.string().nullable(),
    inductionRequired: z.boolean(),
    craneAvailable: z.boolean(),
    siteContactName: z.string().nullable(),
    siteContactMobile: z.string().nullable(),
    /** M5.6 · F46 — preferred windows and blackout times, per site. */
    preferredWindow: z.string().nullable(),
    blackoutNote: z.string().nullable(),
    openJobCount: z.number().int().nonnegative(),
    totalJobCount: z.number().int().nonnegative(),
    lastJobAt: IsoDateTimeSchema.nullable(),
    /**
     * B.1 — every site carries a shareable booking link. This is expected to be
     * the DOMINANT route in: pasted into a site WhatsApp group, tapped, SMS
     * code, booking — under a minute, on a phone, on site.
     */
    bookingLink: NonEmptyStringSchema,
  })
  .meta({ id: 'PortalSite' });

export const PortalSiteUpdateSchema = z
  .object({
    accessNotes: z.string().trim().max(1000),
    gateHours: z.string().trim().max(120),
    inductionRequired: z.boolean(),
    craneAvailable: z.boolean(),
    siteContactName: z.string().trim().max(80),
    siteContactMobile: z.string().trim().max(20),
    preferredWindow: z.string().trim().max(120),
    blackoutNote: z.string().trim().max(300),
  })
  .meta({ id: 'PortalSiteUpdate' });

/* ── Invoices (M5.10 · W72, W73) ──────────────────────────────────────────── */

export const PortalInvoiceSchema = z
  .object({
    id: z.string(),
    invoiceNumber: z.number().int().positive(),
    kind: z.enum(['base', 'additional-charges']),
    status: z.enum(['awaiting-po', 'sent', 'paid', 'overdue']),
    jobId: ObjectIdSchema.nullable(),
    jobNumber: z.number().int().positive().nullable(),
    siteName: z.string().nullable(),
    reference: z.string().nullable(),
    poNumber: z.string().nullable(),
    issuedOn: IsoDateSchema.nullable(),
    dueOn: IsoDateSchema.nullable(),
    subtotalExGst: MoneySchema,
    gst: MoneySchema,
    totalIncGst: MoneySchema,
    paidAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'PortalInvoice' });

/* ── Site supervisors (M5.14 · W70) ───────────────────────────────────────── */

export const PORTAL_SUPERVISOR_STATES = ['active', 'invited', 'suspended'] as const;
export const PortalSupervisorStateSchema = z
  .enum(PORTAL_SUPERVISOR_STATES)
  .meta({ id: 'PortalSupervisorState' });
export type PortalSupervisorState = z.infer<typeof PortalSupervisorStateSchema>;

export const PORTAL_SUPERVISOR_STATE_LABELS: Record<PortalSupervisorState, string> = {
  active: 'Active',
  invited: 'Invited',
  suspended: 'Suspended',
};

export const PortalSupervisorSchema = z
  .object({
    id: ObjectIdSchema,
    name: NonEmptyStringSchema,
    email: z.string().nullable(),
    mobile: z.string().nullable(),
    state: PortalSupervisorStateSchema,
    /** `null` = every site. Otherwise the specific sites they may book for. */
    siteIds: z.array(ObjectIdSchema).nullable(),
    siteNames: z.array(z.string()),
    invitedAt: IsoDateTimeSchema,
    lastSignedInAt: IsoDateTimeSchema.nullable(),
    /** B.2 — set when they joined by customer code and need approving. */
    awaitingApproval: z.boolean(),
  })
  .meta({ id: 'PortalSupervisor' });

/**
 * M5.14 — invite a supervisor.
 *
 * Mobile OR email, at least one, because §9's primary channel for a site
 * supervisor is SMS: *"many site supervisors and subcontractors use personal
 * Gmail addresses or only have a mobile"* (B.4's own caveat). Requiring email
 * would exclude the exact population this screen exists to serve.
 */
export const PortalSupervisorInviteSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter their name').max(80),
    email: z.string().trim().max(160),
    mobile: z.string().trim().max(20),
    /** Empty array = all sites. */
    siteIds: z.array(ObjectIdSchema),
  })
  .refine((value) => value.email.length > 0 || value.mobile.length > 0, {
    error: 'Give a mobile or an email — a mobile is usually faster on site',
    path: ['mobile'],
  })
  .meta({ id: 'PortalSupervisorInvite' });

/* ── Account preferences (M5.15 · F29, W71, W81) ──────────────────────────── */

export const PortalAccountSchema = z
  .object({
    accountId: ObjectIdSchema,
    customerCode: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    abn: z.string(),
    /** Read-only in the portal: changing terms is a commercial negotiation. */
    paymentTermsDays: z.number().int().nonnegative(),
    poPolicy: z.enum(['not-required', 'required-before-invoice']),
    captureMode: z.enum(['area-only', 'area-and-weight']),
    primaryZone: ZoneSchema,
    contacts: z.array(
      z.object({
        id: ObjectIdSchema,
        name: NonEmptyStringSchema,
        role: z.enum(['site', 'accounts', 'sustainability']),
        email: z.string().nullable(),
        mobile: z.string().nullable(),
        notifyBySms: z.boolean(),
        notifyByEmail: z.boolean(),
      }),
    ),
    preferredPickupWindow: z.string().nullable(),
    /** B.2 — whether a join-by-code needs approving before it works. */
    approveNewSupervisors: z.boolean(),
  })
  .meta({ id: 'PortalAccount' });

export const PortalAccountUpdateSchema = z
  .object({
    preferredPickupWindow: z.string().trim().max(120),
    approveNewSupervisors: z.boolean(),
    contacts: z.array(
      z.object({
        id: ObjectIdSchema,
        notifyBySms: z.boolean(),
        notifyByEmail: z.boolean(),
      }),
    ),
  })
  .meta({ id: 'PortalAccountUpdate' });

export type PortalScope = z.infer<typeof PortalScopeSchema>;
export type PortalDashboard = z.infer<typeof PortalDashboardSchema>;
export type PortalJobListItem = z.infer<typeof PortalJobListItemSchema>;
export type PortalJobStep = z.infer<typeof PortalJobStepSchema>;
export type PortalJob = z.infer<typeof PortalJobSchema>;
export type ReadinessCertification = z.infer<typeof ReadinessCertificationSchema>;
export type PortalBookingDraft = z.infer<typeof PortalBookingDraftSchema>;
export type PortalJobEdit = z.infer<typeof PortalJobEditSchema>;
export type PortalChangeRequest = z.infer<typeof PortalChangeRequestSchema>;
export type PortalSite = z.infer<typeof PortalSiteSchema>;
export type PortalSiteUpdate = z.infer<typeof PortalSiteUpdateSchema>;
export type PortalInvoice = z.infer<typeof PortalInvoiceSchema>;
export type PortalSupervisor = z.infer<typeof PortalSupervisorSchema>;
export type PortalSupervisorInvite = z.infer<typeof PortalSupervisorInviteSchema>;
export type PortalAccount = z.infer<typeof PortalAccountSchema>;
export type PortalAccountUpdate = z.infer<typeof PortalAccountUpdateSchema>;
