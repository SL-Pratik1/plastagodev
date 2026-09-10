import { CREDENTIAL_TYPES, DRIVER_EMPLOYMENT } from '@plastago/shared';
import { Schema, model } from 'mongoose';

export const DRIVER_CREDENTIALS_COLLECTION = 'drivercredentials';
export const DRIVER_TRAINING_COLLECTION = 'drivertrainings';
export const DRIVER_ROSTER_COLLECTION = 'driverrosters';

/**
 * The driver roster (M9.8 · F53, M9.9 · F22) — the OFFICE's view of the driver.
 *
 * ── Why this is not the `driver` domain ───────────────────────────────────
 * `domains/driver` is the driver's own app: their run sheet, their photos, their
 * weights. This is the opposite audience — the office looking at the person:
 * their licence expiry, their training, how their week went. The frontend draws
 * the same distinction and for the same reason (`drivers` vs `driverRun`), and
 * collapsing the two would be a standing invitation to reach for the wrong one.
 *
 * ── Why there is no `drivers` collection ──────────────────────────────────
 * A driver IS a user — the same row that signs in (§9). What lives here is only
 * what a user record has no business carrying: credentials, training, and the
 * few roster-specific fields below. Everything else is read from `users`.
 *
 * ⚠️ F53 is a REMINDER surface before it is a filing cabinet. Matt's problem is
 * a licence that quietly expires, so `expiresOn` is indexed on both collections
 * and the expiry state is DERIVED at read time rather than stored — a stored
 * "valid" is a field that goes stale overnight and is wrong exactly when it
 * matters.
 */

/** The roster-only facts about a driver. One row per driver, created on demand. */
const driverRosterSchema = new Schema(
  {
    /** REFERENCE → `user._id`. The driver IS a user. */
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User', unique: true },

    /**
     * Matt, Call 2: *"basically all of our guys are subcontractors"*.
     *
     * Kept as data rather than assumed, because it changes who is responsible
     * for the licence and the insurance — and the one employee is exactly the
     * case an assumption would get wrong.
     */
    employment: {
      type: String,
      required: true,
      enum: DRIVER_EMPLOYMENT,
      default: 'subcontractor',
    },

    /** M3.4 — a simple capacity column, not an availability dashboard. */
    dailyJobCapacity: { type: Number, required: true, min: 1, default: 8 },

    startedOn: { type: String, default: null },
    /**
     * ⚠️ `required: false`, not `true` — most rosters have no note, and
     * Mongoose's `required` validator counts `''` as missing, so
     * required-with-an-empty-default rejects the exact value it defaults to.
     * See the note at the top of `jobs/job.model.ts`.
     */
    notes: { type: String, required: false, default: '', trim: true },
  },
  { collection: DRIVER_ROSTER_COLLECTION, timestamps: true, versionKey: false },
);

driverRosterSchema.index({ userId: 1 }, { unique: true, name: 'driver_unique' });

export const DriverRosterModel = model('DriverRoster', driverRosterSchema);

/** F53 — licences and tickets, with the expiry that drives the reminder. */
const driverCredentialSchema = new Schema(
  {
    /** REFERENCE → `user._id`. */
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    type: { type: String, required: true, enum: CREDENTIAL_TYPES },
    /** The licence or ticket number. Null while it is on order. */
    reference: { type: String, default: null, trim: true },
    issuedOn: { type: String, default: null },
    /**
     * Null means "does not expire". Distinct from an unknown date, which is why
     * a credential with no expiry reads `valid` rather than `expired`.
     */
    expiresOn: { type: String, default: null },
    /**
     * F53 names a licence PHOTO specifically. The bytes live in S3 like every
     * other document (§6A.10 #9); this is only the key.
     */
    storageKey: { type: String, default: null },
  },
  { collection: DRIVER_CREDENTIALS_COLLECTION, timestamps: true, versionKey: false },
);

driverCredentialSchema.index({ userId: 1, type: 1 }, { name: 'driver_type' });
/** The reminder sweep: everything expiring, across every driver. */
driverCredentialSchema.index({ expiresOn: 1 }, { name: 'credential_expiry' });

export const DriverCredentialModel = model('DriverCredential', driverCredentialSchema);

/** F53 — "driver training records". */
const driverTrainingSchema = new Schema(
  {
    /** REFERENCE → `user._id`. */
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    name: { type: String, required: true, trim: true },
    completedOn: { type: String, required: true },
    /** Null for training that does not lapse — an induction, a toolbox talk. */
    expiresOn: { type: String, default: null },
    provider: { type: String, default: null, trim: true },
  },
  { collection: DRIVER_TRAINING_COLLECTION, timestamps: true, versionKey: false },
);

driverTrainingSchema.index({ userId: 1, completedOn: -1 }, { name: 'driver_completed' });
driverTrainingSchema.index({ expiresOn: 1 }, { name: 'training_expiry' });

export const DriverTrainingModel = model('DriverTraining', driverTrainingSchema);
