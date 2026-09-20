import type { JobStatus, LoadType, WeightBasis } from '@plastago/shared';
import { ZONE } from './fake-settings.js';
import mongoose from 'mongoose';
import type {
  DriverMessageRow,
  DriverPhotoRow,
  DriverRiskAssessmentRow,
  DriverStopRow,
} from '../../src/domains/driver/driver.repository.js';

/**
 * An in-memory stand-in for the driver repository.
 *
 * ── Why a fake and not a mocked Mongo ─────────────────────────────────────
 * What is under test is the OFFLINE contract: is a replayed action idempotent,
 * is a stale one refused, does a contamination report raise exactly one charge.
 * None of that needs a database, and a test that spins one up measures Mongo's
 * availability rather than the rule.
 *
 * The one thing this fake models faithfully is the conditional write: the real
 * `transition` puts `fromStatuses` in the FILTER, so it matches nothing when the
 * job has moved. Getting that wrong here would make the idempotency tests pass
 * against a fake that cannot fail the way production does.
 */

let counter = 0;

function nextId(): string {
  counter += 1;
  return counter.toString(16).padStart(24, '0');
}

/**
 * A stable ObjectId for any seed string.
 *
 * Seeds in these tests are readable labels like `run1` and `acc1`, which are not
 * hex — so each character is mapped to its code point rather than used directly.
 * Same seed, same id, every run.
 */
