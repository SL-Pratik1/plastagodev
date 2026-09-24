import {
  photoPurpose,
  type ChargeCode,
  type ContaminationExtent,
  type ContaminationType,
  type DefectSeverity,
  type DriverRun,
  type JobStatus,
  type LoadType,
  type PhotoPurpose,
  type RunStop,
  type WeightBasis,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { UNKNOWN_ZONE_LABEL, zoneLabels } from '../settings/zone-lookup.js';
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
import { VehicleModel } from '../fleet/vehicle.model.js';
import { parseContaminationNote } from './contamination-note.js';
import { ContaminationReportModel } from './contamination-report.model.js';
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
  /*
   * ⚠️ What the JOB stores — an ObjectId, and no name. The zone's name is
   * joined on in `decorate` below, with everything else the driver's screen
   * needs that does not live on the job.
   */
  zoneId: mongoose.Types.ObjectId;
  latitude: number;
  longitude: number;
  locationSource: RunStop['locationSource'];
  accessNotes: string;
  gateHours: string | null;
  inductionRequired: boolean;
  craneAvailable: boolean;
  siteContactName: string | null;
  siteContactMobile: string | null;
  poNumber: string | null;
  notes: string;
  expectedAreaM2: number | null;
  /** What the ORDER allowed for. Frozen at booking — never the driver's count. */
  bagCount: number;
  /** What the driver found. Null until the weights screen is saved. */
  collectedBagCount: number | null;
  serviceLevel: 'standard' | 'urgent';
  readyDate: string;
  riskAssessmentRequired: boolean;
  recoveredWeightKg: number | null;
  recoveredWeightBasis: WeightBasis | null;
  /** Per-bag crane readings behind `recoveredWeightKg`. Empty on a hand load. */
  bagWeights?: number[];
  /** When the driver saved the weights screen. Null until they do. */
  weightsRecordedAt: Date | null;
  /** The driver's own bagged/hand-load answer. Null until they save the weights screen. */
  loadType?: LoadType | null;
  runId: mongoose.Types.ObjectId | null;
  runSequence: number | null;
  driverId: mongoose.Types.ObjectId | null;
  arrivedAt: Date | null;
  completedAt: Date | null;
}

/** A job's contamination report, as the service needs it. See `findContaminationReport`. */
export interface ContaminationReportRow {
  reportedAt: Date;
  /** Null only on a report older than the record, whose charge note did not parse. */
  type: ContaminationType | null;
  extent: ContaminationExtent | null;
  note: string | null;
  latitude: number | null;
  longitude: number | null;
  timelineRecordedAt: Date | null;
  /** True when read back from the charge of a report made before the record existed. */
  legacy: boolean;
}

