import { VEHICLE_EXPENSE_KINDS, VEHICLE_TYPES } from '@plastago/shared';
import { Schema, model } from 'mongoose';

export const VEHICLES_COLLECTION = 'vehicles';
export const VEHICLE_EXPENSES_COLLECTION = 'vehicleexpenses';

/**
 * A vehicle (M9.7 · F43).
 *
 * ── What is stored here and what is derived ───────────────────────────────
 * Matt's own framing: the odometer and the expenses go IN, and cost per
 * kilometre comes OUT. So nothing on this document is a cost figure — the
 * totals, the cost per kilometre, the last service date and both expiry badges
 * are all computed from the expense log.
 *
 * ⚠️ Letting anyone type a cost per kilometre would be the fastest way to make
 * the one number this whole screen exists to produce untrustworthy.
 */
const vehicleSchema = new Schema(
  {
    /** The plate. Uppercased, because a driver typing `bq12ab` means the same. */
    rego: { type: String, required: true, trim: true, uppercase: true },
    /** What the office calls it — "Isuzu FVZ crane truck". */
    label: { type: String, required: true, trim: true },
    type: { type: String, required: true, enum: VEHICLE_TYPES },

    make: { type: String, required: false, default: '', trim: true },
    model: { type: String, required: false, default: '', trim: true },
    year: { type: Number, default: null, min: 1980, max: 2100 },

    /**
     * The current reading.
     *
     * Moved forward by an expense that records a higher one — an expense
     * carries its own odometer (see below), and the newest of those IS the
     * current reading. Storing it separately means the truck's own screen and
     * its expense log can disagree, so this only ever moves up.
     */
    odometerKm: { type: Number, required: true, min: 0, default: 0 },

    /**
     * In service, or off the road.
     *
     * ⚠️ Never a delete. A truck that did 400 jobs last year has to stay
     * attributable — the same rule as a suspended user.
     */
    active: { type: Boolean, required: true, default: true },

    /**
     * The driver it is paired with, as a NAME.
     *
     * Not a reference: the pairing is an operational convenience shown on two
     * screens, and it has to survive the driver leaving without orphaning the
     * truck. One-to-one — assigning a driver here clears them elsewhere.
     */
    assignedDriverName: { type: String, default: null, trim: true },

    /* ── Registration (F43) ──────────────────────────────────────────── */
    registrationExpiresOn: { type: String, required: true },
    /** 12 / 6 / 3 months. The renewal rolls the date forward by this. */
    registrationPeriodMonths: { type: Number, required: true, min: 1, max: 12, default: 12 },

    /**
     * W113 — when the next service is booked. The allocator's job.
     *
     * Distinct from the LAST service, which is derived from the expense log:
     * this is a plan, that is a fact, and conflating them means a truck that
     * was serviced yesterday still shows as due.
     */
    nextServiceDueOn: { type: String, default: null },

    purchasedOn: { type: String, default: null },
    notes: { type: String, required: false, default: '', trim: true },
  },
  { collection: VEHICLES_COLLECTION, timestamps: true, versionKey: false },
);

/** One vehicle per plate. Two rows for one truck makes its history unreadable. */
vehicleSchema.index({ rego: 1 }, { unique: true, name: 'rego_unique' });

/** The fleet list — in-service first, then by plate. */
vehicleSchema.index({ active: -1, rego: 1 }, { name: 'active_rego' });

/**
 * ⚠️ The expiry sweep that produces the reminder (M9.8).
 *
 * Registration is the one that grounds a truck legally, so it is indexed on its
 * own rather than being found by a scan the day somebody remembers to look.
 */
vehicleSchema.index({ registrationExpiresOn: 1 }, { name: 'rego_expiry' });
vehicleSchema.index({ nextServiceDueOn: 1 }, { name: 'service_due' });

/** Finding the truck a driver-reported defect belongs to. */
vehicleSchema.index({ assignedDriverName: 1 }, { name: 'assigned_driver' });

export const VehicleModel = model('Vehicle', vehicleSchema);

/**
 * One expense against a vehicle (F43).
 *
 * Matt's own example: *"At 49,000 km it went in for a service, what the service
 * description was — A service, B service — and the price."*
 *
 * ⚠️ `odometerKm` is REQUIRED and lives on the expense, not just on the
 * vehicle. That pairing is what makes cost per kilometre computable at all: an
 * expense with no reading contributes a cost with no distance to divide it by,
 * which silently skews the figure rather than failing loudly.
 */
const vehicleExpenseSchema = new Schema(
  {
    /** REFERENCE → `vehicles._id`. */
    vehicleId: { type: Schema.Types.ObjectId, required: true, ref: 'Vehicle' },

    /** A calendar day, not an instant — an invoice is dated, not timestamped. */
    incurredOn: { type: String, required: true },
    odometerKm: { type: Number, required: true, min: 0 },
    kind: { type: String, required: true, enum: VEHICLE_EXPENSE_KINDS },

    /**
     * Free text on purpose — "A service", "B service".
     *
     * No parts/labour split, deliberately: PlastaGo receives one invoice with
     * one number on it, and a breakdown nobody has would be a form field
     * somebody guesses at.
     */
    description: { type: String, required: true, trim: true },

    /** `Decimal128`, never a float (§6A.10 #1). Cost per km divides this. */
    amountExGst: { type: Schema.Types.Decimal128, required: true },
    supplier: { type: String, default: null, trim: true },

    /** Who entered it. The expense log is an audit trail as well as a total. */
    recordedBy: { type: String, required: true, trim: true },
  },
  { collection: VEHICLE_EXPENSES_COLLECTION, timestamps: true, versionKey: false },
);

/** The vehicle's own log, newest first — and the basis of every total. */
vehicleExpenseSchema.index({ vehicleId: 1, incurredOn: -1 }, { name: 'vehicle_incurred' });

/** The last service, which the list badge is derived from. */
vehicleExpenseSchema.index({ vehicleId: 1, kind: 1, incurredOn: -1 }, { name: 'vehicle_kind' });

export const VehicleExpenseModel = model('VehicleExpense', vehicleExpenseSchema);
