import type {
  JobStatus,
  LocationSource,
  Run,
  RunStatus,
  RunStopSummary,
  RunTipOff,
  UnallocatedJob,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { UNKNOWN_ZONE_LABEL, zoneLabels } from '../settings/zone-lookup.js';
import { JobModel } from '../jobs/job.model.js';
import { getStorage } from '../../integrations/storage.js';
import { RunModel, RunTipOffModel } from './run.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 *
 * ── Why there is no scope parameter here ──────────────────────────────────
 * Runs are internal. A customer never sees one — they see their own job's
 * status, not which truck it is on or who else is on that truck. So unlike
 * jobs and accounts there is no `RunScope`: the router refuses customer roles
 * outright, which is a boundary a missing filter cannot quietly widen.
 */

/** A run plus the stops hanging off it, ready to map. */
interface RawRun {
  _id: mongoose.Types.ObjectId;
  runNumber: number;
  name: string;
  date: string;
  status: RunStatus;
  driverId: mongoose.Types.ObjectId | null;
  driverName: string | null;
  vehicleLabel: string | null;
  sequenceForDay: number | null;
  optimisedAt: Date | null;
}

interface RawStop {
  _id: mongoose.Types.ObjectId;
  jobNumber: number;
  runSequence: number | null;
  status: RunStopSummary['status'];
  accountName: string;
  builderName: string;
  siteName: string;
  suburb: string;
  /*
   * ⚠️ What the JOB stores — an ObjectId, and no label. A run sheet shows the
   * zone's CURRENT name, so the label is joined on at read time rather than
   * denormalised onto the job. `appliedRate.zoneLabel` is the frozen one, and
   * it is frozen because it reaches an invoice.
   */
  zoneId: mongoose.Types.ObjectId;
  serviceLevel: RunStopSummary['serviceLevel'];
  readyDate: string;
  targetDate: string;
  expectedAreaM2: number | null;
  /**
   * ⚠️ Optional on the RAW row, required on the contract.
   *
   * A job written before the field existed simply does not have it, and
   * `.lean()` returns the stored document rather than the schema's default.
   * `toStop` coalesces to `suburb`, which is what such a job actually is:
   * booked before anything was geocoded.
   */
  locationSource?: LocationSource;
  bagCount: number;
}

interface RawTipOff {
  runId: mongoose.Types.ObjectId;
  facility: string;
  docketNumber: string | null;
  netKg: number;
  tippedOffAt: Date;
  docketPhotoKey?: string | null;
}

export interface CreateRunInput {
  runNumber: number;
  name: string;
  date: string;
  driverId: string | null;
  driverName: string | null;
  sequenceForDay: number | null;
  status: RunStatus;
}

/** Statuses that are still in play — a stop the allocator can still move. */
const OPEN_JOB_STATUSES: JobStatus[] = ['booked', 'assigned', 'in-transit', 'arrived'];

export const runRepository = {
  async findById(runId: string): Promise<Run | null> {
    if (!mongoose.isValidObjectId(runId)) return null;

    const row = await RunModel.findById(runId).lean<RawRun>();
    if (!row) return null;

    const [stops, tipOff] = await Promise.all([stopsOf([row._id]), tipOffOf(row._id)]);

    return toRun(row, stops.get(row._id.toHexString()) ?? EMPTY_GROUP, tipOff);
  },

  /**
   * Every run for one date, with its stops.
   *
   * ⚠️ Two queries for the whole board, not two per run. The stops for every run
   * on the date are fetched in ONE query and grouped in memory — the N+1 here
   * would be a query per run on a screen that shows all of them.
   */
  async findByDate(date: string): Promise<Run[]> {
    const rows = await RunModel.find({ date })
      .sort({ sequenceForDay: 1, runNumber: 1 })
      .lean<RawRun[]>();

    if (rows.length === 0) return [];

    const ids = rows.map((row) => row._id);
    const [stops, tipOffs] = await Promise.all([stopsOf(ids), tipOffsOf(ids)]);

    return rows.map((row) =>
      toRun(row, stops.get(row._id.toHexString()) ?? EMPTY_GROUP, tipOffs.get(row._id.toHexString()) ?? null),
    );
  },

  /** The status and staffing of one run, without loading its stops. */
  async findSummary(runId: string): Promise<{
    id: string;
    runNumber: number;
    name: string;
    date: string;
    status: RunStatus;
    driverId: string | null;
    stopCount: number;
  } | null> {
    if (!mongoose.isValidObjectId(runId)) return null;

    const row = await RunModel.findById(runId).lean<RawRun>();
    if (!row) return null;

    const stopCount = await JobModel.countDocuments({ runId: row._id });

    return {
      id: row._id.toHexString(),
      runNumber: row.runNumber,
      name: row.name,
      date: row.date,
      status: row.status,
      driverId: row.driverId ? row.driverId.toHexString() : null,
      stopCount,
    };
  },

  async create(input: CreateRunInput): Promise<string> {
    const created = await RunModel.create({
      runNumber: input.runNumber,
      name: input.name,
      date: input.date,
      status: input.status,
      driverId: input.driverId ? new mongoose.Types.ObjectId(input.driverId) : null,
      driverName: input.driverName,
      sequenceForDay: input.sequenceForDay,
    });

    return created._id.toHexString();
  },

  async rename(runId: string, name: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(runId)) return false;
    const result = await RunModel.updateOne({ _id: runId }, { $set: { name } });
    return result.matchedCount === 1;
  },

  /**
   * Deletes a run and releases its stops.
   *
   * The jobs are NOT deleted — they go back to the unallocated column, which is
   * the only sane reading of "delete this run": the work still has to happen.
   */
  async remove(runId: string): Promise<void> {
    if (!mongoose.isValidObjectId(runId)) return;
    const _id = new mongoose.Types.ObjectId(runId);

    await releaseStops({ runId: _id });
    await Promise.all([RunModel.deleteOne({ _id }), RunTipOffModel.deleteMany({ runId: _id })]);
  },

  /**
   * Puts a job on the end of a run.
   *
   * The filter carries `runId: null`, so a job already on another run is not
   * silently stolen — the caller is told to remove it first. Returns false when
   * nothing matched.
   */
  async addStop(runId: string, jobId: string, sequence: number): Promise<boolean> {
    if (!mongoose.isValidObjectId(runId) || !mongoose.isValidObjectId(jobId)) return false;

    const run = await RunModel.findById(runId).lean<RawRun>();
    if (!run) return false;

    const result = await JobModel.updateOne(
      { _id: new mongoose.Types.ObjectId(jobId), runId: null },
      {
        $set: {
          runId: new mongoose.Types.ObjectId(runId),
          runSequence: sequence,
          // Staffing propagates to the stop: a driver takes whole runs, so a
          // stop added to an already-staffed run inherits its driver.
          driverId: run.driverId,
          driverName: run.driverName,
          ...(run.driverId ? { status: 'assigned' } : {}),
        },
      },
    );

    return result.matchedCount === 1;
  },

  async removeStop(runId: string, jobId: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(runId) || !mongoose.isValidObjectId(jobId)) return false;

    const result = await releaseStops({
      runId: new mongoose.Types.ObjectId(runId),
      _id: new mongoose.Types.ObjectId(jobId),
    });

    return result > 0;
  },

  /**
   * The stops of a run as POINTS, in the sequence they currently sit in (I3).
   *
   * Separate from `stopIds` rather than replacing it: a reorder only needs to
   * know which ids are on the run, and making it carry coordinates it never
   * reads would widen the query on the hottest path for nothing.
   *
   * `locationSource` rides along because the optimiser has to know whether it
   * is being handed real addresses or a list of suburb centres — see
   * `optimiseRun`.
   */
  async stopPoints(
    runId: string,
  ): Promise<{ id: string; latitude: number; longitude: number; locationSource: LocationSource }[]> {
    if (!mongoose.isValidObjectId(runId)) return [];

    const rows = await JobModel.find(
      { runId: new mongoose.Types.ObjectId(runId) },
      { _id: 1, latitude: 1, longitude: 1, locationSource: 1 },
    )
      .sort({ runSequence: 1 })
      .lean<
        {
          _id: mongoose.Types.ObjectId;
          latitude: number;
          longitude: number;
          locationSource?: LocationSource;
        }[]
      >();

    return rows.map((row) => ({
      id: row._id.toHexString(),
      latitude: row.latitude,
      longitude: row.longitude,
      // Absent on every job written before the field existed. Those jobs took
      // the suburb pin, so that is the truthful reading of a missing value.
      locationSource: row.locationSource ?? 'suburb',
    }));
  },

  /** The ids currently on a run, in sequence. Used to validate a reorder. */
  async stopIds(runId: string): Promise<string[]> {
    if (!mongoose.isValidObjectId(runId)) return [];

    const rows = await JobModel.find({ runId: new mongoose.Types.ObjectId(runId) }, { _id: 1 })
      .sort({ runSequence: 1 })
      .lean<Array<{ _id: mongoose.Types.ObjectId }>>();

    return rows.map((row) => row._id.toHexString());
  },

  /**
   * Rewrites the whole sequence.
   *
   * One `bulkWrite` rather than a loop of updates: a partially reordered run has
   * two stops claiming position 3, and the driver's sheet is then in an order
   * nobody chose.
   */
  async resequence(runId: string, jobIds: readonly string[], optimised: boolean): Promise<void> {
    if (jobIds.length === 0) return;

    await JobModel.bulkWrite(
      jobIds.map((jobId, index) => ({
        updateOne: {
          filter: {
            _id: new mongoose.Types.ObjectId(jobId),
            runId: new mongoose.Types.ObjectId(runId),
          },
          update: { $set: { runSequence: index + 1 } },
        },
      })),
    );

    await RunModel.updateOne(
      { _id: new mongoose.Types.ObjectId(runId) },
      { $set: { optimisedAt: optimised ? new Date() : null } },
    );
  },

  /**
   * Staffs a run and propagates the driver to every stop on it.
   *
   * The propagation is what lets the driver app ask "my jobs today" without
   * joining through runs, and what puts a driver's name on the jobs grid.
   *
   * ⚠️ The stamp and the status move are two different writes, over two
   * different sets of stops, and collapsing them back into one is a bug.
   *
   * The stamp has to reach EVERY open stop. A run is unassigned to be edited
   * and then re-assigned, and a stop that had already moved past `booked` by
   * then — someone marked it arrived from the office — came back with no
   * driver on it at all. The run sheet still listed it, because that query
   * goes by `runId`; but `findJobForDriver` filters by `driverId`, so the
   * driver could see the stop and not open it, and every status write against
   * it failed the same filter. A stop you can see and cannot touch is worse
   * than one that is missing.
   *
   * The status move stays gated on `booked` for the opposite reason: that one
   * must never walk a stop BACKWARDS. Sending `arrived` back to `assigned`
   * would discard the driver's own timestamped progress.
   */
  async assign(
    runId: string,
    driverId: string,
    driverName: string,
    sequenceForDay: number,
  ): Promise<boolean> {
    if (!mongoose.isValidObjectId(runId) || !mongoose.isValidObjectId(driverId)) return false;

    const _id = new mongoose.Types.ObjectId(runId);
    const driver = new mongoose.Types.ObjectId(driverId);

    const result = await RunModel.updateOne(
      { _id, status: 'planning' },
      { $set: { driverId: driver, driverName, sequenceForDay, status: 'assigned' } },
    );

    if (result.matchedCount !== 1) return false;

    await JobModel.updateMany(
      { runId: _id, status: { $in: OPEN_JOB_STATUSES } },
      { $set: { driverId: driver, driverName } },
    );

    await JobModel.updateMany({ runId: _id, status: 'booked' }, { $set: { status: 'assigned' } });

    return true;
  },

  /** Takes the driver off a run and its stops, returning it to planning. */
  async unassign(runId: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(runId)) return false;
    const _id = new mongoose.Types.ObjectId(runId);

    const result = await RunModel.updateOne(
      { _id, status: { $in: ['assigned', 'planning'] } },
      { $set: { driverId: null, driverName: null, sequenceForDay: null, status: 'planning' } },
    );

    if (result.matchedCount !== 1) return false;

    await JobModel.updateMany(
      { runId: _id, status: 'assigned' },
      { $set: { driverId: null, driverName: null, status: 'booked' } },
    );

    return true;
  },

  /** How many runs this driver already has that day, for `sequenceForDay`. */
  async countDriverRuns(driverId: string, date: string): Promise<number> {
    if (!mongoose.isValidObjectId(driverId)) return 0;
    return RunModel.countDocuments({ driverId: new mongoose.Types.ObjectId(driverId), date });
  },

  /**
   * Jobs waiting to go on a run, for one date.
   *
   * ⚠️ `readyDate` is the filter, not `targetDate`. The allocator is asking
   * "what can I collect today", and a job is collectable once the plasterer has
   * finished — which is what ready means. Anything ready EARLIER is included
   * too, because an unallocated job from last week has not gone away; it is the
   * most urgent thing on the board.
   */
  async unallocated(date: string): Promise<UnallocatedJob[]> {
    const rows = await JobModel.find({
      runId: null,
      status: { $in: OPEN_JOB_STATUSES },
      readyDate: { $lte: date },
    })
      .sort({ targetDate: 1, jobNumber: 1 })
      .lean<RawStop[]>();

    const zones = await zoneLabels();

    return rows.map((row) => ({
      id: row._id.toHexString(),
      jobNumber: row.jobNumber,
      accountName: row.accountName,
      builderName: row.builderName,
      siteName: row.siteName,
      suburb: row.suburb,
      zoneId: row.zoneId.toString(),
      zoneLabel: zones.get(row.zoneId.toString()) ?? UNKNOWN_ZONE_LABEL,
      serviceLevel: row.serviceLevel,
      readyDate: row.readyDate,
      targetDate: row.targetDate,
      expectedAreaM2: row.expectedAreaM2,
      atRisk: isAtRisk(row.targetDate, row.status),
    }));
  },

  async recordTipOff(
    runId: string,
    input: { facility: string; docketNumber: string | null; netKg: number; tippedOffAt: Date },
  ): Promise<void> {
    const _id = new mongoose.Types.ObjectId(runId);

    // Upsert, so a driver correcting a mistyped docket weight replaces it
    // rather than creating a second docket for one run.
    await RunTipOffModel.updateOne({ runId: _id }, { $set: { ...input, runId: _id } }, { upsert: true });
    await RunModel.updateOne({ _id }, { $set: { status: 'tipped-off' } });
  },
};

