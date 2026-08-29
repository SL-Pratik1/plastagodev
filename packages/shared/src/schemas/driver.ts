import * as z from 'zod';
import {
  IsoDateSchema,
  IsoDateTimeSchema,
  MoneySchema,
  NonEmptyStringSchema,
  ObjectIdSchema,
} from './primitives.js';
import { ZoneSchema } from './party.js';
import { ExceptionReasonSchema, JobStatusSchema } from './jobs.js';

/**
 * The driver app (M4).
 *
 * ── Why this is a contract and not just types for one app ─────────────────
 * §6A.4 is explicit: the Flutter app codegens its Dart client from the published
 * spec, so these shapes are implemented **twice** — once in the React PWA and
 * once in Flutter. A shape defined inside `apps/driver` would be a shape the
 * native app has to guess at. Every field below is therefore a decision made
 * once, here.
 *
 * ── Everything here is designed to be written offline ─────────────────────
 * M4.12: the whole app works with no signal. So each mutation payload is
 * **self-contained and replayable** — it carries its own timestamp and position
 * rather than relying on "now" at the moment the server receives it. A driver
 * marks a job complete at 09:14 in a dead zone and it syncs at 11:30; the
 * on-site duration must still be right, because the Extra Load Time charge is
 * computed from it (M6.7).
 */

/* ── The run sheet (M4.1 · W35, W31, W38) ─────────────────────────────────── */

/**
 * How the load gets handled, which decides whether it can be weighed at all.
 *
 * This is the distinction M4.4's whole algorithm turns on: ~60–70% of jobs are
 * bagged and get weighed on a crane scale; ~30%+ are hand-loaded and **cannot be
 * weighed** — there is no bag to lift. Modelling it as a nullable weight would
 * lose the difference between "not weighed yet" and "unweighable".
 */
export const LOAD_TYPES = ['bagged', 'hand-load'] as const;
export const LoadTypeSchema = z.enum(LOAD_TYPES).meta({ id: 'LoadType' });
export type LoadType = z.infer<typeof LoadTypeSchema>;

export const LOAD_TYPE_LABELS: Record<LoadType, string> = {
  bagged: 'Bagged — weigh on the crane scale',
  'hand-load': 'Hand load — cannot be weighed',
};

/**
 * M4.5 — the required-photo checklist for a stop.
 *
 * Their actual protocol, in order: front of site · pile before · pile after ·
 * site closed · and if it cannot be closed, the cars still on site. That last
 * one is pure commercial defence — *"we get blamed for leaving everything open,
 * so we take evidential proof that this person was still here when we left."*
 *
 * Configurable per site or per job (Matt asked for "a prompt of what's in the
 * photos that are required, and a space to put in any others"), which is why it
 * arrives as data rather than being hard-coded in the app.
 */
export const RequiredPhotoSchema = z
  .object({
    key: NonEmptyStringSchema,
    label: NonEmptyStringSchema,
    /** Shown under the label — what a good version of this shot contains. */
    hint: z.string(),
    /** False for the conditional ones, e.g. "cars on site" if it cannot be closed. */
    required: z.boolean(),
  })
  .meta({ id: 'RequiredPhoto' });

export const DriverPhotoSchema = z
  .object({
    id: NonEmptyStringSchema,
    /** Matches a `RequiredPhoto.key`, or null for a free-form extra. */
    slot: z.string().nullable(),
    caption: NonEmptyStringSchema,
    takenAt: IsoDateTimeSchema,
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    /** False until the upload queue has drained this one (M4.12). */
    uploaded: z.boolean(),
  })
  .meta({ id: 'DriverPhoto' });