export interface DriverStopRow extends Omit<RawJobForDriver, 'zoneId' | 'loadType'> {
  zoneId: RunStop['zoneId'];
  zoneLabel: RunStop['zoneLabel'];
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
      // `netKg` is the schema's name for the weighbridge figure — see recordTipOff.
      RunTipOffModel.find({ runId: { $in: runIds } }).lean<
        Array<{ runId: mongoose.Types.ObjectId; netKg: number; tippedOffAt: Date }>
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
          tipOffKg: tipOff?.netKg ?? null,
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
    /** What the driver counted on site — stored as `collectedBagCount`. */
    bagCount: number;
    loadType: LoadType;
    /** Per-bag readings. Empty on a hand load or an m²-only account. */
    bagWeights: number[];
    craneScaleKg: number | null;
    /** When the driver saved the screen — the phone's clock, so it survives a queued replay. */
    recordedAt: Date;
  }): Promise<boolean> {
    const result = await JobModel.updateOne(
      {
        _id: new mongoose.Types.ObjectId(input.jobId),
        driverId: new mongoose.Types.ObjectId(input.driverId),
      },
      {
        $set: {
          /*
           * ⚠️ `collectedBagCount`, NOT `bagCount`. The allowance copied off
           * the purchase order is what the base invoice is priced on, and
           * overwriting it here is what previously made an overage invisible.
           */
          collectedBagCount: input.bagCount,
          loadType: input.loadType,
          bagWeights: input.bagWeights,
          /*
           * ⚠️ Stamped HERE, when the driver saves — not when the job
           * completes. Completion is blocked until weights are recorded, so
           * deriving this from `completedAt` made the two wait on each other
           * and no job could be finished on the phone at all.
           *
           * Set for a hand load as well, which carries no kilograms: the
           * question is whether the driver answered, not whether a scale was
           * used.
           */
          weightsRecordedAt: input.recordedAt,
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

  /**
   * M4.4 — the driver's docket, written against `runtipoffs`.
   *
   * ⚠️ The field names here are the SCHEMA's, not the driver contract's, and the
   * two differ. `run.model.ts` calls them `netKg`, `docketNumber` and
   * `docketPhotoKey`; the wire calls them `totalKg`, `docketReference` and
   * `docketPhotoId`. Mongoose runs strict by default, so `$set`-ing the wire
   * names silently DROPPED them — the write acknowledged, and the weighbridge
   * figure was never stored. The office path (`run.repository.ts`) always used
   * the schema names, which is why only the driver's tip-off lost its weight.
   *
   * Translate once, here, where the boundary is.
   *
   * `facility` is not asked for on the driver's screen — there is no picker on
   * the Tip-off form, and inventing one would be a UI change nobody asked for.
   * It stays null on this path and the office fills it in; see the note on the
   * schema.
   */
  async recordTipOff(input: {
    runId: string;
    driverId: string;
    date: string;
    totalKg: number;
    docketReference: string;
    docketPhotoKey: string | null;
    tippedOffAt: Date;
  }): Promise<boolean> {
    // One docket per run (Matt, 43:50). An upsert rather than an insert so a
    // phone replaying a queued action does not create a second one.
    const result = await RunTipOffModel.updateOne(
      { runId: new mongoose.Types.ObjectId(input.runId) },
      {
        $set: {
          runId: new mongoose.Types.ObjectId(input.runId),
          netKg: input.totalKg,
          docketNumber: input.docketReference || null,
          docketPhotoKey: input.docketPhotoKey,
          tippedOffAt: input.tippedOffAt,
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
  /**
   * ⚠️ `slot` is not optional decoration — it is what the shot IS.
   *
   * It used to be absent from this signature while the client faithfully sent
   * it and the schema faithfully validated it, so every photo was stored under
   * the model's `null` default. Nothing errored. The five-shot checklist simply
   * never ticked off: "4 still needed" stayed at four while the driver took
   * photo after photo, each one filed as an anonymous extra.
   */
  async addPhoto(input: {
    jobId: string;
    slot: string | null;
    caption: string;
    takenAt: Date;
    takenBy: string;
    latitude: number | null;
    longitude: number | null;
    storageKey: string;
  }): Promise<string> {
    const created = await JobPhotoModel.create({
      jobId: new mongoose.Types.ObjectId(input.jobId),
      slot: input.slot,
      caption: input.caption,
      takenAt: input.takenAt,
      takenBy: input.takenBy,
      latitude: input.latitude,
      longitude: input.longitude,
      storageKey: input.storageKey,
    });

    return created._id.toHexString();
  },

  /**
   * M4.5 — the phone telling us its PUT landed.
   *
   * Idempotent on purpose: the confirmation is a separate request from the PUT,
   * so it can be retried after a timeout that actually succeeded. The first
   * `uploadedAt` wins, because it is the closest thing we have to when the
   * bytes arrived and a later retry would drift it forward for no reason.
   */
  async markPhotoUploaded(photoId: string, jobId: string, at: Date): Promise<boolean> {
    if (!mongoose.isValidObjectId(photoId)) return false;

    const result = await JobPhotoModel.updateOne(
      {
        _id: new mongoose.Types.ObjectId(photoId),
        jobId: new mongoose.Types.ObjectId(jobId),
        uploadedAt: null,
      },
      { $set: { uploadedAt: at } },
    );

    return result.matchedCount > 0;
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
    /** M4.2 — where the driver was standing. Null for an office-raised charge. */
    latitude: number | null;
    longitude: number | null;
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
      latitude: input.latitude,
      longitude: input.longitude,
    });

    return created._id.toHexString();
  },

  /**
   * Bring a pending charge into line with a figure the driver has just revised.
   *
   * ── Why this is not `raiseChargeOnce` ────────────────────────────────────
   * A contamination charge is a yes/no event, so raising it at most once is
   * exactly right. An overage is a QUANTITY: a driver who saves four bags and
   * then corrects it to six must not leave a charge for two extras behind, and
   * must not gain a second charge either.
   *
   * ⚠️ An already-decided charge is left alone. Once the office has approved or
   * rejected it a person has acted on that number, and rewriting it underneath
   * them would change an approved amount with no trace. Those cases return
   * `'locked'` so the caller can say so on the timeline instead.
   */
  async syncPendingCharge(input: {
    jobId: string;
    code: ChargeCode;
    description: string;
    quantity: number;
    unitRate: string;
    amount: string;
    raisedBy: string;
    raisedAt: Date;
    note: string | null;
  }): Promise<'created' | 'updated' | 'unchanged' | 'locked'> {
    const jobId = new mongoose.Types.ObjectId(input.jobId);

    const decided = await JobChargeModel.countDocuments({
      jobId,
      code: input.code,
      approvalState: { $in: ['approved', 'rejected'] },
    });
    if (decided > 0) return 'locked';

    const existing = await JobChargeModel.findOne({
      jobId,
      code: input.code,
      approvalState: 'pending',
    }).lean<{ _id: mongoose.Types.ObjectId; quantity: number }>();

    if (!existing) {
      await JobChargeModel.create({
        jobId,
        code: input.code,
        description: input.description,
        quantity: input.quantity,
        unitRate: toDecimal128(input.unitRate),
        amount: toDecimal128(input.amount),
        /*
         * `driver` because it came off the phone, and because that is the
         * source invoicing splits on — this is precisely a charge that needs
         * its own purchase order (M7.3).
         */
        source: 'driver',
        approvalState: 'pending',
        raisedBy: input.raisedBy,
        raisedAt: input.raisedAt,
        photoCount: 0,
        note: input.note,
      });
      return 'created';
    }

    if (existing.quantity === input.quantity) return 'unchanged';

    await JobChargeModel.updateOne(
      { _id: existing._id, approvalState: 'pending' },
      {
        $set: {
          description: input.description,
          quantity: input.quantity,
          unitRate: toDecimal128(input.unitRate),
          amount: toDecimal128(input.amount),
          raisedBy: input.raisedBy,
          raisedAt: input.raisedAt,
          note: input.note,
        },
      },
    );
    return 'updated';
  },

  /**
   * Drops a pending charge that no longer applies — the driver corrected six
   * bags back down to the two the order allowed for.
   *
   * Only ever removes a PENDING row, for the same reason `syncPendingCharge`
   * refuses to rewrite a decided one.
   */
  async removePendingCharge(jobId: string, code: ChargeCode): Promise<boolean> {
    const result = await JobChargeModel.deleteOne({
      jobId: new mongoose.Types.ObjectId(jobId),
      code,
      approvalState: 'pending',
    });
    return result.deletedCount === 1;
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

  /**
   * Whether the job's timeline already records it moving INTO `status`.
   *
   * The replay guard for a status event whose write can fail AFTER the status
   * itself changed — see `markFutile`. Keyed on the event's `status`, which is
   * structured, rather than its label, which is copy somebody may reword.
   */
  async hasStatusEvent(jobId: string, status: JobStatus): Promise<boolean> {
    if (!mongoose.isValidObjectId(jobId)) return false;

    const found = await JobEventModel.exists({
      jobId: new mongoose.Types.ObjectId(jobId),
      status,
    });
    return found !== null;
  },

  /**
   * How many of a job's photos are evidence of one report (see `photoPurpose`).
   *
   * Counted from the photos themselves rather than trusted from the phone,
   * which is what a replay has to do: it no longer has the capture screen's
   * list in hand.
   */
  async countEvidencePhotos(jobId: string, purpose: PhotoPurpose): Promise<number> {
    if (!mongoose.isValidObjectId(jobId)) return 0;

    const rows = await JobPhotoModel.find(
      { jobId: new mongoose.Types.ObjectId(jobId) },
      { slot: 1, caption: 1 },
    ).lean<Array<{ slot?: string | null; caption: string }>>();

    return rows.filter((photo) => photoPurpose(photo) === purpose).length;
  },

  /* ── M4.7 · the contamination report ───────────────────────────────────── */

  /**
   * The report on a job, or null when there is none.
   *
   * ── Reports made before the record existed ────────────────────────────────
   * Those left a driver-raised contamination CHARGE and no report row. Reading
   * that charge as the report is what stops a job reported last week offering
   * the form again the day this ships — the charge is only ever raised by a
   * report, so its existence is the fact, and its note (written as
   * "type · extent — note") is the detail where it still parses.
   */
  async findContaminationReport(jobId: string): Promise<ContaminationReportRow | null> {
    if (!mongoose.isValidObjectId(jobId)) return null;
    const _id = new mongoose.Types.ObjectId(jobId);

    const report = await ContaminationReportModel.findOne({ jobId: _id }).lean<{
      type: ContaminationType;
      extent: ContaminationExtent;
      note?: string | null;
      reportedAt: Date;
      latitude?: number | null;
      longitude?: number | null;
      timelineRecordedAt?: Date | null;
    }>();

    if (report) {
      return {
        reportedAt: report.reportedAt,
        type: report.type,
        extent: report.extent,
        note: report.note ?? null,
        latitude: report.latitude ?? null,
        longitude: report.longitude ?? null,
        timelineRecordedAt: report.timelineRecordedAt ?? null,
        legacy: false,
      };
    }

    const charge = await JobChargeModel.findOne({
      jobId: _id,
      code: 'contamination',
      source: 'driver',
    })
      .sort({ raisedAt: 1 })
      .lean<{
        raisedAt: Date;
        note?: string | null;
        latitude?: number | null;
        longitude?: number | null;
      }>();

    if (!charge) return null;

    const parsed = parseContaminationNote(charge.note ?? null);

    return {
      reportedAt: charge.raisedAt,
      type: parsed.type,
      extent: parsed.extent,
      note: parsed.note,
      latitude: charge.latitude ?? null,
      longitude: charge.longitude ?? null,
      // The old path wrote its timeline line straight after the charge, and
      // there is nothing to go back and finish on a report that old.
      timelineRecordedAt: charge.raisedAt,
      legacy: true,
    };
  },

  /**
   * Stores the report — once. Returns whether THIS call created it.
   *
   * ⚠️ `$setOnInsert` against the unique `jobId`, so two replays of one queued
   * report landing together cannot both win: the loser matches the row the
   * winner wrote and inserts nothing. A duplicate-key error from the same race
   * on an older server means exactly that too, and is answered the same way.
   */
  async recordContaminationReport(input: {
    jobId: string;
    type: ContaminationType;
    extent: ContaminationExtent;
    note: string | null;
    reportedAt: Date;
    reportedByUserId: string;
    reportedByName: string;
    latitude: number | null;
    longitude: number | null;
  }): Promise<boolean> {
    const jobId = new mongoose.Types.ObjectId(input.jobId);

    try {
      const result = await ContaminationReportModel.updateOne(
        { jobId },
        {
          $setOnInsert: {
            jobId,
            type: input.type,
            extent: input.extent,
            note: input.note,
            reportedAt: input.reportedAt,
            reportedByUserId: new mongoose.Types.ObjectId(input.reportedByUserId),
            reportedByName: input.reportedByName,
            latitude: input.latitude,
            longitude: input.longitude,
            timelineRecordedAt: null,
          },
        },
        { upsert: true },
      );
      return result.upsertedCount === 1;
    } catch (error) {
      if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) return false;
      throw error;
    }
  },

  /** Records that the job's timeline has the report — see `timelineRecordedAt`. */
  async markContaminationOnTimeline(jobId: string, at: Date): Promise<void> {
    await ContaminationReportModel.updateOne(
      { jobId: new mongoose.Types.ObjectId(jobId), timelineRecordedAt: null },
      { $set: { timelineRecordedAt: at } },
    );
  },

  /* ── The driver's truck ────────────────────────────────────────────────── */

  /**
   * M4.8a · M4.9 — the vehicle this driver is paired with.
   *
   * ⚠️ Matched by NAME, because that is how the pairing is stored: a vehicle
   * carries `assignedDriverName` rather than a user id (see `vehicle.model.ts`),
   * and the index there exists for exactly this lookup.
   *
   * ── Why this is the only source of the rego ──────────────────────────────
   * A pre-start and a defect are records about a TRUCK, and the office finds
   * them again by matching the plate exactly. The phone cannot be trusted to
   * supply it: a run sheet cached before the pairing existed carries a blank,
   * and a blank files the record against no truck at all — it survives in the
   * collection but never appears on any vehicle screen, which is worse than
   * refusing to save it.
   *
   * A truck taken off the road has its driver cleared (`vehicle.service.ts`),
   * so an assignment found here is always a usable one.
   */
  async findAssignedVehicle(driverName: string): Promise<{ rego: string; label: string } | null> {
    const name = driverName.trim();
    if (name.length === 0) return null;

    const vehicle = await VehicleModel.findOne({ assignedDriverName: name })
      .select({ rego: 1, label: 1 })
      .lean<{ rego: string; label: string }>();

    return vehicle ? { rego: vehicle.rego, label: vehicle.label } : null;
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
      /*
       * ⚠️ Stored as given. This used to be
       *   .filter((id) => mongoose.isValidObjectId(id)).map(...)
       * which silently dropped every photo a driver attached to a defect,
       * because the ids were storage keys and never ObjectIds. A filter that
       * discards evidence without a word is worse than one that throws.
       */
      photoIds: input.photoIds,
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

  const [accounts, photoCounts, assessments, zones] = await Promise.all([
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
    /*
     * The zone NAMES. A driver's run sheet says "Wollongong", and the job row
     * holds only the id — so this is the fourth thing joined on for the whole
     * page rather than one lookup per stop.
     */
    zoneLabels(),
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
    zoneId: job.zoneId.toString(),
    zoneLabel: zones.get(job.zoneId.toString()) ?? UNKNOWN_ZONE_LABEL,
    capturesWeight: captureByAccount.get(job.accountId.toHexString()) === 'area-and-weight',
    /*
     * The driver's own answer wins, falling back to the office's booking guess
     * (a crane on site means bagged) only until they have saved the screen.
     *
     * Using that guess unconditionally overwrote what the driver recorded: the
     * run sheet kept saying "hand load" after they had saved six weighed bags.
     */
    loadType: job.loadType ?? (job.craneAvailable ? 'bagged' : 'hand-load'),
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
  /** Null until the phone confirms its PUT. See the model's own note. */
  uploadedAt: Date | null;
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
      uploadedAt: photo.uploadedAt ?? null,
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