/* ── Mapping ─────────────────────────────────────────────────────────────── */

/** A run's stops plus the totals that need the raw rows to compute. */
interface StopGroup {
  stops: RunStopSummary[];
  /** Bags are on the job but not on `RunStopSummary`, so they are summed here. */
  totalBags: number;
}

const EMPTY_GROUP: StopGroup = { stops: [], totalBags: 0 };

function toRun(row: RawRun, group: StopGroup, tipOff: RunTipOff | null): Run {
  const stops = group.stops;
  const suburbs: string[] = [];
  for (const stop of stops) {
    // Distinct, but in STOP ORDER rather than alphabetical — the board reads
    // them as the shape of the drive.
    if (!suburbs.includes(stop.suburb)) suburbs.push(stop.suburb);
  }

  return {
    id: row._id.toHexString(),
    runNumber: row.runNumber,
    name: row.name,
    date: row.date,
    status: row.status,
    driverId: row.driverId ? row.driverId.toHexString() : null,
    driverName: row.driverName,
    vehicleLabel: row.vehicleLabel,
    sequenceForDay: row.sequenceForDay,
    suburbs,
    stops,
    // Stops with no area contribute nothing rather than being read as zero —
    // the fixed-price builder's PO carries no m² at all (Matt, 31:22).
    totalExpectedAreaM2: stops.reduce((sum, stop) => sum + (stop.expectedAreaM2 ?? 0), 0),
    totalBags: group.totalBags,
    optimisedAt: row.optimisedAt ? row.optimisedAt.toISOString() : null,
    tipOff,
  };
}