/** One stop on today's run. Flat: a run sheet must render with no lookups. */
export const RunStopSchema = z
  .object({
    jobId: ObjectIdSchema,
    jobNumber: z.number().int().positive(),
    /** 1-based position in the run. The driver navigates by "job 3 of 7". */
    sequence: z.number().int().positive(),
    status: JobStatusSchema,
    accountName: NonEmptyStringSchema,
    builderName: z.string(),
    siteName: NonEmptyStringSchema,
    /** M2.9 — the lot number is as important as the street number in a new estate. */
    lotNumber: z.string().nullable(),
    addressLine: NonEmptyStringSchema,
    suburb: NonEmptyStringSchema,
    postcode: z.string(),
    zone: ZoneSchema,
    latitude: z.number(),
    longitude: z.number(),
    expectedAreaM2: z.number().nonnegative(),
    bagCount: z.number().int().nonnegative(),
    loadType: LoadTypeSchema,
    /** M2.3 — only ask for weight where the account records it. */
    capturesWeight: z.boolean(),
    customerReference: z.string().nullable(),
    urgent: z.boolean(),
    /** M4.8b — some builders require the SRA before work may start. */
    riskAssessmentRequired: z.boolean(),
    riskAssessmentDoneAt: IsoDateTimeSchema.nullable(),
    photoCount: z.number().int().nonnegative(),
    /** True while any action for this stop is still sitting in the outbox. */
    hasQueuedActions: z.boolean(),
  })
  .meta({ id: 'RunStop' });

export const RunSheetDaySchema = z
  .object({
    date: IsoDateSchema,
    driverId: ObjectIdSchema,
    driverName: NonEmptyStringSchema,
    vehicleRego: z.string().nullable(),
    vehicleLabel: z.string().nullable(),
    stops: z.array(RunStopSchema),
    /** M4.8a — the pre-start blocks the run, so its state belongs here. */
    preStartCompletedAt: IsoDateTimeSchema.nullable(),
    /** M4.4 — set once the load has been tipped off and reconciled. */
    tipOffRecordedAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'RunSheetDay' });

/* ── Job detail (M4.1) ────────────────────────────────────────────────────── */

export const DriverJobSchema = RunStopSchema.extend({
  /** M2.9 / M5.3 — what the customer told us about getting a truck in. */
  accessNotes: z.string(),
  gateHours: z.string().nullable(),
  inductionRequired: z.boolean(),
  craneAvailable: z.boolean(),
  siteContactName: z.string().nullable(),
  siteContactMobile: z.string().nullable(),
  /** The booking note from the customer, plus anything the office added. */
  notes: z.string(),
  readyDate: IsoDateSchema,
  arrivedAt: IsoDateTimeSchema.nullable(),
  completedAt: IsoDateTimeSchema.nullable(),
  photos: z.array(DriverPhotoSchema),
  requiredPhotos: z.array(RequiredPhotoSchema),
  /** M4.3 — what has been captured so far. */
  capturedAreaM2: z.number().nonnegative().nullable(),
  craneScaleKg: z.number().nonnegative().nullable(),
  /** M8.6 · W102 — the office ↔ driver thread for this job. */
  messages: z.array(
    z.object({
      id: NonEmptyStringSchema,
      body: NonEmptyStringSchema,
      author: NonEmptyStringSchema,
      at: IsoDateTimeSchema,
      fromDriver: z.boolean(),
    }),
  ),
}).meta({ id: 'DriverJob' });

/* ── Status updates (M4.2 · F45, F11, W26, W29, W36) ──────────────────────── */

/**
 * The status transitions the driver app can make.
 *
 * The six in production plus `arrived`, which TransVirtual has no equivalent for
 * and Matt's workflow depends on: it triggers the Site Risk Assessment (M4.8) and
 * starts the on-site clock that the Extra Load Time charge is computed from.
 * `admin-complete` is deliberately absent — that is an office action.
 */
export const DRIVER_TRANSITIONS = ['acknowledged', 'in-transit', 'arrived', 'completed'] as const;
export const DriverTransitionSchema = z.enum(DRIVER_TRANSITIONS).meta({ id: 'DriverTransition' });
export type DriverTransition = z.infer<typeof DriverTransitionSchema>;

export const DRIVER_TRANSITION_LABELS: Record<DriverTransition, string> = {
  acknowledged: 'Accept job',
  'in-transit': 'Start driving',
  arrived: 'Arrived on site',
  completed: 'Complete job',
};

