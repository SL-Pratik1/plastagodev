import * as z from 'zod';
import {
  IsoDateSchema,
  IsoDateTimeSchema,
  MoneySchema,
  NonEmptyStringSchema,
  ObjectIdSchema,
} from './primitives.js';

/**
 * Drivers and vehicles (M9.7 · F43, M9.8 · F53, M9.9 · F22).
 *
 * ── The reminder is the feature, not the register ──────────────────────────
 * They already have a vehicle-maintenance module in TransVirtual and do not
 * maintain it: four of their five vehicles show service dates in the past. Same
 * for licences. So every record here carries a computed expiry state, and the
 * screens lead with what is expiring rather than with the list.
 *
 * ── Deliberately simple ───────────────────────────────────────────────────
 * Matt on vehicle expenses: *"I don't need all parts and labour and that
 * breakdown. Keep it simple."* So an expense is a date, an odometer reading, a
 * description and a price — nothing more. Resisting the urge to model a full
 * maintenance system is the requirement.
 */

/**
 * How close an expiry is, computed server-side so every surface agrees.
 *
 * The thresholds are the documented ones and they differ by kind: licences and
 * tickets warn a **month** out (F53), registration **two weeks** out (F43).
 * Putting the state on the record rather than deriving it per screen is what
 * stops one page saying "expiring" while another still says "valid".
 */
export const EXPIRY_STATES = ['valid', 'due-soon', 'expired'] as const;
export const ExpiryStateSchema = z.enum(EXPIRY_STATES).meta({ id: 'ExpiryState' });
export type ExpiryState = z.infer<typeof ExpiryStateSchema>;

export const EXPIRY_STATE_LABELS: Record<ExpiryState, string> = {
  valid: 'Valid',
  'due-soon': 'Expiring soon',
  expired: 'Expired',
};

/* ── Drivers ──────────────────────────────────────────────────────────────── */

/**
 * F53 — the credential types, admin-managed with a lead time per type.
 *
 * Matt preferred a register of types over hard-coded fields: *"define the types
 * once, set the lead time per type, apply against driver profiles."* The union
 * is the set he named; the lead time lives on the type in settings.
 */
export const CREDENTIAL_TYPES = [
  'drivers-licence',
  'white-card',
  'crane-ticket-class-3',
  'crane-ticket-class-4',
  'hvnl-medical',
] as const;
export const CredentialTypeSchema = z.enum(CREDENTIAL_TYPES).meta({ id: 'CredentialType' });
export type CredentialType = z.infer<typeof CredentialTypeSchema>;

export const CREDENTIAL_TYPE_LABELS: Record<CredentialType, string> = {
  'drivers-licence': 'Driver’s licence',
  'white-card': 'White card',
  'crane-ticket-class-3': 'Crane ticket — class 3',
  'crane-ticket-class-4': 'Crane ticket — class 4',
  'hvnl-medical': 'Heavy vehicle medical',
};

export const DriverCredentialSchema = z
  .object({
    id: ObjectIdSchema,
    type: CredentialTypeSchema,
    reference: z.string().nullable(),
    issuedOn: IsoDateSchema.nullable(),
    expiresOn: IsoDateSchema.nullable(),
    state: ExpiryStateSchema,
    /** F53 names a licence PHOTO specifically. */
    hasDocument: z.boolean(),
  })
  .meta({ id: 'DriverCredential' });

/** F53 — "driver training records". */
export const DriverTrainingSchema = z
  .object({
    id: ObjectIdSchema,
    name: NonEmptyStringSchema,
    completedOn: IsoDateSchema,
    expiresOn: IsoDateSchema.nullable(),
    state: ExpiryStateSchema,
    provider: z.string().nullable(),
  })
  .meta({ id: 'DriverTraining' });