function toStop(row: RawStop, zones: ReadonlyMap<string, string>): RunStopSummary {
  return {
    id: row._id.toHexString(),
    jobNumber: row.jobNumber,
    // A stop with no sequence is a data fault, not a rendering decision. 1 keeps
    // the contract satisfiable; the sort has already put it where it belongs.
    sequence: row.runSequence ?? 1,
    status: row.status,
    accountName: row.accountName,
    builderName: row.builderName,
    siteName: row.siteName,
    suburb: row.suburb,
    zoneId: row.zoneId.toString(),
    zoneLabel: zones.get(row.zoneId.toString()) ?? UNKNOWN_ZONE_LABEL,
    serviceLevel: row.serviceLevel,
    readyDate: row.readyDate,
    targetDate: row.targetDate,
    expectedAreaM2: row.expectedAreaM2,
    // See the note on `RawStop.locationSource` for why this is coalesced.
    locationSource: row.locationSource ?? 'suburb',
    atRisk: isAtRisk(row.targetDate, row.status),
  };
}

/**
 * `docketPhotoUrl` is a URL, not the storage key.
 *
 * It used to hand back `docketPhotoKey` verbatim — `plastago/runs/…/dockets/x.jpg`
 * — under a field named "Url", so anything rendering it as an image or a link
 * would have fetched a path that does not exist. Presigned here, the way lead
 * attachments and PO documents already are.
 */