/**
 * A position fix, and how much to trust it.
 *
 * `accuracy` is carried because a 2,000-metre fix from a cell tower is not
 * evidence of anything, and a futile charge defended with one would not survive
 * a challenge. Null when the driver denied location or no fix was available —
 * which must not block the action: a driver in a basement car park still has to
 * be able to mark a job complete.
 */
export const GeoFixSchema = z
  .object({
    latitude: z.number(),
    longitude: z.number(),
    accuracyMetres: z.number().nonnegative().nullable(),
  })
  .meta({ id: 'GeoFix' });

/**
 * Every driver mutation carries these two.
 *
 * `occurredAt` is when the DRIVER did it, not when the server heard about it.
 * Without that, a run synced at the end of the day collapses into one timestamp
 * and the on-site durations — and the charge derived from them — are fiction.
 */
export const DriverActionEnvelopeSchema = z
  .object({
    occurredAt: IsoDateTimeSchema,
    position: GeoFixSchema.nullable(),
  })
  .meta({ id: 'DriverActionEnvelope' });

export const StatusUpdateSchema = DriverActionEnvelopeSchema.extend({
  transition: DriverTransitionSchema,
}).meta({ id: 'StatusUpdate' });

/* ── Weights (M4.3 · F34, W30, W44) ──────────────────────────────────────── */

/**
 * M4.3 — m² and kg are two different quantities, not two units.
 *
 *  • `areaM2` is the board installed in the house. It is what gets **priced**,
 *    and it is usually known before the pickup from the builder's order.
 *  • `craneScaleKg` is the waste actually **recovered**, weighed on the day.
 *
 * `craneScaleKg` is null on a hand-load job — not zero. There is no bag to lift,
 * so no measurement exists, and a zero would enter the tip-off reconciliation as
 * "we collected nothing" and skew every imputed weight on the run.
 */
export const WeightCaptureSchema = DriverActionEnvelopeSchema.extend({
  areaM2: z.number().positive('Enter the square metres collected').max(100000),
  bagCount: z.number().int().min(0).max(200),
  loadType: LoadTypeSchema,
  craneScaleKg: z.number().positive().max(20000).nullable(),
}).meta({ id: 'WeightCapture' });

/* ── Tip-off reconciliation (M4.4) ───────────────────────────────────────── */

/**
 * What the driver records at the facility at the end of a run.
 *
 * One figure and a docket photo. The deduct-and-average rule is applied
 * **server-side** — it is an accounting calculation that feeds diversion
 * certificates (M9.5 · F52) and EPA RRO14 records, and it must produce the same
 * answer for the PWA and the Flutter app.
 */
export const TipOffEntrySchema = DriverActionEnvelopeSchema.extend({
  date: IsoDateSchema,
  totalKg: z
    .number()
    .positive('Enter the weighbridge figure')
    .max(50000, 'That is heavier than the truck — check the docket'),
  docketReference: z.string().trim().max(60),
  /** Mandatory in practice: the monthly tipping bill is audited against these. */
  docketPhotoId: z.string().nullable(),
}).meta({ id: 'TipOffEntry' });

/**
 * The reconciliation, as the driver sees it before confirming.
 *
 * Matt's own worked example: 5 jobs, 3 bagged @ 200 kg, tip-off 846 kg →
 * `846 − 600 = 246 ÷ 2 hand-load jobs = 123 kg each`.
 *
 * Shown to the driver rather than computed silently, because a wildly wrong
 * imputed figure usually means a mistyped crane weight — and the driver is
 * standing at the weighbridge and can still fix it.
 */
export const TipOffReconciliationSchema = z
  .object({
    date: IsoDateSchema,
    totalKg: z.number().nonnegative(),
    /** Sum of the crane-scale weights actually measured on bagged jobs. */
    measuredKg: z.number().nonnegative(),
    remainderKg: z.number(),
    handLoadJobCount: z.number().int().nonnegative(),
    /** `remainderKg ÷ handLoadJobCount`, or null when there are none. */
    imputedKgPerHandLoadJob: z.number().nullable(),
    /**
     * True when the remainder is negative or implausible — measured weights
     * exceeding the weighbridge total means something was typed wrong, and
     * committing it would corrupt a certificate.
     */
    looksWrong: z.boolean(),
    warning: z.string().nullable(),
    lines: z.array(
      z.object({
        jobId: ObjectIdSchema,
        jobNumber: z.number().int().positive(),
        siteName: NonEmptyStringSchema,
        loadType: LoadTypeSchema,
        measuredKg: z.number().nonnegative().nullable(),
        imputedKg: z.number().nonnegative().nullable(),
      }),
    ),
  })
  .meta({ id: 'TipOffReconciliation' });

