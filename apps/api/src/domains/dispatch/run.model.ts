import { RUN_STATUSES } from '@plastago/shared';
import { Schema, model } from 'mongoose';

export const RUNS_COLLECTION = 'runs';
export const RUN_TIP_OFFS_COLLECTION = 'runtipoffs';

/**
 * A run — the thing that actually gets assigned (M3).
 *
 * ── Why runs exist at all ─────────────────────────────────────────────────
 * Matt, 44:50: *"rather than an allocation board per se, it'd be a run sheet
 * creator."* A driver does not take a bag of jobs; he takes a RUN, and normally
 * two in a day — morning South Coast, tip off, afternoon Sydney (40:03). The
 * old model of assigning jobs to a driver-and-date could not express that, and
 * the tip-off is the reason it has to: one weighbridge docket belongs to one
 * run, not to a driver's whole day, and the reconciliation divides that
 * docket's net weight across that run's stops.
 *
 * ── Where the stops live ──────────────────────────────────────────────────
 * NOT here. A job carries `runId` and `runSequence`, so the reference points
 * from the child to the parent — the ordinary way to model a one-to-many, and
 * the one that keeps "which jobs are on this run" and "which run is this job
 * on" both a single indexed query. An array of stop ids on this document would
 * have to be rewritten in full to move one stop, and could disagree with the
 * jobs themselves about who is on what.
 */
const runSchema = new Schema(
  {
    /**
     * A human-quotable number, allocated atomically like a job's.
     *
     * Dispatch says "run 41" on the phone, so it has to be short, stable and
     * never reused within a day.
     */
    runNumber: { type: Number, required: true, min: 1 },
    /** The name the allocator types — "Newcastle run 1" (Matt, 39:41). */
    name: { type: String, required: true, trim: true },
    /**
     * The day the run happens, as a plain `YYYY-MM-DD`.
     *
     * A date, not an instant: a run is a working day in Sydney, and giving it a
     * timezone is how it lands on the wrong side of midnight for somebody.
     */
    date: { type: String, required: true },

    /**
     * ⚠️ `planning` is the ONLY state in which stops may be added or removed.
     *
     * Once a driver has the run on his phone, changing its contents underneath
     * him is how a stop gets missed. The allocator unassigns first, which is a
     * deliberate speed bump rather than an oversight.
     *
     * `tipped-off` is separate from `closed` because the docket arrives before
     * anybody has checked the reconciliation against it.
     */
    status: { type: String, required: true, enum: RUN_STATUSES, default: 'planning' },

    /* ── Staffing ────────────────────────────────────────────────────── */
    /** REFERENCE → `users._id`. Null until the run is staffed. */
    driverId: { type: Schema.Types.ObjectId, default: null, ref: 'User' },
    /** Frozen copy, so the board renders a row without a join per run. */
    driverName: { type: String, default: null, trim: true },
    /** Lands properly with the fleet domain; null until a vehicle is attached. */
    vehicleLabel: { type: String, default: null, trim: true },
    /**
     * Which of this driver's runs for the day this is — 1 for the morning South
     * Coast trip, 2 for the afternoon Sydney one (Matt, 40:03).
     *
     * Null while unassigned, because the question has no answer until somebody
     * is on it.
     */
    sequenceForDay: { type: Number, default: null, min: 1 },

    /**
     * I11 — when Google Route Optimization last ordered the stops (Matt, 42:06).
     *
     * Null means the sequence is the allocator's own work. Re-optimising would
     * throw that away, which is why the UI asks first rather than silently
     * reordering — this timestamp is what lets it know there is something to
     * lose.
     */
    optimisedAt: { type: Date, default: null },
  },
  { collection: RUNS_COLLECTION, timestamps: true, versionKey: false },
);

/** Dispatch quotes this number down the phone. Two runs sharing one is chaos. */
runSchema.index({ runNumber: 1 }, { unique: true, name: 'run_number_unique' });

/** The board's only query: every run for one date. */
runSchema.index({ date: 1, status: 1 }, { name: 'date_status' });

/** A driver's day, in the order they will work it. */
runSchema.index({ driverId: 1, date: 1, sequenceForDay: 1 }, { name: 'driver_day' });

export const RunModel = model('Run', runSchema);

/**
 * The weighbridge docket for one run (M4.4).
 *
 * ── Why per run and never per day ─────────────────────────────────────────
 * `netKg` is the figure the reconciliation divides: crane-weighed bags come off
 * first, and what remains is split across the hand-loaded stops in proportion to
 * their m². A driver who tips off twice in a day has two dockets covering two
 * different sets of stops, and averaging them across the day would put weight on
 * jobs that were not in the truck — on a figure that ends up on a diversion
 * certificate.
 *
 * Its own collection rather than a field on the run: it is produced by a
 * different actor at a different time, it carries a photo, and "every docket
 * this month" is a real query the reconciliation report runs.
 */
const runTipOffSchema = new Schema(
  {
    /** REFERENCE → `runs._id`. */
    runId: { type: Schema.Types.ObjectId, required: true, ref: 'Run' },
    /**
     * Where the load was tipped.
     *
     * NOT required: the driver's Tip-off screen has no facility picker — it asks
     * for the weighbridge figure, the docket number and a photo, and nothing
     * else. Requiring it here would mean either inventing a field on that screen
     * or refusing the driver's own docket, and the office fills it in when it
     * reconciles. The office path supplies it on write.
     */
    facility: { type: String, default: null, trim: true },
    docketNumber: { type: String, default: null, trim: true },
    /**
     * Net kilograms off the weighbridge.
     *
     * A plain number, not `Decimal128` — this is a measurement, not money. It
     * is never summed into an invoice total, and the weighbridge itself reports
     * whole kilograms.
     */
    netKg: { type: Number, required: true, min: 0 },
    tippedOffAt: { type: Date, required: true },
    /** Where the docket photo lives. The API serves a URL; it stores no bytes. */
    docketPhotoKey: { type: String, default: null },
  },
  { collection: RUN_TIP_OFFS_COLLECTION, timestamps: true, versionKey: false },
);

/** One docket, one run. A second would make the reconciliation ambiguous. */
runTipOffSchema.index({ runId: 1 }, { unique: true, name: 'run_unique' });
runTipOffSchema.index({ tippedOffAt: -1 }, { name: 'recent' });

export const RunTipOffModel = model('RunTipOff', runTipOffSchema);
