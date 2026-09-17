import * as z from 'zod';
import { isAustralianMobile, looksLikeEmail } from './identity.js';
import {
  AbnSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  MoneySchema,
  NonEmptyStringSchema,
  ObjectIdSchema,
} from './primitives.js';
import { AccountTypeSchema, ZoneSchema } from './party.js';
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
 * `visibility` is what narrows a Site Supervisor. It used to be a list of sites
 * assigned to them (M1.5); with the Sites module gone (Matt, 0:29) the boundary
 * is the jobs they raised themselves — the visibility Matt described anyway at
 * 18:15: *"site supervisors can submit their jobs and be able to see the jobs
 * they've submitted."*
 */
export const PortalScopeSchema = z
  .object({
    accountId: ObjectIdSchema,
    accountName: NonEmptyStringSchema,
    customerCode: NonEmptyStringSchema,
    /**
     * Builder or contractor — the two journeys Matt described at 21:55.
     *
     * A builder gets site supervisors and a short booking form, because the area
     * and bag count already came off the purchase order. A contractor gets one
     * login, no supervisors, and a form that asks for everything, because that
     * form IS the authorisation — *"they're just going to fill out the form"*
     * (22:53).
     */
    accountType: AccountTypeSchema,
    /** Whether this account records recovered weight as well as area (M2.3). */
    capturesWeight: z.boolean(),
    /** M2.10 — whether their invoices need a PO. Changes the booking form. */
    poRequired: z.boolean(),
    /**
     * The office's invoice number prefix (Matt, 7:07).
     *
     * Carried on the scope because the customer has to quote the same number
     * back when they pay, and the portal cannot read office settings. Empty
     * means plain numbers.
     */
    invoiceNumberPrefix: z.string(),
    /** M1.5 — false for every site supervisor. */
    canSeePricing: z.boolean(),
    /**
     * How much of the account this viewer sees.
     *
     * `account` for an administrator — everything. `own-jobs` for a site
     * supervisor, who sees only what they raised.
     *
     * ⚠️ Replaces the site-list scoping from M1.5, which is gone with the sites
     * (Matt, 0:29). The narrowing is still done by the SERVER; this field only
     * tells the UI what to say about it.
     */
    visibility: z.enum(['account', 'own-jobs']),
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
    siteName: NonEmptyStringSchema,
    suburb: NonEmptyStringSchema,
    /**
     * The customer's PO number or job reference — one field.
     *
     * Matt, 9:08: *"they're really interchangeable… they are one and the same,
     * we don't need both of them."* Kept under the PO name because that is what
     * has to appear on the invoice (9:56).
     */
    poNumber: z.string().nullable(),
    /** Who raised it — see `bookedByName` on `Job`. */
    bookedByName: z.string().nullable(),
    readyDate: IsoDateSchema,
    targetDate: IsoDateSchema,
    serviceLevel: ServiceLevelSchema,
    /** Null on a builder's job until the office reads it off the PO. */
    expectedAreaM2: z.number().nonnegative().nullable(),
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
  zoneId: ZoneSchema,
  /** The zone's name, resolved server-side. */
  zoneLabel: NonEmptyStringSchema,
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
export const PENDING_READINESS_STATUSES: readonly JobStatus[] = ['booked', 'assigned'];

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
    /* ── Where the pickup is ──────────────────────────────────────────
     *
     * Typed, not chosen from a saved list. There are no saved sites any more
     * (Matt, 0:29) — *"we don't ever really visit a site more than once."*
     *
     * ⚠️ The SUBURB is still chosen. It carries the zone that prices the job and
     * the pin that plots it, and neither survives free text. Everything else is
     * a house that did not exist last year.
     */
    siteName: z.string().trim().min(1, 'Name the place — drivers navigate by it').max(120),
    lotNumber: z.string().trim().max(30),
    addressLine: z.string().trim().min(1, 'Enter the street address').max(160),
    /** From the suburb picker — supplies suburb, postcode, zone and the pin. */
    placeId: z.string().trim().min(1, 'Choose the suburb from the list'),
    builderName: z.string().trim().max(120),

    /* ── Getting a truck in ───────────────────────────────────────────── */
    accessNotes: z.string().trim().max(1000),
    gateHours: z.string().trim().max(120),
    inductionRequired: z.boolean(),
    craneAvailable: z.boolean(),
    siteContactName: z.string().trim().max(80),
    siteContactMobile: z.string().trim().max(20),
    /** Often the builder's own supervisor, who has no login (Matt, 14:16). */
    siteContactEmail: z.string().trim().max(160),

    readyDate: IsoDateSchema,
    /**
     * Null when the figure comes off a purchase order instead.
     *
     * A builder's site supervisor books a pickup without knowing the area —
     * *"they're running the site, they're not going to know it's 823.4 square
     * metres"* (Matt, 29:21). Null says *"the PO has it"*; zero would say the job
     * is empty, and the difference is what the job gets invoiced at.
     */
    expectedAreaM2: z
      .number({ error: 'Enter the expected square metres' })
      .positive('Must be more than zero')
      .max(100000, 'That is larger than any job on record — check the figure')
      .nullable(),
    bagCount: z.number().int().min(0).max(200),
    serviceLevel: ServiceLevelSchema,
    /**
     * PO number or job reference — one field (Matt, 9:08).
     *
     * Required only where the account's PO policy demands it (M2.10).
     */
    poNumber: z.string().trim().max(60),
    /**
     * M2.12 — the confirmed purchase order this pickup is against.
     *
     * ── Why this is the better answer than typing a number ────────────────
     * The field above asks a supervisor to retype a reference off a document.
     * This one points at the document PlastaGo already holds — and it carries
     * the area with it, which is the figure the supervisor genuinely does not
     * know (Matt, 29:21).
     *
     * ⚠️ When set, it OVERRIDES `poNumber`, `expectedAreaM2` and `bagCount`. The
     * order is the authority: it is what the builder issued and what their
     * accounts system matches an invoice against. Resolved server-side, so a
     * caller cannot send its own area and thereby its own price.
     *
     * Null for a booking with no order behind it.
     */
    purchaseOrderId: ObjectIdSchema.nullable().default(null),
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
    /** PO number or job reference — one field (Matt, 9:08). */
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
    /** PO number or job reference — one field (Matt, 9:08). */
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
    /*
     * No site assignment.
     *
     * A supervisor used to be scoped by a list of sites chosen here. With the
     * Sites module gone (Matt, 0:29) they are scoped by the jobs they raise
     * themselves — see `PortalScope.visibility` — so there is nothing to pick
     * at the point of inviting them.
     */
  })
  .refine((value) => value.email.length > 0 || value.mobile.length > 0, {
    error: 'Give a mobile or an email — a mobile is usually faster on site',
    path: ['mobile'],
  })
  /*
   * ⚠️ The SHAPE of each, enforced here and not only in the form.
   *
   * The invite dialog already checked both — an Australian mobile, and an `@`
   * in the email — and the contract checked neither, so the guard was drawn
   * rather than enforced. Posted directly, `mobile: "hello"` and a landline
   * both returned 201 and created a real login.
   *
   * That login can never be used: Better Auth signs a supervisor in by their
   * `phoneNumber`, so a landline or a typo means the one-time code goes
   * nowhere — while the administrator is told "We have texted them a link".
   * The person is then chased by a builder who believes they have access.
   */
  .superRefine((value, ctx) => {
    if (value.mobile.length > 0 && !isAustralianMobile(value.mobile)) {
      ctx.addIssue({
        code: 'custom',
        path: ['mobile'],
        message: 'Enter an Australian mobile, e.g. 0412 345 678 — that is how they sign in',
      });
    }

    if (value.email.length > 0 && !looksLikeEmail(value.email)) {
      ctx.addIssue({
        code: 'custom',
        path: ['email'],
        message: 'That does not look like an email address',
      });
    }
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
    primaryZoneId: ZoneSchema,
    /** Resolved server-side: the portal may not read the zone register. */
    primaryZoneLabel: NonEmptyStringSchema,
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

/* ── Account onboarding (Journey A.4 · Matt, 7:32–9:24) ──────────────────── */

/**
 * What the customer fills in for themselves.
 *
 * ── Why the customer completes their own account ──────────────────────────
 * Because they are the authority on it and the office is not. A registered
 * address, a trading name, the ABN that prints on every invoice and the mailbox
 * their diversion certificates should go to are all things the office would
 * otherwise get by ringing up and asking.
 *
 * ── What the office keeps ─────────────────────────────────────────────────
 * The office sets the rate card, the PO policy and the payment terms at
 * conversion — those are a negotiation, not something a customer picks. This
 * form is only the details the customer knows better than we do.
 *
 * ⚠️ Nothing here is a commercial term. If a field on this form could change
 * what a job costs, it is on the wrong form.
 *
 * ── The terms tick is GONE ────────────────────────────────────────────────
 * This form used to end with a scrollable set of terms, the name and role of
 * the person accepting, and a tick that gated the entire portal. Removed on the
 * client's instruction — see the note in `party.ts`. Filling this in is now
 * useful rather than compulsory, and nothing is blocked by leaving it.
 */
export const AccountOnboardingSchema = z
  .object({
    legalName: z.string().trim().min(2, 'Enter the registered company name').max(120),
    tradingName: z.string().trim().max(120),
    abn: AbnSchema,
    addressLine: z.string().trim().min(1, 'Enter the registered business address').max(160),
    suburb: z.string().trim().min(1, 'Enter the suburb').max(80),
    postcode: z
      .string()
      .trim()
      .regex(/^\d{4}$/, 'Four digits'),

    /* ── Who to contact, by department ───────────────────────────────── */
    accountsContactName: z.string().trim().min(2, 'Who handles your invoices?').max(80),
    accountsContactEmail: z.email('Enter a valid email address'),
    /**
     * Where diversion certificates go — often a different team entirely.
     *
     * Matt, 31:04: *"invoices get sent to the accounts department… and I need a
     * section where we could say that certificates are sent to this specific
     * email address."* Asked here because the customer knows the answer and the
     * office does not.
     */
    certificateEmail: z
      .string()
      .trim()
      .max(160)
      .refine(
        (value) => value === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
        'Enter a valid email address, or leave it blank',
      ),
  })
  .meta({ id: 'AccountOnboarding' });

export type AccountOnboarding = z.infer<typeof AccountOnboardingSchema>;

/**
 * What the details screen needs to render.
 *
 * ⚠️ Carries what is already on file, not just a suggested name. The form is
 * re-openable now that nothing gates it, so a customer correcting one line of
 * their address must not be made to retype the other six — a form that arrives
 * blank on the second visit is how the record ends up half-filled.
 */
export const OnboardingInviteSchema = z
  .object({
    accountId: ObjectIdSchema,
    customerCode: NonEmptyStringSchema,
    /** The name the office typed at conversion — the customer may correct it. */
    suggestedLegalName: NonEmptyStringSchema,
    accountType: AccountTypeSchema,
    /** When they last completed it. Null means they never have. */
    completedAt: IsoDateTimeSchema.nullable(),
    /** What is on file now, for the form to open on. Null before it is set. */
    details: z
      .object({
        tradingName: z.string().nullable(),
        abn: z.string().nullable(),
        addressLine: z.string().nullable(),
        suburb: z.string().nullable(),
        postcode: z.string().nullable(),
        accountsContactName: z.string().nullable(),
        accountsContactEmail: z.string().nullable(),
        certificateEmail: z.string().nullable(),
      })
      .nullable(),
  })
  .meta({ id: 'OnboardingInvite' });

export type OnboardingInvite = z.infer<typeof OnboardingInviteSchema>;

export type PortalScope = z.infer<typeof PortalScopeSchema>;
export type PortalDashboard = z.infer<typeof PortalDashboardSchema>;
export type PortalJobListItem = z.infer<typeof PortalJobListItemSchema>;
export type PortalJobStep = z.infer<typeof PortalJobStepSchema>;
export type PortalJob = z.infer<typeof PortalJobSchema>;
export type ReadinessCertification = z.infer<typeof ReadinessCertificationSchema>;
export type PortalBookingDraft = z.infer<typeof PortalBookingDraftSchema>;
export type PortalJobEdit = z.infer<typeof PortalJobEditSchema>;
export type PortalChangeRequest = z.infer<typeof PortalChangeRequestSchema>;
export type PortalInvoice = z.infer<typeof PortalInvoiceSchema>;
export type PortalSupervisor = z.infer<typeof PortalSupervisorSchema>;
export type PortalSupervisorInvite = z.infer<typeof PortalSupervisorInviteSchema>;
export type PortalAccount = z.infer<typeof PortalAccountSchema>;
export type PortalAccountUpdate = z.infer<typeof PortalAccountUpdateSchema>;