/* ── Exceptions (M4.6, M4.7) ─────────────────────────────────────────────── */

/**
 * M4.6 — mark futile. This is the money loop.
 *
 * The customer certified at booking that the job was ready and accessible
 * (M5.2). Photo + GPS + timestamp at the point of failure turns a disputed phone
 * call into an invoice line that survives challenge — which is why at least one
 * photo is required and the reason is structured, never free text.
 */
export const FutileReportSchema = DriverActionEnvelopeSchema.extend({
  reason: ExceptionReasonSchema,
  note: z.string().trim().max(500),
  photoIds: z.array(z.string()).min(1, 'Take at least one photo — the charge depends on it'),
}).meta({ id: 'FutileReport' });

/** M4.7 — what the contamination was, so it becomes reportable. */
export const CONTAMINATION_TYPES = [
  'timber',
  'insulation',
  'metal',
  'general-waste',
  'wet-board',
  'other',
] as const;
export const ContaminationTypeSchema = z
  .enum(CONTAMINATION_TYPES)
  .meta({ id: 'ContaminationType' });
export type ContaminationType = z.infer<typeof ContaminationTypeSchema>;

export const CONTAMINATION_TYPE_LABELS: Record<ContaminationType, string> = {
  timber: 'Timber offcuts',
  insulation: 'Insulation',
  metal: 'Metal — track, screws, offcuts',
  'general-waste': 'General site rubbish',
  'wet-board': 'Wet or mouldy board',
  other: 'Something else',
};

export const CONTAMINATION_EXTENTS = ['light', 'moderate', 'heavy'] as const;
export const ContaminationExtentSchema = z
  .enum(CONTAMINATION_EXTENTS)
  .meta({ id: 'ContaminationExtent' });
export type ContaminationExtent = z.infer<typeof ContaminationExtentSchema>;

export const CONTAMINATION_EXTENT_LABELS: Record<ContaminationExtent, string> = {
  light: 'Light — a few pieces',
  moderate: 'Moderate — through part of the load',
  heavy: 'Heavy — through most of the load',
};

/**
 * M4.7 — raises a $90 charge into the approval queue (M2.7).
 *
 * Photo evidence is mandatory for the same reason as futile: the office approves
 * it by looking at the picture, and a charge with no picture is one the customer
 * successfully disputes.
 */
export const ContaminationReportSchema = DriverActionEnvelopeSchema.extend({
  type: ContaminationTypeSchema,
  extent: ContaminationExtentSchema,
  note: z.string().trim().max(500),
  photoIds: z.array(z.string()).min(1, 'Photograph the contamination — the charge depends on it'),
}).meta({ id: 'ContaminationReport' });

/* ── Pre-start and site risk (M4.8 · F56, F14, W37, W41) ─────────────────── */

/**
 * M4.8a — the pre-start checklist, ported from their TransVirtual mobile form.
 *
 * Chain of Responsibility under the Heavy Vehicle National Law makes this an
 * **operator** obligation, not just a driver one — so it is a record kept against
 * the run, not a box the driver ticks for their own benefit. A failed item is
 * therefore not a blocker to be dismissed; it is a defect report (M4.9).
 */
