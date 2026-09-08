import type {
  ChargeCode,
  DefectSeverity,
  DriverRun,
  JobStatus,
  LoadType,
  RunStop,
  WeightBasis,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { AccountModel } from '../accounts/account.model.js';
import {
  JobChargeModel,
  JobCommentModel,
  JobEventModel,
  JobModel,
  JobPhotoModel,
  JobPreStartModel,
  JobRiskAssessmentModel,
} from '../jobs/job.model.js';
import { RunModel, RunTipOffModel } from '../dispatch/run.model.js';
import { toDecimal128 } from '../../lib/money.js';
import { VehicleDefectModel } from './defect.model.js';
import type { ReconciliationStop } from './tipoff.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 *
 * ── Everything here is scoped to ONE driver ───────────────────────────────
 * Every read and write takes a `driverId` and folds it into the filter. A
 * driver's phone is the least controlled surface in the product: it is offline
 * half the day, it replays queued actions, and it belongs to somebody who does
 * not work in the office. So the boundary is enforced in the query — a job that
 * is not on this driver's run is never loaded, and therefore cannot be
 * completed, photographed or charged against by mistake or otherwise.
 */

interface RawJobForDriver {
  _id: mongoose.Types.ObjectId;
  jobNumber: number;
  status: JobStatus;
  accountId: mongoose.Types.ObjectId;
  accountName: string;
  builderName: string;
  siteName: string;
  lotNumber: string | null;
  addressLine: string;
  suburb: string;
  postcode: string;
  zone: RunStop['zone'];
  latitude: number;
  longitude: number;
  accessNotes: string;
  gateHours: string | null;
  inductionRequired: boolean;
  craneAvailable: boolean;
  siteContactName: string | null;
  siteContactMobile: string | null;
  poNumber: string | null;
  notes: string;
  expectedAreaM2: number | null;
  bagCount: number;
  serviceLevel: 'standard' | 'urgent';
  readyDate: string;
  riskAssessmentRequired: boolean;
  recoveredWeightKg: number | null;
  recoveredWeightBasis: WeightBasis | null;
  runId: mongoose.Types.ObjectId | null;
  runSequence: number | null;
  driverId: mongoose.Types.ObjectId | null;
  arrivedAt: Date | null;
  completedAt: Date | null;
}

export interface DriverStopRow extends RawJobForDriver {
  /** From the account — m²-only accounts never prompt for kilograms (M2.3). */
  capturesWeight: boolean;
  loadType: LoadType;
  photoCount: number;
  riskAssessmentDoneAt: Date | null;
}

export const driverRepository = {
  /**
   * Every run allocated to this driver on one date, with their stops.
   *
   * ⚠️ Four queries for the whole day, not one per stop. A driver on a building
   * site is on 4G with two bars, and a run sheet that costs twenty round trips
   * is one that never finishes loading.
   */
  async runSheet(driverId: string, date: string): Promise<{
    runs: Array<{
      runId: string;
      runName: string;
      sequenceForDay: number;
      suburbs: string[];
      tipOffRecordedAt: Date | null;
      tipOffKg: number | null;
    }>;
    stops: DriverStopRow[];
  }> {
    if (!mongoose.isValidObjectId(driverId)) return { runs: [], stops: [] };
    const driver = new mongoose.Types.ObjectId(driverId);

    const runs = await RunModel.find({ driverId: driver, date })
      .sort({ sequenceForDay: 1, runNumber: 1 })
      .lean<
        Array<{
          _id: mongoose.Types.ObjectId;
          name: string;
          sequenceForDay: number | null;
          suburbs?: string[];
        }>
      >();

    const runIds = runs.map((run) => run._id);
    if (runIds.length === 0) return { runs: [], stops: [] };

    const [jobs, tipOffs] = await Promise.all([
      JobModel.find({ runId: { $in: runIds } })
        .sort({ runSequence: 1 })
        .lean<RawJobForDriver[]>(),
      RunTipOffModel.find({ runId: { $in: runIds } }).lean<
        Array<{ runId: mongoose.Types.ObjectId; totalKg: number; tippedOffAt: Date }>
      >(),
    ]);

    const stops = await decorate(jobs);

    const tipOffByRun = new Map(tipOffs.map((row) => [row.runId.toHexString(), row]));

    return {
      runs: runs.map((run) => {
        const tipOff = tipOffByRun.get(run._id.toHexString());
        const runStops = stops.filter((stop) => stop.runId?.toHexString() === run._id.toHexString());

        return {
          runId: run._id.toHexString(),
          runName: run.name,
          // A run with no driver has no position in anybody's day; one that
          // reached this query has a driver, so 1 is the honest floor.
          sequenceForDay: run.sequenceForDay ?? 1,
          // Recomputed from the stops in order rather than trusted from the run
          // document, so the heading always matches the list underneath it.
          suburbs: [...new Set(runStops.map((stop) => stop.suburb))],
          tipOffRecordedAt: tipOff?.tippedOffAt ?? null,
          tipOffKg: tipOff?.totalKg ?? null,
        };
      }),
      stops,
    };
  },

  /**
   * One job, but only if it is on a run this driver is holding.
   *
   * Null when it does not exist OR belongs to someone else — the service turns
   * both into the same 404, because a 403 would confirm the job exists.
   */
  async findJobForDriver(jobId: string, driverId: string): Promise<DriverStopRow | null> {
    if (!mongoose.isValidObjectId(jobId) || !mongoose.isValidObjectId(driverId)) return null;

    const job = await JobModel.findOne({
      _id: new mongoose.Types.ObjectId(jobId),
      // The scope, in the query. See the note at the top of this file.
      driverId: new mongoose.Types.ObjectId(driverId),
    }).lean<RawJobForDriver>();

    if (!job) return null;

    const [decorated] = await decorate([job]);
    return decorated ?? null;
  },

  /**
   * Moves a job's status, but only from the states that make the move sensible.
   *
   * ⚠️ `fromStatuses` is part of the FILTER. A phone replaying a queued action
   * after coming back into signal must not walk a completed job backwards, and
   * two taps on a flaky connection must not both count. Returns false when
   * nothing matched, which the service reads as "already done".
   */
  async transition(input: {
    jobId: string;
    driverId: string;
    to: JobStatus;
    fromStatuses: JobStatus[];
    occurredAt: Date;
    arrivedAt?: Date | null;
    completedAt?: Date | null;
    onSiteMinutes?: number | null;
  }): Promise<boolean> {
    if (!mongoose.isValidObjectId(input.jobId)) return false;

    const set: Record<string, unknown> = { status: input.to };
    if (input.arrivedAt !== undefined) set.arrivedAt = input.arrivedAt;
    if (input.completedAt !== undefined) set.completedAt = input.completedAt;
    if (input.onSiteMinutes !== undefined) set.onSiteMinutes = input.onSiteMinutes;

    const result = await JobModel.updateOne(
      {
        _id: new mongoose.Types.ObjectId(input.jobId),
        driverId: new mongoose.Types.ObjectId(input.driverId),
        status: { $in: input.fromStatuses },
      },
      { $set: set },
    );

    return result.matchedCount === 1;
  },

  /** M4.3 — what the driver captured at the kerb. */
  async recordWeights(input: {
    jobId: string;
    driverId: string;
    bagCount: number;
    loadType: LoadType;
    craneScaleKg: number | null;
  }): Promise<boolean> {
    const result = await JobModel.updateOne(
      {
        _id: new mongoose.Types.ObjectId(input.jobId),
        driverId: new mongoose.Types.ObjectId(input.driverId),
      },
      {
        $set: {
          bagCount: input.bagCount,
          loadType: input.loadType,
          recoveredWeightKg: input.craneScaleKg,
          /*
           * Matt, 56:11 — a crane-weighed load is ACTUAL; anything else is
           * worked out from the weighbridge later and is ESTIMATED. Carried as a
           * field rather than inferred at read time so a certificate issued
           * today still says what it was based on.
           */
          recoveredWeightBasis: input.craneScaleKg === null ? null : 'actual',
        },
      },
    );

    return result.matchedCount === 1;
  },

  /** Writes the imputed kilograms the reconciliation worked out (M4.4). */
  async applyImputedWeights(
    lines: ReadonlyArray<{ jobId: string; imputedKg: number }>,
  ): Promise<void> {
    if (lines.length === 0) return;

    await JobModel.bulkWrite(
      lines.map((line) => ({
        updateOne: {
          filter: { _id: new mongoose.Types.ObjectId(line.jobId) },
          update: {
            $set: { recoveredWeightKg: line.imputedKg, recoveredWeightBasis: 'estimated' },
          },
        },
      })),
    );
  },

  async recordTipOff(input: {
    runId: string;
    driverId: string;
    date: string;
    totalKg: number;
    docketReference: string;
    docketPhotoId: string | null;
    tippedOffAt: Date;
  }): Promise<boolean> {
    // One docket per run (Matt, 43:50). An upsert rather than an insert so a
    // phone replaying a queued action does not create a second one.
    const result = await RunTipOffModel.updateOne(
      { runId: new mongoose.Types.ObjectId(input.runId) },
      {
        $set: {
          runId: new mongoose.Types.ObjectId(input.runId),
          date: input.date,
          totalKg: input.totalKg,
          docketReference: input.docketReference || null,
          docketPhotoId: input.docketPhotoId
            ? new mongoose.Types.ObjectId(input.docketPhotoId)
            : null,
          tippedOffAt: input.tippedOffAt,
          recordedByUserId: new mongoose.Types.ObjectId(input.driverId),
        },
      },
      { upsert: true },
    );

    return result.acknowledged;
  },

  /** The stops on one run, in the shape the reconciliation needs. */
  async stopsForReconciliation(
    runId: string,
    driverId: string,
  ): Promise<{ runName: string; date: string; stops: ReconciliationStop[] } | null> {
    if (!mongoose.isValidObjectId(runId)) return null;

    const run = await RunModel.findOne({
      _id: new mongoose.Types.ObjectId(runId),
      driverId: new mongoose.Types.ObjectId(driverId),
    }).lean<{ name: string; date: string }>();

    if (!run) return null;

    const jobs = await JobModel.find({ runId: new mongoose.Types.ObjectId(runId) })
      .sort({ runSequence: 1 })
      .lean<
        Array<{
          _id: mongoose.Types.ObjectId;
          jobNumber: number;
          siteName: string;
          loadType?: LoadType;
          expectedAreaM2: number | null;
          recoveredWeightKg: number | null;
          recoveredWeightBasis: WeightBasis | null;
        }>
      >();

    return {
      runName: run.name,
      date: run.date,
      stops: jobs.map((job) => ({
        jobId: job._id.toHexString(),
        jobNumber: job.jobNumber,
        siteName: job.siteName,
        loadType: job.loadType ?? 'hand-load',
        expectedAreaM2: job.expectedAreaM2,
        /*
         * Only an ACTUAL figure counts as measured. An estimated one is the
         * output of a previous reconciliation, and feeding it back in would
         * compound the estimate every time the driver re-previewed.
         */
        craneScaleKg: job.recoveredWeightBasis === 'actual' ? job.recoveredWeightKg : null,
      })),
    };
  },

  /**
   * Registers a photo and returns its id.
   *
   * The BYTES are not here — they go straight to object storage from the phone
   * (§6A.10 #9). This is the record that says one exists and where.
   */
  async addPhoto(input: {
    jobId: string;
    caption: string;
    takenAt: Date;
    takenBy: string;
    latitude: number | null;
    longitude: number | null;
    storageKey: string;
  }): Promise<string> {
    const created = await JobPhotoModel.create({
      jobId: new mongoose.Types.ObjectId(input.jobId),
      caption: input.caption,
      takenAt: input.takenAt,
      takenBy: input.takenBy,
      latitude: input.latitude,
      longitude: input.longitude,
      storageKey: input.storageKey,
    });

    return created._id.toHexString();
  },

  async findPhoto(
    photoId: string,
    jobId: string,
  ): Promise<{ id: string; storageKey: string | null } | null> {
    if (!mongoose.isValidObjectId(photoId)) return null;

    const photo = await JobPhotoModel.findOne({
      _id: new mongoose.Types.ObjectId(photoId),
      jobId: new mongoose.Types.ObjectId(jobId),
    }).lean<{ _id: mongoose.Types.ObjectId; storageKey: string | null }>();

    return photo ? { id: photo._id.toHexString(), storageKey: photo.storageKey ?? null } : null;
  },

  async removePhoto(photoId: string, jobId: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(photoId)) return false;

    const result = await JobPhotoModel.deleteOne({
      _id: new mongoose.Types.ObjectId(photoId),
      jobId: new mongoose.Types.ObjectId(jobId),
    });

    return result.deletedCount === 1;
  },

  async countPhotos(jobId: string): Promise<number> {
    return JobPhotoModel.countDocuments({ jobId: new mongoose.Types.ObjectId(jobId) });
  },

  /**
   * M2.7 — a charge the driver raised, into the approval queue.
   *
   * ⚠️ Always `pending`. A driver reports what they saw; the office decides
   * whether it reaches an invoice, by looking at the photo.
   */
  async raiseCharge(input: {
    jobId: string;
    code: ChargeCode;
    description: string;
    quantity: number;
    unitRate: string;
    amount: string;
    raisedBy: string;
    raisedAt: Date;
    photoCount: number;
    note: string | null;
  }): Promise<string> {
    const created = await JobChargeModel.create({
      jobId: new mongoose.Types.ObjectId(input.jobId),
      code: input.code,
      description: input.description,
      quantity: input.quantity,
      unitRate: toDecimal128(input.unitRate),
      amount: toDecimal128(input.amount),
      source: 'driver',
      approvalState: 'pending',
      raisedBy: input.raisedBy,
      raisedAt: input.raisedAt,
      photoCount: input.photoCount,
      note: input.note,
    });

    return created._id.toHexString();
  },

  async hasCharge(jobId: string, code: ChargeCode): Promise<boolean> {
    const count = await JobChargeModel.countDocuments({
      jobId: new mongoose.Types.ObjectId(jobId),
      code,
    });
    return count > 0;
  },

  async appendEvent(input: {
    jobId: string;
    at: Date;
    label: string;
    actor: string;
    status: JobStatus | null;
    detail: string | null;
    latitude: number | null;
    longitude: number | null;
  }): Promise<void> {
    await JobEventModel.create({
      jobId: new mongoose.Types.ObjectId(input.jobId),
      at: input.at,
      label: input.label,
      actor: input.actor,
      status: input.status,
      detail: input.detail,
      latitude: input.latitude,
      longitude: input.longitude,
    });
  },

  /* ── Compliance (M4.8) ─────────────────────────────────────────────────── */

  /**
   * M4.8a — the pre-start, recorded against the day's first job.
   *
   * Upserted on `jobId`, so a phone replaying the submission updates the record
   * rather than filing a second one. A duplicate would make "was the obligation
   * met" ambiguous, which is the one thing this record must never be.
   */
  async savePreStart(input: {
    jobId: string;
    driverId: string;
    driverName: string;
    completedAt: Date;
    vehicleRego: string;
    odometerKm: number;
    failedItems: Array<{ key: string; label: string; note: string }>;
    itemsChecked: number;
  }): Promise<string> {
    const result = await JobPreStartModel.findOneAndUpdate(
      { jobId: new mongoose.Types.ObjectId(input.jobId) },
      {
        $set: {
          driverId: new mongoose.Types.ObjectId(input.driverId),
          driverName: input.driverName,
          completedAt: input.completedAt,
          vehicleRego: input.vehicleRego,
          odometerKm: input.odometerKm,
          failedItems: input.failedItems,
          itemsChecked: input.itemsChecked,
        },
      },
      { upsert: true, new: true },
    ).lean<{ _id: mongoose.Types.ObjectId }>();

    return result._id.toHexString();
  },

  async findPreStartForDay(driverId: string, date: string): Promise<{ completedAt: Date } | null> {
    if (!mongoose.isValidObjectId(driverId)) return null;

    // Scoped through the runs the driver actually held that day, so one driver's
    // pre-start can never satisfy another's obligation.
    const runIds = (await RunModel.distinct('_id', {
      driverId: new mongoose.Types.ObjectId(driverId),
      date,
    })) as mongoose.Types.ObjectId[];
    if (runIds.length === 0) return null;

    const jobIds = (await JobModel.distinct('_id', {
      runId: { $in: runIds },
    })) as mongoose.Types.ObjectId[];
    if (jobIds.length === 0) return null;

    const record = await JobPreStartModel.findOne({ jobId: { $in: jobIds } })
      .sort({ completedAt: 1 })
      .lean<{ completedAt: Date }>();

    return record ? { completedAt: record.completedAt } : null;
  },

  /** M4.8b — the Site Risk Assessment. Upserted for the same reason. */
  async saveRiskAssessment(input: {
    jobId: string;
    driverId: string;
    driverName: string;
    completedAt: Date;
    hazards: string[];
    controls: string[];
    note: string;
    safeToProceed: boolean;
    swmsVersion: string;
    builderPortalCode: string | null;
  }): Promise<string> {
    const result = await JobRiskAssessmentModel.findOneAndUpdate(
      { jobId: new mongoose.Types.ObjectId(input.jobId) },
      {
        $set: {
          driverId: new mongoose.Types.ObjectId(input.driverId),
          driverName: input.driverName,
          completedAt: input.completedAt,
          hazards: input.hazards,
          controls: input.controls,
          note: input.note,
          safeToProceed: input.safeToProceed,
          swmsVersion: input.swmsVersion,
          builderPortalCode: input.builderPortalCode,
          // Step 5 has not happened yet. The PDF and the handoff to the
          // builder's portal are a background job, not a save-time blocker —
          // this has to work at a fence with no signal.
          uploadState: 'queued',
        },
      },
      { upsert: true, new: true },
    ).lean<{ _id: mongoose.Types.ObjectId }>();

    return result._id.toHexString();
  },

  /* ── Defects (M4.9) ────────────────────────────────────────────────────── */

  async reportDefect(input: {
    vehicleRego: string;
    reportedByUserId: string;
    reportedByName: string;
    severity: DefectSeverity;
    summary: string;
    detail: string;
    photoIds: string[];
    occurredAt: Date;
    latitude: number | null;
    longitude: number | null;
    preStartId?: string | null;
    preStartItemKey?: string | null;
  }): Promise<string> {
    const created = await VehicleDefectModel.create({
      vehicleRego: input.vehicleRego,
      reportedByUserId: new mongoose.Types.ObjectId(input.reportedByUserId),
      reportedByName: input.reportedByName,
      severity: input.severity,
      summary: input.summary,
      detail: input.detail,
      photoIds: input.photoIds
        .filter((id) => mongoose.isValidObjectId(id))
        .map((id) => new mongoose.Types.ObjectId(id)),
      occurredAt: input.occurredAt,
      latitude: input.latitude,
      longitude: input.longitude,
      preStartId: input.preStartId ? new mongoose.Types.ObjectId(input.preStartId) : null,
      preStartItemKey: input.preStartItemKey ?? null,
      status: 'open',
    });

    return created._id.toHexString();
  },
};

