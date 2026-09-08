import { DEFECT_SEVERITIES } from '@plastago/shared';
import { Schema, model } from 'mongoose';

export const VEHICLE_DEFECTS_COLLECTION = 'vehicledefects';

/**
 * M4.9 — a defect a driver reported on a vehicle.
 *
 * ── Why this is a record and not a note on the pre-start ──────────────────
 * A failed pre-start item is not a box to dismiss; under Chain of Responsibility
 * it is a defect the OPERATOR has an obligation about. So it becomes a row that
 * somebody has to close, with who reported it and when — a note buried in a
 * checklist submission is not something anyone can be asked to act on.
 *
 * Its own collection rather than a field on a vehicle because a vehicle
 * accumulates defects over its life, and the question the workshop asks is
 * "what is open across the fleet", which is a query here and a scan otherwise.
 */
const defectSchema = new Schema(
  {
    /**
     * The rego, as the driver typed it on the phone.
     *
     * ⚠️ Not a reference to a fleet record, deliberately. A driver can report a
     * defect on a hired truck, or on one the office has not registered yet, and
     * a foreign key would make the report impossible to file at the exact moment
     * it matters most. The fleet screen matches on rego.
     */
    vehicleRego: { type: String, required: true, trim: true, uppercase: true },

    /** REFERENCE → `users._id`. Who found it. */
    reportedByUserId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    /** Frozen name, so the record survives the driver leaving. */
    reportedByName: { type: String, required: true, trim: true },

    severity: { type: String, required: true, enum: DEFECT_SEVERITIES },
    summary: { type: String, required: true, trim: true },
    detail: { type: String, required: false, default: '', trim: true },

    /**
     * REFERENCES → `jobphotos._id`.
     *
     * An array of ids rather than embedded photo documents: the photos are
     * uploaded independently of this report — often before it, from the driver's
     * offline queue — and they are read back through the same storage path as
     * every other photo in the system.
     */
    photoIds: [{ type: Schema.Types.ObjectId, ref: 'JobPhoto' }],

    /**
     * When the DRIVER reported it, not when the server heard about it.
     *
     * A run synced at the end of the day would otherwise collapse into one
     * timestamp — and "when did we know the brakes were soft" is the question
     * this record exists to answer.
     */
    occurredAt: { type: Date, required: true },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },

    /**
     * Raised by a failed pre-start item rather than reported on its own.
     * REFERENCE → `jobprestarts._id`.
     */
    preStartId: { type: Schema.Types.ObjectId, default: null, ref: 'JobPreStart' },
    /** The checklist item that failed, where it came from one. */
    preStartItemKey: { type: String, default: null },

    /**
     * open → scheduled → resolved.
     *
     * `scheduled` rather than `acknowledged`: "booked in for Thursday" is
     * neither broken-and-ignored nor fixed, and it is the state the workshop
     * actually works from. Merely acknowledging something says nothing about
     * whether anybody is going to do it.
     */
    status: {
      type: String,
      required: true,
      enum: ['open', 'scheduled', 'resolved'],
      default: 'open',
    },
    /** When it is booked in, once somebody books it. */
    scheduledFor: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    resolutionNote: { type: String, default: null, trim: true },
  },
  { collection: VEHICLE_DEFECTS_COLLECTION, timestamps: true, versionKey: false },
);

/** The workshop's list: everything still open, worst first. */
defectSchema.index({ status: 1, severity: 1, occurredAt: -1 }, { name: 'open_by_severity' });

/** One vehicle's history, for the fleet screen. */
defectSchema.index({ vehicleRego: 1, occurredAt: -1 }, { name: 'vehicle_history' });

/**
 * ⚠️ An unroadworthy report is the one that has to reach somebody TODAY.
 * A partial index keeps this tiny and makes the alert sweep a seek.
 */
defectSchema.index(
  { occurredAt: -1 },
  {
    name: 'unroadworthy_open',
    partialFilterExpression: { severity: 'unroadworthy', status: 'open' },
  },
);

export const VehicleDefectModel = model('VehicleDefect', defectSchema);