export const PRE_START_ITEMS = [
  { key: 'tyres', label: 'Tyres and wheel nuts', detail: 'Tread, pressure, no visible damage' },
  {
    key: 'lights',
    label: 'Lights and indicators',
    detail: 'Head, tail, brake, indicators, beacon',
  },
  { key: 'brakes', label: 'Brakes', detail: 'Service and park brake feel normal' },
  {
    key: 'fluids',
    label: 'Oil, coolant and fuel',
    detail: 'Levels checked, no leaks under the truck',
  },
  {
    key: 'crane',
    label: 'Crane and lifting gear',
    detail: 'Hooks, straps, scale, no damage or fraying',
  },
  {
    key: 'load-restraint',
    label: 'Load restraint equipment',
    detail: 'Straps, gates, nothing missing',
  },
  {
    key: 'mirrors',
    label: 'Mirrors and windscreen',
    detail: 'Clean, adjusted, no cracks in the line of sight',
  },
  { key: 'ppe', label: 'PPE on board', detail: 'Hi-vis, boots, gloves, hard hat, glasses' },
  {
    key: 'first-aid',
    label: 'First aid and extinguisher',
    detail: 'Present, in date, seals intact',
  },
  {
    key: 'documents',
    label: 'Licence and vehicle documents',
    detail: 'On the driver or in the cab',
  },
] as const;

export const PreStartItemStateSchema = z.enum(['pass', 'fail', 'not-applicable']);
export type PreStartItemState = z.infer<typeof PreStartItemStateSchema>;

export const PreStartSubmissionSchema = DriverActionEnvelopeSchema.extend({
  date: IsoDateSchema,
  vehicleRego: z.string().trim().max(12),
  odometerKm: z
    .number()
    .int('Whole kilometres')
    .positive('Enter the odometer reading')
    .max(2000000),
  items: z.array(
    z.object({
      key: NonEmptyStringSchema,
      state: PreStartItemStateSchema,
      /** Required when the state is `fail` — it becomes the defect report. */
      note: z.string().trim().max(300),
    }),
  ),
  /**
   * The driver's own declaration. A checklist with no attestation is a form; with
   * one it is a record, and Chain of Responsibility needs the record.
   */
  declaration: z.literal(true, {
    error: 'Confirm the checks were actually carried out',
  }),
}).meta({ id: 'PreStartSubmission' });

/**
 * M4.8b — the Site Risk Assessment, a **five-step workflow, not a checklist**.
 *
 * Matt described the sequence precisely: driver taps ARRIVED → the form pops up
 * automatically → they complete it on the spot → a PDF is generated (page 1 the
 * assessment, page 2 the versioned standard SWMS) → the driver scans the QR code
 * on the site fence → the PDF is uploaded to the builder's own portal.
 *
 * ⚠️ Required by some clients before the driver may start, and it has to work at
 * a fence with no signal — which is why the submission below is a plain
 * replayable payload and the PDF/QR/handoff steps are recorded as *states* on it
 * rather than being prerequisites for saving.
 */
export const SITE_HAZARDS = [
  { key: 'overhead-powerlines', label: 'Overhead powerlines' },
  { key: 'uneven-ground', label: 'Uneven or soft ground' },
  { key: 'excavation', label: 'Open excavation or trench' },
  { key: 'other-trades', label: 'Other trades working nearby' },
  { key: 'public-access', label: 'Public or pedestrian access' },
  { key: 'traffic', label: 'Traffic on the approach' },
  { key: 'restricted-access', label: 'Restricted or narrow access' },
  { key: 'weather', label: 'Weather — wind, heat, rain' },
  { key: 'manual-handling', label: 'Manual handling required' },
  { key: 'no-hazards', label: 'No significant hazards identified' },
] as const;

export const RISK_CONTROLS = [
  { key: 'exclusion-zone', label: 'Exclusion zone set up' },
  { key: 'spotter', label: 'Spotter used' },
  { key: 'ppe', label: 'PPE worn' },
  { key: 'repositioned', label: 'Truck repositioned' },
  { key: 'crane-limits', label: 'Crane operated within limits' },
  { key: 'site-supervisor', label: 'Spoke to the site supervisor' },
  { key: 'stopped-work', label: 'Work stopped — unsafe to proceed' },
] as const;

