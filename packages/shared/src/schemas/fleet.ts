import * as z from 'zod';
import {
  IsoDateSchema,
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

/**
 * F22 — driver performance.
 *
 * ⚠️ Two drivers. This is framed as **operational insight and costing input**,
 * not performance management, and the screen says so — its real value is feeding
 * the cost-per-km and job-duration models.
 *
 * `distanceKm` used to sit here and was always null: it needs F11's continuous
 * location, which is not recorded. A field that can only ever render an em dash
 * is a promise the product does not keep, so it went rather than waiting.
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
    /** Their photo protocol names four required shots; this is adherence to it. */
    photoCompliancePercent: z.number().nonnegative(),
    /** M2.4a — collected on or before the job's target date. */
    slaAdherencePercent: z.number().nonnegative(),
  })
  .meta({ id: 'DriverPerformance' });

export const DRIVER_EMPLOYMENT = ['subcontractor', 'employee'] as const;
export const DriverEmploymentSchema = z.enum(DRIVER_EMPLOYMENT).meta({ id: 'DriverEmployment' });
export type DriverEmployment = z.infer<typeof DriverEmploymentSchema>;

/**
 * The office's view of a driver.
 *
 * ── Why this is shorter than F53 asked for ────────────────────────────────
 * `employment`, `startedOn` and `notes` were on the roster row, and
 * `credentials` / `training` / `nextExpiryState` on their own collections — but
 * no endpoint and no form ever wrote any of them, so outside the demo seed they
 * were permanently the schema default. A credential list that is empty because
 * nothing can fill it renders as "this driver is compliant", which is the
 * opposite of what an empty compliance register means.
 *
 * `lastSyncAt` / `pendingSyncActions` went for the same reason: device
 * registration is never recorded, so they were fixed at null and 0.
 *
 * They are all recoverable from git if credential tracking is built properly —
 * which starts with a way to WRITE a credential, not a way to display one.
 */
export const DriverListItemSchema = z
  .object({
    id: ObjectIdSchema,
    name: NonEmptyStringSchema,
    mobile: z.string(),
    email: z.email().nullable(),
    active: z.boolean(),
    vehicleRego: z.string().nullable(),
    vehicleLabel: z.string().nullable(),
    dailyJobCapacity: z.number().int().positive(),
    jobsToday: z.number().int().nonnegative(),
  })
  .meta({ id: 'DriverListItem' });

export const DriverProfileSchema = DriverListItemSchema.extend({
  performance: DriverPerformanceSchema,
}).meta({ id: 'DriverProfile' });

export type DriverPerformance = z.infer<typeof DriverPerformanceSchema>;
export type DriverListItem = z.infer<typeof DriverListItemSchema>;
export type DriverProfile = z.infer<typeof DriverProfileSchema>;

/* ── Vehicles ─────────────────────────────────────────────────────────────── */

export const VEHICLE_TYPES = ['crane-truck', 'hooklift', 'ute', 'tipper'] as const;
export const VehicleTypeSchema = z.enum(VEHICLE_TYPES).meta({ id: 'VehicleType' });
export type VehicleType = z.infer<typeof VehicleTypeSchema>;

export const VEHICLE_TYPE_LABELS: Record<VehicleType, string> = {
  'crane-truck': 'Crane truck',
  hooklift: 'Hooklift',
  ute: 'Ute',
  tipper: 'Tipper',
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

/**
 * Create/edit a vehicle (M9.7 · F43).
 *
 * ── What is deliberately NOT on here ──────────────────────────────────────
 * `costPerKm`, `totalExpensesExGst`, `lastServiceOn`, `distanceSince…` and both
 * `…State` badges are all **derived from the expense log**. Letting anyone type
 * a cost per kilometre would be the fastest way to make the one number this
 * screen exists to produce untrustworthy — Matt's own framing is that odometer
 * and expenses go *in* and cost per kilometre comes *out*.
 *
 * `active` and `assignedDriverName` are absent for a different reason: they are
 * decisions taken on their own, off a menu, on a day when nobody is editing the
 * make and model. Folding them into this form would mean opening a nine-field
 * dialog to take a truck off the road.
 */
export const VehicleDraftSchema = z
  .object({
    rego: z
      .string()
      .trim()
      .min(2, 'Enter the registration plate')
      .max(10)
      .transform((value) => value.toUpperCase()),
    label: z.string().trim().min(2, 'Describe the vehicle, e.g. Isuzu FVZ crane truck').max(60),
    type: VehicleTypeSchema,
    make: z.string().trim().max(40),
    model: z.string().trim().max(40),
    year: z.number().int().min(1980).max(2100).nullable(),
    odometerKm: z.number().int().nonnegative(),
    registrationExpiresOn: IsoDateSchema,
    registrationPeriodMonths: z.number().int().positive(),
    purchasedOn: IsoDateSchema.nullable(),
    notes: z.string().trim().max(500),
  })
  .meta({ id: 'VehicleDraft' });

/**
 * One expense (F43).
 *
 * `odometerKm` is required, not optional, and that is the whole design: an
 * expense without a reading contributes a cost with no distance to divide it
 * by, which silently skews cost per kilometre rather than failing loudly.
 */
export const VehicleExpenseDraftSchema = z
  .object({
    incurredOn: IsoDateSchema,
    odometerKm: z.number().int().nonnegative(),
    kind: VehicleExpenseKindSchema,
    description: z.string().trim().min(2, 'Say what it was for, e.g. “A service”').max(120),
    amountExGst: MoneySchema,
    supplier: z.string().trim().max(60).nullable(),
  })
  .meta({ id: 'VehicleExpenseDraft' });

export type VehicleDraft = z.infer<typeof VehicleDraftSchema>;
export type VehicleExpenseDraft = z.infer<typeof VehicleExpenseDraftSchema>;
