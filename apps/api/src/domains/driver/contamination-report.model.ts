import { CONTAMINATION_EXTENTS, CONTAMINATION_TYPES } from '@plastago/shared';
import { Schema, model } from 'mongoose';

export const CONTAMINATION_REPORTS_COLLECTION = 'contaminationreports';

/**
 * M4.7 — the contamination report a driver made on a job. One per job.
 *
 * ── Why this is a record at all ───────────────────────────────────────────
 * A report used to leave only a timeline line and, the first time, a charge.
 * Nothing said "this job has been reported", so the phone kept the button on
 * the job and a driver could file the same load again and again — one job in
 * the dev data carries eleven reports. This row is the fact the phone reads
 * back, and the unique index below is what makes "one per job" true even when
 * two replays of the same queued report land at once.
 *
 * Its own collection, like `futilereviews`, rather than fields on the job: the
 * job document stays the job, and the report can be read or indexed without it.
 *
 * The evidence photos are NOT listed here. They carry the `contamination` slot
 * on `jobphotos`, which is what every screen already reads — a second list of
 * ids here would be a second answer to the same question.
 */
const contaminationReportSchema = new Schema(
  {
    /** REFERENCE → `jobs._id`. Unique: a job takes one report. */
    jobId: { type: Schema.Types.ObjectId, required: true, ref: 'Job' },

    type: { type: String, required: true, enum: CONTAMINATION_TYPES },
    extent: { type: String, required: true, enum: CONTAMINATION_EXTENTS },
    /** What the driver typed, if anything. */
    note: { type: String, default: null, trim: true },

    /** When the DRIVER reported it — the phone's clock, so a late sync keeps the real time. */
    reportedAt: { type: Date, required: true },
    /** REFERENCE → `users._id`. */
    reportedByUserId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    /** Frozen name, so the record survives the driver leaving. */
    reportedByName: { type: String, required: true, trim: true },

    /** M4.2 — where the driver stood. Null when the phone had no fix. */
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },

    /**
     * When the job's timeline was told. Null until it has been.
     *
     * ⚠️ The replay guard for that one write. The report is stored first, so a
     * failure after it — the charge, the timeline — is finished by the phone's
     * retry rather than lost: the charge is idempotent on its own, and this is
     * what stops the retry writing the timeline line a second time.
     */
    timelineRecordedAt: { type: Date, default: null },
  },
  { collection: CONTAMINATION_REPORTS_COLLECTION, timestamps: true, versionKey: false },
);

contaminationReportSchema.index({ jobId: 1 }, { unique: true, name: 'job_unique' });

export const ContaminationReportModel = model('ContaminationReport', contaminationReportSchema);