/**
 * F22 — driver performance.
 *
 * ⚠️ Two drivers. This is framed as **operational insight and costing input**,
 * not performance management, and the screen says so — its real value is feeding
 * the cost-per-km and job-duration models. Distance and drive time only became
 * measurable because F11 is full (continuous location), so they are honest
 * numbers rather than estimates.
 */
export const DriverPerformanceSchema = z
  .object({
    periodLabel: NonEmptyStringSchema,
    jobsCompleted: z.number().int().nonnegative(),
    jobsPerWorkingDay: z.number().nonnegative(),
    medianOnSiteMinutes: z.number().int().nonnegative().nullable(),
    futileCount: z.number().int().nonnegative(),
    futileRatePercent: z.number().nonnegative(),
    contaminationCount: z.number().int().nonnegative(),
    contaminationRatePercent: z.number().nonnegative(),
    /** Their photo protocol expects ~10 per job; this is adherence to it. */
    photoCompliancePercent: z.number().nonnegative(),
    /** M2.4a — collected within ready date + 5 business days. */
    slaAdherencePercent: z.number().nonnegative(),
    distanceKm: z.number().nonnegative().nullable(),
  })
  .meta({ id: 'DriverPerformance' });

export const DRIVER_EMPLOYMENT = ['subcontractor', 'employee'] as const;
export const DriverEmploymentSchema = z.enum(DRIVER_EMPLOYMENT).meta({ id: 'DriverEmployment' });
export type DriverEmployment = z.infer<typeof DriverEmploymentSchema>;

export const DriverListItemSchema = z
  .object({
    id: ObjectIdSchema,
    name: NonEmptyStringSchema,
    mobile: z.string(),
    email: z.email().nullable(),
    active: z.boolean(),
    /** Confirmed on Call 2: "basically all of our guys are subcontractors". */
    employment: DriverEmploymentSchema,
    vehicleRego: z.string().nullable(),
    vehicleLabel: z.string().nullable(),
    dailyJobCapacity: z.number().int().positive(),
    jobsToday: z.number().int().nonnegative(),
    /** The soonest credential expiry, and its state — the reminder surface. */
    nextExpiryOn: IsoDateSchema.nullable(),
    nextExpiryState: ExpiryStateSchema,
    lastSyncAt: IsoDateTimeSchema.nullable(),
    pendingSyncActions: z.number().int().nonnegative(),
  })
  .meta({ id: 'DriverListItem' });

export const DriverProfileSchema = DriverListItemSchema.extend({
  startedOn: IsoDateSchema,
  notes: z.string(),
  credentials: z.array(DriverCredentialSchema),
  training: z.array(DriverTrainingSchema),
  performance: DriverPerformanceSchema,
}).meta({ id: 'DriverProfile' });

export type DriverCredential = z.infer<typeof DriverCredentialSchema>;
export type DriverTraining = z.infer<typeof DriverTrainingSchema>;
export type DriverPerformance = z.infer<typeof DriverPerformanceSchema>;
export type DriverListItem = z.infer<typeof DriverListItemSchema>;
export type DriverProfile = z.infer<typeof DriverProfileSchema>;

/* ── Vehicles ─────────────────────────────────────────────────────────────── */

export const VEHICLE_TYPES = ['crane-truck', 'hooklift', 'ute'] as const;
export const VehicleTypeSchema = z.enum(VEHICLE_TYPES).meta({ id: 'VehicleType' });
export type VehicleType = z.infer<typeof VehicleTypeSchema>;

export const VEHICLE_TYPE_LABELS: Record<VehicleType, string> = {
  'crane-truck': 'Crane truck',
  hooklift: 'Hooklift',
  ute: 'Ute',
};

/**
 * One expense. Matt's own example: *"At 49,000 km it went in for a service, what
 * the service description was — A service, B service — and the price."*
 *
 * `odometerKm` is on the expense, not just the vehicle, because that pairing is
 * what makes cost per kilometre computable at all.
 */