async function toTipOff(row: RawTipOff): Promise<RunTipOff> {
  return {
    facility: row.facility,
    docketNumber: row.docketNumber,
    netKg: row.netKg,
    tippedOffAt: row.tippedOffAt.toISOString(),
    docketPhotoUrl: row.docketPhotoKey
      ? await getStorage().presignDownload(row.docketPhotoKey)
      : null,
  };
}

/* ── Shared queries ──────────────────────────────────────────────────────── */

/** Stops for many runs at once, grouped by run. One query for a whole board. */
async function stopsOf(runIds: mongoose.Types.ObjectId[]): Promise<Map<string, StopGroup>> {
  const [rows, zones] = await Promise.all([
    JobModel.find({ runId: { $in: runIds } })
      .sort({ runSequence: 1 })
      .lean<Array<RawStop & { runId: mongoose.Types.ObjectId }>>(),
    zoneLabels(),
  ]);

  const grouped = new Map<string, StopGroup>();
  for (const row of rows) {
    const key = row.runId.toHexString();
    const group = grouped.get(key) ?? { stops: [], totalBags: 0 };
    group.stops.push(toStop(row, zones));
    group.totalBags += row.bagCount;
    grouped.set(key, group);
  }

  return grouped;
}

async function tipOffOf(runId: mongoose.Types.ObjectId): Promise<RunTipOff | null> {
  const row = await RunTipOffModel.findOne({ runId }).lean<RawTipOff>();
  return row ? await toTipOff(row) : null;
}