/**
 * Joins the per-account facts a stop needs.
 *
 * `capturesWeight` comes from the account (M2.3): an m²-only account must never
 * prompt a driver for kilograms. Fetched for the whole page in ONE query rather
 * than one per stop — the N+1 that turns a seven-stop run into fifteen round
 * trips on a phone with two bars.
 */
async function decorate(jobs: RawJobForDriver[]): Promise<DriverStopRow[]> {
  if (jobs.length === 0) return [];

  const jobIds = jobs.map((job) => job._id);
  const accountIds = [...new Set(jobs.map((job) => job.accountId.toHexString()))].map(
    (id) => new mongoose.Types.ObjectId(id),
  );

  const [accounts, photoCounts, assessments] = await Promise.all([
    AccountModel.find({ _id: { $in: accountIds } }, { captureMode: 1 }).lean<
      Array<{ _id: mongoose.Types.ObjectId; captureMode: string }>
    >(),
    JobPhotoModel.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
      { $match: { jobId: { $in: jobIds } } },
      { $group: { _id: '$jobId', count: { $sum: 1 } } },
    ]),
    JobRiskAssessmentModel.find({ jobId: { $in: jobIds } }, { jobId: 1, completedAt: 1 }).lean<
      Array<{ jobId: mongoose.Types.ObjectId; completedAt: Date }>
    >(),
  ]);

  const captureByAccount = new Map(
    accounts.map((account) => [account._id.toHexString(), account.captureMode]),
  );
  const photosByJob = new Map(photoCounts.map((row) => [row._id.toHexString(), row.count]));
  const sraByJob = new Map(
    assessments.map((row) => [row.jobId.toHexString(), row.completedAt]),
  );

  return jobs.map((job) => ({
    ...job,
    capturesWeight: captureByAccount.get(job.accountId.toHexString()) === 'area-and-weight',
    /*
     * Bagged when the site has a crane to lift them, hand-load otherwise. A
     * default rather than a guess: the driver sets it for real when capturing
     * weights, and this only decides which prompt they see first.
     */
    loadType: job.craneAvailable ? 'bagged' : 'hand-load',
    photoCount: photosByJob.get(job._id.toHexString()) ?? 0,
    riskAssessmentDoneAt: sraByJob.get(job._id.toHexString()) ?? null,
  }));
}