export function objectId(seed: string): mongoose.Types.ObjectId {
  const hex = [...seed]
    .map((character) => character.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('');
  return new mongoose.Types.ObjectId(hex.padEnd(24, '0').slice(0, 24));
}

export interface StoredStop {
  id: string;
  jobNumber: number;
  status: JobStatus;
  driverId: string;
  runId: string | null;
  runSequence: number;
  expectedAreaM2: number | null;
  bagCount: number;
  loadType: LoadType;
  capturesWeight: boolean;
  craneAvailable: boolean;
  riskAssessmentRequired: boolean;
  riskAssessmentDoneAt: Date | null;
  recoveredWeightKg: number | null;
  recoveredWeightBasis: WeightBasis | null;
  bagWeights: number[];
  /** What the driver counted. Null until weights are captured (M4.3). */
  collectedBagCount: number | null;
  arrivedAt: Date | null;
  completedAt: Date | null;
  siteName: string;
  suburb: string;
}

export interface StoredCharge {
  jobId: string;
  code: string;
  amount: string;
  photoCount: number;
  note: string | null;
  /** Present on charges raised through `syncPendingCharge` (M6.5 overages). */
  description?: string;
  quantity?: number;
  unitRate?: string;
  raisedBy?: string;
  approvalState?: 'pending' | 'approved' | 'rejected';
}

export interface StoredEvent {
  jobId: string;
  at: Date;
  label: string;
  status: JobStatus | null;
  detail: string | null;
  latitude: number | null;
  longitude: number | null;
}

export function createFakeDriverRepository(driverId: string) {
  const stops = new Map<string, StoredStop>();
  const charges: StoredCharge[] = [];
  const events: StoredEvent[] = [];
  const photos = new Map<string, DriverPhotoRow & { jobId: string }>();
  const messages: Array<DriverMessageRow & { jobId: string }> = [];
  const preStarts: Array<{ jobId: string; date: string; completedAt: Date; failed: number }> = [];
  const assessments = new Map<string, DriverRiskAssessmentRow>();
  const defects: Array<{
    rego: string;
    severity: string;
    summary: string;
    preStartItemKey: string | null;
    photoIds: string[];
  }> = [];
  const tipOffs: Array<{ runId: string; totalKg: number; docketReference: string }> = [];
  const imputed: Array<{ jobId: string; imputedKg: number }> = [];
  const runs = new Map<string, { name: string; date: string; driverId: string }>();

  /*
   * The truck this driver is paired with. Seeded, because the pairing is what
   * decides whether a pre-start or a defect can be filed at all — a driver with
   * none is refused, and that refusal is the rule under test.
   */
  let assignedVehicle: { rego: string; label: string } | null = {
    rego: 'BQ12AB',
    label: 'Truck 1 — Isuzu crane',
  };

  const toRow = (stop: StoredStop): DriverStopRow =>
    ({
      _id: objectId(stop.id),
      jobNumber: stop.jobNumber,
      status: stop.status,
      accountId: objectId('acc1'),
      accountName: 'Clarendon Homes',
      builderName: 'GJ Gardner',
      siteName: stop.siteName,
      lotNumber: '214',
      addressLine: '46 Allambie Circuit',
      suburb: stop.suburb,
      postcode: '2155',
      zoneId: ZONE.sydney,
      latitude: -33.7,
      longitude: 150.9,
      accessNotes: '',
      gateHours: null,
      inductionRequired: false,
      craneAvailable: stop.craneAvailable,
      siteContactName: null,
      siteContactMobile: null,
      poNumber: 'PO-1',
      notes: '',
      readyDate: '2026-09-10',
      expectedAreaM2: stop.expectedAreaM2,
      bagCount: stop.bagCount,
      serviceLevel: 'standard',
      riskAssessmentRequired: stop.riskAssessmentRequired,
      recoveredWeightKg: stop.recoveredWeightKg,
      recoveredWeightBasis: stop.recoveredWeightBasis,
      bagWeights: stop.bagWeights,
      collectedBagCount: stop.collectedBagCount,
      runId: stop.runId ? objectId(stop.runId) : null,
      runSequence: stop.runSequence,
      driverId: objectId(stop.driverId),
      arrivedAt: stop.arrivedAt,
      completedAt: stop.completedAt,
      capturesWeight: stop.capturesWeight,
      loadType: stop.loadType,
      photoCount: [...photos.values()].filter((photo) => photo.jobId === stop.id).length,
      riskAssessmentDoneAt: stop.riskAssessmentDoneAt,
    }) as DriverStopRow;

  return {
    /* ── Seeding ──────────────────────────────────────────────────────── */
    addStop(overrides: Partial<StoredStop> & { jobNumber: number }): StoredStop {
      const stop: StoredStop = {
        id: nextId(),
        status: 'assigned',
        driverId,
        runId: 'run1',
        runSequence: stops.size + 1,
        expectedAreaM2: 500,
        bagCount: 0,
        loadType: 'hand-load',
        capturesWeight: true,
        craneAvailable: false,
        riskAssessmentRequired: false,
        riskAssessmentDoneAt: null,
        recoveredWeightKg: null,
        recoveredWeightBasis: null,
        bagWeights: [],
        collectedBagCount: null,
        arrivedAt: null,
        completedAt: null,
        siteName: `Lot ${String(overrides.jobNumber)}`,
        suburb: 'Kellyville',
        ...overrides,
      };
      stops.set(stop.id, stop);
      runs.set(stop.runId ?? 'run1', {
        name: 'South Coast morning',
        date: '2026-09-10',
        driverId,
      });
      return stop;
    },

    setStatus(jobId: string, status: JobStatus): void {
      const stop = stops.get(jobId);
      if (stop) stop.status = status;
    },

    /* ── Inspection ───────────────────────────────────────────────────── */
    get charges() {
      return charges;
    },
    get events() {
      return events;
    },
    get defects() {
      return defects;
    },
    get tipOffs() {
      return tipOffs;
    },
    get imputed() {
      return imputed;
    },
    get messages() {
      return messages;
    },
    get preStarts() {
      return preStarts;
    },
    stop(jobId: string) {
      return stops.get(jobId);
    },
    photoCount() {
      return photos.size;
    },
    /** Pair this driver with a truck, or leave them with none. */
    assignVehicle(vehicle: { rego: string; label: string } | null) {
      assignedVehicle = vehicle;
    },

    repository: {
      findAssignedVehicle(driverName: string) {
        return Promise.resolve(driverName.trim().length === 0 ? null : assignedVehicle);
      },

      async runSheet(caller: string, date: string) {
        const mine = [...stops.values()].filter((stop) => stop.driverId === caller);
        const runIds = [...new Set(mine.map((stop) => stop.runId).filter(Boolean))] as string[];

        return Promise.resolve({
          runs: runIds
            .filter((id) => runs.get(id)?.date === date)
            .map((id, index) => ({
              runId: id,
              runName: runs.get(id)?.name ?? 'Run',
              sequenceForDay: index + 1,
              suburbs: [...new Set(mine.filter((s) => s.runId === id).map((s) => s.suburb))],
              tipOffRecordedAt: null,
              tipOffKg: null,
            })),
          stops: mine.map(toRow),
        });
      },

      findJobForDriver(jobId: string, caller: string) {
        const stop = stops.get(jobId);
        // The scope, exactly as the real query applies it: another driver's job
        // is not "forbidden", it simply does not exist for this caller.
        if (!stop || stop.driverId !== caller) return Promise.resolve(null);
        return Promise.resolve(toRow(stop));
      },

      /**
       * ⚠️ Models the CONDITIONAL write. `fromStatuses` is a filter in the real
       * repository, so it matches nothing once the job has moved on — which is
       * what makes a replayed action a no-op rather than a rewrite.
       */
      transition(input: {
        jobId: string;
        driverId: string;
        to: JobStatus;
        fromStatuses: JobStatus[];
        arrivedAt?: Date | null;
        completedAt?: Date | null;
        onSiteMinutes?: number | null;
      }) {
        const stop = stops.get(input.jobId);
        if (!stop || stop.driverId !== input.driverId) return Promise.resolve(false);
        if (!input.fromStatuses.includes(stop.status)) return Promise.resolve(false);

        stop.status = input.to;
        if (input.arrivedAt !== undefined) stop.arrivedAt = input.arrivedAt;
        if (input.completedAt !== undefined) stop.completedAt = input.completedAt;
        return Promise.resolve(true);
      },

      recordWeights(input: {
        jobId: string;
        bagCount: number;
        loadType: LoadType;
        bagWeights: number[];
        craneScaleKg: number | null;
      }) {
        const stop = stops.get(input.jobId);
        if (!stop) return Promise.resolve(false);
        // ⚠️ Mirrors the real repository: `collectedBagCount`, not `bagCount`.
        // A fake that clobbered the allowance would hide the very bug the
        // overage tests exist to catch.
        stop.collectedBagCount = input.bagCount;
        stop.loadType = input.loadType;
        stop.bagWeights = input.bagWeights;
        stop.recoveredWeightKg = input.craneScaleKg;
        stop.recoveredWeightBasis = input.craneScaleKg === null ? null : 'actual';
        return Promise.resolve(true);
      },

      applyImputedWeights(lines: ReadonlyArray<{ jobId: string; imputedKg: number }>) {
        for (const line of lines) {
          imputed.push(line);
          const stop = stops.get(line.jobId);
          if (stop) {
            stop.recoveredWeightKg = line.imputedKg;
            stop.recoveredWeightBasis = 'estimated';
          }
        }
        return Promise.resolve();
      },

      recordTipOff(input: { runId: string; totalKg: number; docketReference: string }) {
        // Upsert, like the real one: a replay updates rather than duplicating.
        const existing = tipOffs.findIndex((row) => row.runId === input.runId);
        if (existing >= 0) tipOffs[existing] = input;
        else tipOffs.push(input);
        return Promise.resolve(true);
      },

      stopsForReconciliation(runId: string, caller: string) {
        const run = runs.get(runId);
        if (!run || run.driverId !== caller) return Promise.resolve(null);

        return Promise.resolve({
          runName: run.name,
          date: run.date,
          stops: [...stops.values()]
            .filter((stop) => stop.runId === runId)
            .map((stop) => ({
              jobId: stop.id,
              jobNumber: stop.jobNumber,
              siteName: stop.siteName,
              loadType: stop.loadType,
              expectedAreaM2: stop.expectedAreaM2,
              craneScaleKg:
                stop.recoveredWeightBasis === 'actual' ? stop.recoveredWeightKg : null,
            })),
        });
      },

      /*
       * `slot` is stored, not hard-coded to null. The fake used to pin it to
       * null, which meant it agreed with the bug in the real repository and the
       * tests could not tell the two apart.
       */
      addPhoto(input: {
        jobId: string;
        slot: string | null;
        caption: string;
        takenAt: Date;
        storageKey: string;
      }) {
        const id = nextId();
        photos.set(id, {
          id,
          jobId: input.jobId,
          slot: input.slot,
          caption: input.caption,
          takenAt: input.takenAt,
          latitude: null,
          longitude: null,
          storageKey: input.storageKey,
          uploadedAt: null,
        });
        return Promise.resolve(id);
      },

      markPhotoUploaded(photoId: string, jobId: string, at: Date) {
        const photo = photos.get(photoId);
        if (!photo || photo.jobId !== jobId) return Promise.resolve(false);
        // First confirmation wins, as in the real repository.
        photo.uploadedAt ??= at;
        return Promise.resolve(true);
      },

      findPhoto(photoId: string, jobId: string) {
        const photo = photos.get(photoId);
        if (!photo || photo.jobId !== jobId) return Promise.resolve(null);
        return Promise.resolve({ id: photo.id, storageKey: photo.storageKey });
      },

      removePhoto(photoId: string, jobId: string) {
        const photo = photos.get(photoId);
        if (!photo || photo.jobId !== jobId) return Promise.resolve(false);
        photos.delete(photoId);
        return Promise.resolve(true);
      },

      countPhotos(jobId: string) {
        return Promise.resolve([...photos.values()].filter((p) => p.jobId === jobId).length);
      },

      raiseCharge(input: {
        jobId: string;
        code: string;
        amount: string;
        photoCount: number;
        note: string | null;
      }) {
        charges.push({ ...input, approvalState: 'pending' });
        return Promise.resolve(nextId());
      },

      hasCharge(jobId: string, code: string) {
        return Promise.resolve(
          charges.some((charge) => charge.jobId === jobId && charge.code === code),
        );
      },

      /*
       * Models the real method's two guards faithfully: a decided charge is
       * never rewritten, and a pending one is updated in place rather than
       * duplicated. Getting either wrong here would let a broken overage pass.
       */
      syncPendingCharge(input: {
        jobId: string;
        code: string;
        description: string;
        quantity: number;
        unitRate: string;
        amount: string;
        raisedBy: string;
        raisedAt: Date;
        note: string | null;
      }) {
        const mine = charges.filter(
          (charge) => charge.jobId === input.jobId && charge.code === input.code,
        );

        if (mine.some((charge) => charge.approvalState !== 'pending')) {
          return Promise.resolve('locked' as const);
        }

        const existing = mine[0];
        if (!existing) {
          charges.push({
            jobId: input.jobId,
            code: input.code,
            description: input.description,
            quantity: input.quantity,
            unitRate: input.unitRate,
            amount: input.amount,
            raisedBy: input.raisedBy,
            photoCount: 0,
            note: input.note,
            approvalState: 'pending',
          });
          return Promise.resolve('created' as const);
        }

        if (existing.quantity === input.quantity) return Promise.resolve('unchanged' as const);

        existing.description = input.description;
        existing.quantity = input.quantity;
        existing.unitRate = input.unitRate;
        existing.amount = input.amount;
        existing.raisedBy = input.raisedBy;
        existing.note = input.note;
        return Promise.resolve('updated' as const);
      },

      removePendingCharge(jobId: string, code: string) {
        const index = charges.findIndex(
          (charge) =>
            charge.jobId === jobId && charge.code === code && charge.approvalState === 'pending',
        );
        if (index === -1) return Promise.resolve(false);
        charges.splice(index, 1);
        return Promise.resolve(true);
      },

      appendEvent(input: StoredEvent) {
        events.push(input);
        return Promise.resolve();
      },

      savePreStart(input: {
        jobId: string;
        completedAt: Date;
        failedItems: Array<{ key: string }>;
      }) {
        const id = nextId();
        preStarts.push({
          jobId: input.jobId,
          date: '2026-09-10',
          completedAt: input.completedAt,
          failed: input.failedItems.length,
        });
        return Promise.resolve(id);
      },

      findPreStartForDay() {
        const first = preStarts[0];
        return Promise.resolve(first ? { completedAt: first.completedAt } : null);
      },

      saveRiskAssessment(input: {
        jobId: string;
        completedAt: Date;
        safeToProceed: boolean;
      }) {
        assessments.set(input.jobId, {
          completedAt: input.completedAt,
          safeToProceed: input.safeToProceed,
          uploadState: 'queued',
        });
        const stop = stops.get(input.jobId);
        if (stop) stop.riskAssessmentDoneAt = input.completedAt;
        return Promise.resolve(nextId());
      },

      reportDefect(input: {
        vehicleRego: string;
        severity: string;
        summary: string;
        preStartItemKey?: string | null;
        photoIds?: string[];
      }) {
        defects.push({
          rego: input.vehicleRego,
          severity: input.severity,
          summary: input.summary,
          preStartItemKey: input.preStartItemKey ?? null,
          photoIds: input.photoIds ?? [],
        });
        return Promise.resolve(nextId());
      },
    },

    loadJobDetail(jobId: string) {
      return Promise.resolve({
        photos: [...photos.values()].filter((photo) => photo.jobId === jobId),
        messages: messages.filter((message) => message.jobId === jobId),
        riskAssessment: assessments.get(jobId) ?? null,
      });
    },

    addDriverMessage(input: { jobId: string; body: string; author: string; at: Date }) {
      const row = {
        id: nextId(),
        jobId: input.jobId,
        body: input.body,
        author: input.author,
        at: input.at,
        fromDriver: true,
      };
      messages.push(row);
      return Promise.resolve(row);
    },
  };
}