async function tipOffsOf(
  runIds: mongoose.Types.ObjectId[],
): Promise<Map<string, RunTipOff>> {
  const rows = await RunTipOffModel.find({ runId: { $in: runIds } }).lean<RawTipOff[]>();

  const grouped = new Map<string, RunTipOff>();
  // Sequential rather than `Promise.all`: presigning is local work and a board
  // holds a handful of runs, so the parallelism would buy nothing measurable.
  for (const row of rows) grouped.set(row.runId.toHexString(), await toTipOff(row));
  return grouped;
}

/**
 * Takes stops off a run and returns them to the unallocated column.
 *
 * The driver comes off with the run: a job nobody is on is `booked`, and leaving
 * a stale driver name on it would put it on somebody's app for a run that no
 * longer contains it.
 */
async function releaseStops(filter: Record<string, unknown>): Promise<number> {
  /*
   * ⚠️ Status FIRST, then the release.
   *
   * The status update is selected by the same `runId` the release is about to
   * clear, so doing it second would match nothing and leave every released job
   * stuck at `assigned` with no driver — a job that looks allocated on the grid
   * and appears on nobody's app.
   */
  await JobModel.updateMany({ ...filter, status: 'assigned' }, { $set: { status: 'booked' } });

  // Only a job that had not started is reset above. One already in transit
  // keeps its status — the truck is out, whatever the board says.
  const result = await JobModel.updateMany(filter, {
    $set: {
      runId: null,
      runSequence: null,
      driverId: null,
      driverName: null,
    },
  });

  return result.modifiedCount;
}

/** M3.5 — an open job past its target date. The board highlights these. */
function isAtRisk(targetDate: string, status: JobStatus): boolean {
  if (!OPEN_JOB_STATUSES.includes(status)) return false;
  return targetDate < new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}