export type { DriverRun };

/* ── Reads that only the job-detail screen needs ─────────────────────────── */

export interface DriverPhotoRow {
  id: string;
  slot: string | null;
  caption: string;
  takenAt: Date;
  latitude: number | null;
  longitude: number | null;
  storageKey: string | null;
}

export interface DriverMessageRow {
  id: string;
  body: string;
  author: string;
  at: Date;
  fromDriver: boolean;
}

export interface DriverRiskAssessmentRow {
  completedAt: Date;
  safeToProceed: boolean;
  uploadState: 'pending' | 'queued' | 'uploaded' | 'failed';
}

/**
 * Everything hanging off one stop, for the job-detail screen.
 *
 * Three collections in parallel rather than in sequence: this is the screen a
 * driver opens at every gate, on a phone with two bars.
 */
export async function loadJobDetail(jobId: string): Promise<{
  photos: DriverPhotoRow[];
  messages: DriverMessageRow[];
  riskAssessment: DriverRiskAssessmentRow | null;
}> {
  const _id = new mongoose.Types.ObjectId(jobId);

  const [photos, comments, assessment] = await Promise.all([
    JobPhotoModel.find({ jobId: _id }).sort({ takenAt: 1 }).lean(),
    /*
     * ⚠️ `driver` visibility ONLY. `internal` is where the office talks ABOUT
     * the customer, and `customer` is the portal thread — neither belongs on a
     * phone, and filtering in the query means neither can reach one by accident.
     */
    JobCommentModel.find({ jobId: _id, visibility: 'driver' }).sort({ at: 1 }).lean(),
    JobRiskAssessmentModel.findOne({ jobId: _id }).lean(),
  ]);

  return {
    photos: photos.map((photo) => ({
      id: photo._id.toHexString(),
      slot: photo.slot ?? null,
      caption: photo.caption,
      takenAt: photo.takenAt,
      latitude: photo.latitude ?? null,
      longitude: photo.longitude ?? null,
      storageKey: photo.storageKey ?? null,
    })),
    messages: comments.map((comment) => ({
      id: comment._id.toHexString(),
      body: comment.body,
      author: comment.author,
      at: comment.at,
      fromDriver: comment.fromDriver,
    })),
    riskAssessment: assessment
      ? {
          completedAt: assessment.completedAt,
          safeToProceed: assessment.safeToProceed,
          uploadState: assessment.uploadState,
        }
      : null,
  };
}

/**
 * M8.6 · W102 — a message from the driver into the job's driver thread.
 *
 * Always `driver` visibility and always `fromDriver`. A phone cannot choose a
 * thread: the internal one is not its business, and the customer one is not its
 * voice.
 */
export async function addDriverMessage(input: {
  jobId: string;
  body: string;
  authorId: string;
  author: string;
  at: Date;
}): Promise<DriverMessageRow> {
  const created = await JobCommentModel.create({
    jobId: new mongoose.Types.ObjectId(input.jobId),
    body: input.body,
    authorId: new mongoose.Types.ObjectId(input.authorId),
    author: input.author,
    at: input.at,
    visibility: 'driver',
    // The office reads it in the console; there is no push to deliver it TO.
    deliveredAt: input.at,
    fromDriver: true,
  });

  return {
    id: created._id.toHexString(),
    body: created.body,
    author: created.author,
    at: created.at,
    fromDriver: true,
  };
}