export const SiteRiskAssessmentSchema = DriverActionEnvelopeSchema.extend({
  jobId: ObjectIdSchema,
  hazardKeys: z.array(z.string()).min(1, 'Select the hazards, or "no significant hazards"'),
  controlKeys: z.array(z.string()).min(1, 'Select at least one control'),
  note: z.string().trim().max(500),
  /** True when the driver judged it unsafe — the office is alerted immediately. */
  safeToProceed: z.boolean(),
  /** The version of the standard SWMS merged in as page 2. Updated yearly. */
  swmsVersion: NonEmptyStringSchema,
  /** Step 4 — scanned off the site fence. Null when the site has no QR code. */
  builderPortalCode: z.string().nullable(),
}).meta({ id: 'SiteRiskAssessment' });

/** Where an assessment has got to in the five-step sequence. */
/*
 * ⚠️ `SRA_STEP_STATES` now lives in `jobs.ts` and is re-exported here.
 *
 * Not a tidy-up: the office's job compliance record needs the same enum, and
 * this module already imports `jobs.ts`. Declaring it here and importing it
 * there would have been a cycle — which with Zod means a schema evaluated
 * before its dependency exists, i.e. a crash at module load rather than a type
 * error. The definition sits in the module with no inbound edge.
 */
export { SRA_STEP_STATES, SraUploadStateSchema, type SraUploadState } from './jobs.js';

/* ── Vehicle defects (M4.9 · F43, W33) ───────────────────────────────────── */

export const DEFECT_SEVERITIES = ['monitor', 'needs-attention', 'unroadworthy'] as const;
export const DefectSeveritySchema = z.enum(DEFECT_SEVERITIES).meta({ id: 'DefectSeverity' });
export type DefectSeverity = z.infer<typeof DefectSeveritySchema>;

export const DEFECT_SEVERITY_LABELS: Record<DefectSeverity, string> = {
  monitor: 'Keep an eye on it',
  'needs-attention': 'Needs booking in',
  unroadworthy: 'Unsafe to drive',
};

export const DefectReportSchema = DriverActionEnvelopeSchema.extend({
  vehicleRego: NonEmptyStringSchema,
  severity: DefectSeveritySchema,
  summary: z.string().trim().min(1, 'Say what is wrong').max(120),
  detail: z.string().trim().max(500),
  photoIds: z.array(z.string()),
}).meta({ id: 'DefectReport' });

/* ── Notes on completion (M4.10 — plain note, F41 is OUT) ────────────────── */

export const CompletionSchema = DriverActionEnvelopeSchema.extend({
  note: z.string().trim().max(1000),
}).meta({ id: 'Completion' });

/** What a completed job is worth in exception charges — shown as confirmation. */
export const DriverChargeNoticeSchema = z
  .object({
    code: NonEmptyStringSchema,
    label: NonEmptyStringSchema,
    amountExGst: MoneySchema,
  })
  .meta({ id: 'DriverChargeNotice' });

export type RequiredPhoto = z.infer<typeof RequiredPhotoSchema>;
export type DriverPhoto = z.infer<typeof DriverPhotoSchema>;
export type RunStop = z.infer<typeof RunStopSchema>;
export type RunSheetDay = z.infer<typeof RunSheetDaySchema>;
export type DriverJob = z.infer<typeof DriverJobSchema>;
export type GeoFix = z.infer<typeof GeoFixSchema>;
export type DriverActionEnvelope = z.infer<typeof DriverActionEnvelopeSchema>;
export type StatusUpdate = z.infer<typeof StatusUpdateSchema>;
export type WeightCapture = z.infer<typeof WeightCaptureSchema>;
export type TipOffEntry = z.infer<typeof TipOffEntrySchema>;
export type TipOffReconciliation = z.infer<typeof TipOffReconciliationSchema>;
export type FutileReport = z.infer<typeof FutileReportSchema>;
export type ContaminationReport = z.infer<typeof ContaminationReportSchema>;
export type PreStartSubmission = z.infer<typeof PreStartSubmissionSchema>;
export type SiteRiskAssessment = z.infer<typeof SiteRiskAssessmentSchema>;
export type DefectReport = z.infer<typeof DefectReportSchema>;
export type Completion = z.infer<typeof CompletionSchema>;
export type DriverChargeNotice = z.infer<typeof DriverChargeNoticeSchema>;