export const VEHICLE_EXPENSE_KINDS = [
  'service',
  'repair',
  'tyres',
  'registration',
  'other',
] as const;
export const VehicleExpenseKindSchema = z
  .enum(VEHICLE_EXPENSE_KINDS)
  .meta({ id: 'VehicleExpenseKind' });
export type VehicleExpenseKind = z.infer<typeof VehicleExpenseKindSchema>;

export const VEHICLE_EXPENSE_KIND_LABELS: Record<VehicleExpenseKind, string> = {
  service: 'Service',
  repair: 'Repair',
  tyres: 'Tyres',
  registration: 'Registration',
  other: 'Other',
};

export const VehicleExpenseSchema = z
  .object({
    id: ObjectIdSchema,
    incurredOn: IsoDateSchema,
    odometerKm: z.number().int().nonnegative(),
    kind: VehicleExpenseKindSchema,
    /** Free text on purpose — "A service", "B service". No parts/labour split. */
    description: NonEmptyStringSchema,
    amountExGst: MoneySchema,
    supplier: z.string().nullable(),
  })
  .meta({ id: 'VehicleExpense' });

/** M4.9 · W33 — driver-reported defects land against the vehicle. */
export const VEHICLE_DEFECT_STATES = ['open', 'scheduled', 'resolved'] as const;
export const VehicleDefectStateSchema = z
  .enum(VEHICLE_DEFECT_STATES)
  .meta({ id: 'VehicleDefectState' });
export type VehicleDefectState = z.infer<typeof VehicleDefectStateSchema>;

export const VehicleDefectSchema = z
  .object({
    id: ObjectIdSchema,
    reportedOn: IsoDateSchema,
    reportedBy: NonEmptyStringSchema,
    summary: NonEmptyStringSchema,
    severity: z.enum(['low', 'medium', 'high']),
    state: VehicleDefectStateSchema,
    photoCount: z.number().int().nonnegative(),
    resolvedOn: IsoDateSchema.nullable(),
  })
  .meta({ id: 'VehicleDefect' });

/** F43 — 12 / 6 / 3 months, configurable; the date rolls forward on renewal. */
export const REGO_PERIODS = [12, 6, 3] as const;

export const VehicleListItemSchema = z
  .object({
    id: ObjectIdSchema,
    rego: NonEmptyStringSchema,
    label: NonEmptyStringSchema,
    type: VehicleTypeSchema,
    active: z.boolean(),
    odometerKm: z.number().int().nonnegative(),
    assignedDriverName: z.string().nullable(),
    /** Auto-calculated, which is the whole point of the expense log (F43). */
    costPerKm: MoneySchema.nullable(),
    lastServiceOn: IsoDateSchema.nullable(),
    nextServiceDueOn: IsoDateSchema.nullable(),
    serviceState: ExpiryStateSchema,
    registrationExpiresOn: IsoDateSchema,
    registrationState: ExpiryStateSchema,
    openDefectCount: z.number().int().nonnegative(),
  })
  .meta({ id: 'VehicleListItem' });

export const VehicleSchema = VehicleListItemSchema.extend({
  make: z.string(),
  model: z.string(),
  year: z.number().int().nullable(),
  registrationPeriodMonths: z.number().int().positive(),
  purchasedOn: IsoDateSchema.nullable(),
  notes: z.string(),
  expenses: z.array(VehicleExpenseSchema),
  defects: z.array(VehicleDefectSchema),
  /** Totals over the expense log, so the list and detail cannot disagree. */
  totalExpensesExGst: MoneySchema,
  distanceSinceFirstExpenseKm: z.number().int().nonnegative().nullable(),
}).meta({ id: 'Vehicle' });

export type VehicleExpense = z.infer<typeof VehicleExpenseSchema>;
export type VehicleDefect = z.infer<typeof VehicleDefectSchema>;
export type VehicleListItem = z.infer<typeof VehicleListItemSchema>;
export type Vehicle = z.infer<typeof VehicleSchema>;
