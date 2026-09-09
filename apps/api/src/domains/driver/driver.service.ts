import {
  PRE_START_ITEMS,
  RISK_CONTROLS,
  SITE_HAZARDS,
  type Completion,
  type ContaminationReport,
  type DefectReport,
  type DriverJob,
  type FutileReport,
  type GeoFix,
  type PreStartSubmission,
  type RunSheetDay,
  type RunStop,
  type SiteRiskAssessment,
  type StatusUpdate,
  type TipOffEntry,
  type TipOffReconciliation,
  type WeightCapture,
} from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { centsToMoney, moneyToCents } from '../../lib/money.js';
import {
  MAX_UPLOAD_BYTES,
  UPLOADABLE_TYPES,
  buildKey,
  getStorage,
  type PresignedUpload,
} from '../../integrations/storage.js';
import { pricingService } from '../settings/pricing.service.js';
import {
  addDriverMessage,
  driverRepository,
  loadJobDetail,
  type DriverStopRow,
} from './driver.repository.js';
import { jobNotices } from '../notifications/job-notices.service.js';
import { notificationService } from '../notifications/notification.service.js';
import { queueRepository } from '../queues/queue.repository.js';
import { reconcileTipOff } from './tipoff.js';

const log = logger.child({ module: 'driver' });

/**
 * The driver app (M4).
 *
 * ── The two things that shape every method here ───────────────────────────
 * 1. **The phone is offline half the day.** Actions are queued locally and
 *    replayed when signal returns, sometimes hours later and sometimes twice.
 *    So every mutation is idempotent, and every one carries `occurredAt` — when
 *    the DRIVER did it, not when the server heard about it. A run synced at
 *    5pm must not collapse into one timestamp, because the on-site durations
 *    and the charges derived from them would become fiction.
 *
 * 2. **The driver must never be blocked by our plumbing.** A driver in a
 *    basement car park with no GPS fix still has to be able to complete a job.
 *    Position is evidence when it is available and absent when it is not; it is
 *    never a precondition.
 */

export interface DriverCaller {
  userId: string;
  name: string;
  vehicleRego: string | null;
}

/** M4.7 — the contamination charge, per Matt's current price list. */
const CONTAMINATION_CODE = 'contamination';
const FUTILE_CODE = 'futile-pickup';

export const driverService = {
  /**
   * M4.1 — the driver's day.
   *
   * Returns runs AND a flattened stop list: most screens want "the next job"
   * without caring which run it came from, but every stop names its `runId` so
   * nothing has to infer the grouping.
   */
  async runSheet(date: string, caller: DriverCaller): Promise<RunSheetDay> {
    const [{ runs, stops }, preStart] = await Promise.all([
      driverRepository.runSheet(caller.userId, date),
      driverRepository.findPreStartForDay(caller.userId, date),
    ]);

    return {
      date,
      driverId: caller.userId,
      driverName: caller.name,
      vehicleRego: caller.vehicleRego,
      vehicleLabel: caller.vehicleRego,
      runs: runs.map((run) => ({
        runId: run.runId,
        runName: run.runName,
        sequenceForDay: run.sequenceForDay,
        suburbs: run.suburbs,
        stops: stops.filter((stop) => stop.runId?.toHexString() === run.runId).map(toRunStop),
        tipOffRecordedAt: run.tipOffRecordedAt ? run.tipOffRecordedAt.toISOString() : null,
        tipOffKg: run.tipOffKg,
      })),
      stops: stops.map(toRunStop),
      /*
       * M4.8a — the pre-start is a check on the VEHICLE, and the vehicle does
       * not change between the morning and the afternoon run. So it belongs to
       * the day rather than to either run.
       */
      preStartCompletedAt: preStart ? preStart.completedAt.toISOString() : null,
    };
  },

  async job(jobId: string, caller: DriverCaller): Promise<DriverJob> {
    const stop = await requireStop(jobId, caller);
    const detail = await loadJobDetail(jobId);

    return {
      ...toRunStop(stop),
      accessNotes: stop.accessNotes,
      gateHours: stop.gateHours,
      inductionRequired: stop.inductionRequired,
      craneAvailable: stop.craneAvailable,
      siteContactName: stop.siteContactName,
      siteContactMobile: stop.siteContactMobile,
      notes: stop.notes,
      readyDate: stop.readyDate,
      arrivedAt: stop.arrivedAt ? stop.arrivedAt.toISOString() : null,
      completedAt: stop.completedAt ? stop.completedAt.toISOString() : null,
      photos: detail.photos.map((photo) => ({
        id: photo.id,
        slot: photo.slot,
        caption: photo.caption,
        takenAt: photo.takenAt.toISOString(),
        latitude: photo.latitude,
        longitude: photo.longitude,
        /*
         * A record with a storage key is one the phone asked us to make, which
         * only happens as part of handing out an upload URL. The API cannot see
         * the phone's outbox, so from here anything recorded is on its way.
         */
        uploaded: photo.storageKey !== null,
      })),
      // Their five-shot protocol, sent as DATA so the app prompts for the right
      // ones without hard-coding them. See `REQUIRED_PHOTOS`.
      requiredPhotos: [...REQUIRED_PHOTOS],
      /*
       * ⚠️ The area is what the OFFICE recorded, echoed back for reference — a
       * driver never types it (Matt, 55:32). Null stays null: the fixed-price
       * builder's job genuinely has no area, and a zero would read as "measured
       * nothing".
       */
      capturedAreaM2: stop.expectedAreaM2,
      // Only an actual crane figure. An estimated one is the output of a tip-off
      // reconciliation, and showing it here would look like a measurement.
      craneScaleKg: stop.recoveredWeightBasis === 'actual' ? stop.recoveredWeightKg : null,
      weightsRecordedAt: stop.recoveredWeightBasis !== null && stop.completedAt !== null
        ? stop.completedAt.toISOString()
        : null,
      riskAssessment: detail.riskAssessment
        ? {
            completedAt: detail.riskAssessment.completedAt.toISOString(),
            safeToProceed: detail.riskAssessment.safeToProceed,
            uploadState: detail.riskAssessment.uploadState,
            // The generated PDF is a background step (M4.8b step 3); null until
            // it exists, which is the normal state at the fence.
            document: null,
          }
        : null,
      messages: detail.messages.map((message) => ({
        id: message.id,
        body: message.body,
        author: message.author,
        at: message.at.toISOString(),
        fromDriver: message.fromDriver,
      })),
    };
  },

  /** M8.6 · W102 — the driver's side of the office ↔ driver thread. */
  async sendMessage(jobId: string, body: string, caller: DriverCaller): Promise<void> {
    await requireStop(jobId, caller);

    const trimmed = body.trim();
    if (!trimmed) {
      throw AppError.validation('Write something before sending', [
        { path: 'body', message: 'A message cannot be empty' },
      ]);
    }

    await addDriverMessage({
      jobId,
      body: trimmed,
      authorId: caller.userId,
      author: caller.name,
      at: new Date(),
    });
  },

  /**
   * M4.2 — status, with the driver's own timestamp and position.
   *
   * ── Why a replayed action is a success, not a conflict ────────────────────
   * The phone queues actions offline and replays them on reconnect. A job
   * already in the target state means the earlier attempt landed — the driver
   * did what they meant to, and answering 409 would make their app show a
   * failure for something that worked. So this returns quietly.
   *
   * Moving BACKWARDS is different and is refused: that is not a replay, it is a
   * stale action arriving after a later one, and applying it would rewrite the
   * timeline.
   */
  async updateStatus(jobId: string, input: StatusUpdate, caller: DriverCaller): Promise<void> {
    const stop = await requireStop(jobId, caller);
    const occurredAt = new Date(input.occurredAt);

    if (stop.status === 'cancelled') {
      throw AppError.conflict('The office cancelled this job — do not collect it');
    }

    const target = TRANSITION_TARGETS[input.transition];
    if (stop.status === target) return; // Replay. Already where it should be.

    if (RANK[stop.status] > RANK[target]) {
      throw AppError.conflict(
        `This job is already ${LABEL[stop.status]} — it cannot go back to ${LABEL[target]}`,
      );
    }

    const changed = await driverRepository.transition({
      jobId,
      driverId: caller.userId,
      to: target,
      fromStatuses: [...ALLOWED_FROM[input.transition]],
      occurredAt,
      ...(target === 'arrived' ? { arrivedAt: occurredAt } : {}),
    });

    if (!changed) {
      // The status moved between the read above and the write. Almost always a
      // second replay of the same action arriving concurrently.
      return;
    }

    await driverRepository.appendEvent({
      jobId,
      at: occurredAt,
      label: EVENT_LABEL[input.transition],
      actor: caller.name,
      status: target,
      detail: null,
      latitude: input.position?.latitude ?? null,
      longitude: input.position?.longitude ?? null,
    });

    /*
     * M8.1 — "our driver is on the way".
     *
     * ⚠️ Only on `in-transit`, and only after the transition actually changed
     * something. `arrived` is not messaged: by then the driver is at the gate
     * and a message is no use to anybody. The replay guards above mean a phone
     * re-sending a queued action (§6A.8) cannot produce a second message.
     */
    if (target === 'in-transit') await jobNotices.enRoute(jobId);
  },

  /**
   * M4.10 — complete, with a plain note.
   *
   * `onSiteMinutes` is derived here rather than stored by the phone: it is
   * `arrivedAt → now`, and both ends must come from the same clock or the
   * duration is meaningless. It is the basis of the extra-load-time charge, so
   * it has to be defensible.
   */
  async complete(jobId: string, input: Completion, caller: DriverCaller): Promise<void> {
    const stop = await requireStop(jobId, caller);
    const occurredAt = new Date(input.occurredAt);

    if (stop.status === 'completed') return; // Replay.
    if (stop.status === 'cancelled') {
      throw AppError.conflict('The office cancelled this job — do not collect it');
    }

    /*
     * M4.8b — where the account requires a Site Risk Assessment, it must exist
     * before the job can be closed. Checked at COMPLETION rather than at arrival
     * because Matt was explicit (1:07:26) that the assessment must never gate
     * access to the job — the driver decides when to fill it in.
     */
    if (stop.riskAssessmentRequired && stop.riskAssessmentDoneAt === null) {
      throw AppError.conflict(
        'This site needs a risk assessment before the job can be completed',
      );
    }

    const onSiteMinutes =
      stop.arrivedAt === null
        ? null
        : Math.max(0, Math.round((occurredAt.getTime() - stop.arrivedAt.getTime()) / 60_000));

    const changed = await driverRepository.transition({
      jobId,
      driverId: caller.userId,
      to: 'completed',
      fromStatuses: ['assigned', 'in-transit', 'arrived'],
      occurredAt,
      completedAt: occurredAt,
      onSiteMinutes,
    });

    if (!changed) return;

    await driverRepository.appendEvent({
      jobId,
      at: occurredAt,
      label: 'Job completed',
      actor: caller.name,
      status: 'completed',
      detail: input.note.trim() || null,
      latitude: input.position?.latitude ?? null,
      longitude: input.position?.longitude ?? null,
    });

    /*
     * M8.2 · F24 — the completion summary, with the photo count.
     *
     * ⚠️ Last, and unable to throw. A driver standing on a site with a queued
     * action must never see a failure because a mail server was down — the
     * completion is what the invoice is raised from, and it is already written.
     */
    await jobNotices.completed(jobId);

    log.info({ jobId, jobNumber: stop.jobNumber, onSiteMinutes }, 'job completed on the phone');
  },

  /**
   * M4.3 — bags and the crane-scale weight.
   *
   * ⚠️ There is deliberately no `areaM2` here. Matt, 55:32: *"they won't enter
   * the square meter information — that will be entered in the admin side before
   * the job."* A driver looking at a pile cannot tell its area, so asking would
   * only produce whatever got them past the field — and that figure is what the
   * job is priced on.
   */
  async captureWeights(jobId: string, input: WeightCapture, caller: DriverCaller): Promise<void> {
    const stop = await requireStop(jobId, caller);

    if (input.loadType === 'hand-load' && input.craneScaleKg !== null) {
      throw AppError.validation('A hand-loaded job has no crane weight', [
        {
          path: 'craneScaleKg',
          message: 'Leave this empty on a hand load — the weight comes from the weighbridge',
        },
      ]);
    }

    /*
     * An m²-only account never records kilograms (M2.3). Accepting one would put
     * a weight on a certificate for a customer who does not buy that service.
     */
    if (!stop.capturesWeight && input.craneScaleKg !== null) {
      throw AppError.validation('This account records square metres only', [
        { path: 'craneScaleKg', message: 'No weight is recorded for this customer' },
      ]);
    }

    await driverRepository.recordWeights({
      jobId,
      driverId: caller.userId,
      bagCount: input.bagCount,
      loadType: input.loadType,
      craneScaleKg: input.craneScaleKg,
    });

    await driverRepository.appendEvent({
      jobId,
      at: new Date(input.occurredAt),
      label: 'Weights captured',
      actor: caller.name,
      status: null,
      detail:
        input.craneScaleKg === null
          ? `${String(input.bagCount)} bags, hand loaded`
          : `${String(input.bagCount)} bags, ${String(input.craneScaleKg)} kg on the crane scale`,
      latitude: input.position?.latitude ?? null,
      longitude: input.position?.longitude ?? null,
    });
  },

  /**
   * M4.5 — register a photo and hand back somewhere to put the bytes.
   *
   * The bytes never pass through this API: the phone PUTs them straight to
   * object storage with the presigned URL returned here (§6A.10 #9). See the
   * note at the top of `integrations/storage.ts` for why.
   */
  async presignPhoto(
    jobId: string,
    input: { caption: string; contentType: string; contentLength: number; takenAt: string; position: GeoFix | null },
    caller: DriverCaller,
  ): Promise<{ photoId: string; upload: PresignedUpload }> {
    await requireStop(jobId, caller);

    assertUploadable(input);

    const key = buildKey({
      scope: 'jobs',
      ownerId: jobId,
      kind: 'photos',
      contentType: input.contentType,
    });

    /*
     * The record is written BEFORE the bytes arrive, and that is deliberate: the
     * phone may upload minutes later over a bad connection, and the office
     * should be able to see that a photo is coming. An orphaned record with no
     * object behind it is a visible gap; an uploaded object with no record is
     * invisible and unfindable.
     */
    const [upload, photoId] = await Promise.all([
      getStorage().presignUpload({
        key,
        contentType: input.contentType,
        contentLength: input.contentLength,
      }),
      driverRepository.addPhoto({
        jobId,
        caption: input.caption.trim() || 'Site photo',
        takenAt: new Date(input.takenAt),
        takenBy: caller.name,
        latitude: input.position?.latitude ?? null,
        longitude: input.position?.longitude ?? null,
        storageKey: key,
      }),
    ]);

    return { photoId, upload };
  },

  async removePhoto(jobId: string, photoId: string, caller: DriverCaller): Promise<void> {
    await requireStop(jobId, caller);

    const photo = await driverRepository.findPhoto(photoId, jobId);
    if (!photo) throw AppError.notFound('No such photo on this job');

    await driverRepository.removePhoto(photoId, jobId);

    // The object goes too. A photo the office cannot see is not evidence, and
    // leaving orphaned bytes in the bucket costs money for nothing.
    if (photo.storageKey) {
      await getStorage().remove(photo.storageKey);
    }
  },

  /**
   * M4.6 — mark futile. This is the money loop.
   *
   * The customer certified at booking that the site was ready and accessible
   * (M5.2). Photo + GPS + timestamp at the point of failure turns a disputed
   * phone call into an invoice line that survives a challenge — which is why at
   * least one photo is required and the reason is structured, never free text.
   */
  async markFutile(jobId: string, input: FutileReport, caller: DriverCaller): Promise<void> {
    const stop = await requireStop(jobId, caller);
    const occurredAt = new Date(input.occurredAt);

    if (stop.status === 'futile') return; // Replay.
    if (stop.status === 'completed') {
      throw AppError.conflict('This job is already completed, so it cannot be marked futile');
    }

    await driverRepository.transition({
      jobId,
      driverId: caller.userId,
      to: 'futile',
      fromStatuses: ['assigned', 'in-transit', 'arrived'],
      occurredAt,
      completedAt: occurredAt,
    });

    await raiseChargeOnce({
      jobId,
      code: FUTILE_CODE,
      caller,
      occurredAt,
      photoCount: input.photoIds.length,
      note: input.note.trim() || null,
    });

    await driverRepository.appendEvent({
      jobId,
      at: occurredAt,
      label: 'Marked futile',
      actor: caller.name,
      status: 'futile',
      detail: input.note.trim() || input.reason,
      latitude: input.position?.latitude ?? null,
      longitude: input.position?.longitude ?? null,
    });

    /*
     * M2.6 — a futile job opens a REVIEW for the office.
     *
     * The driver has done all they can; somebody now has to decide whether the
     * pickup is rescheduled or cancelled, and ring the customer. Without this
     * the job would simply sit as futile with nobody owning the next step —
     * which is how a builder finds out by noticing the truck never came back.
     *
     * Idempotent, so a replayed futile report does not open a second review.
     */
    await queueRepository.openFutileReview({
      jobId,
      reason: input.reason,
      note: input.note.trim() || null,
      markedAt: occurredAt,
    });

    log.info({ jobId, jobNumber: stop.jobNumber, reason: input.reason }, 'job marked futile');
  },

  /**
   * M4.7 — contamination, which raises a charge into the approval queue (M2.7).
   *
   * The job still completes: the driver took the load. What changes is that a
   * charge now needs the office's approval, and the office approves it by
   * looking at the photo.
   */
  async markContaminated(
    jobId: string,
    input: ContaminationReport,
    caller: DriverCaller,
  ): Promise<void> {
    const stop = await requireStop(jobId, caller);
    const occurredAt = new Date(input.occurredAt);

    await raiseChargeOnce({
      jobId,
      code: CONTAMINATION_CODE,
      caller,
      occurredAt,
      photoCount: input.photoIds.length,
      note: `${input.type} · ${input.extent}${input.note.trim() ? ` — ${input.note.trim()}` : ''}`,
    });

    await driverRepository.appendEvent({
      jobId,
      at: occurredAt,
      label: 'Contamination reported',
      actor: caller.name,
      status: null,
      detail: `${input.type} · ${input.extent}`,
      latitude: input.position?.latitude ?? null,
      longitude: input.position?.longitude ?? null,
    });

    log.info(
      { jobId, jobNumber: stop.jobNumber, type: input.type, extent: input.extent },
      'contamination reported',
    );
  },

  /**
   * M4.8a — the pre-start checklist.
   *
   * ⚠️ A failed item is not a warning to dismiss. Chain of Responsibility makes
   * this an OPERATOR obligation, so each failure becomes a defect report (M4.9)
   * that somebody has to close.
   */
  async submitPreStart(input: PreStartSubmission, caller: DriverCaller): Promise<void> {
    const { stops } = await driverRepository.runSheet(caller.userId, input.date);
    const first = stops[0];

    if (!first) {
      throw AppError.conflict('You have no runs on that date, so there is nothing to check in for');
    }

    const labels = new Map<string, string>(PRE_START_ITEMS.map((item) => [item.key, item.label]));

    const failed = input.items
      .filter((item) => item.state === 'fail')
      .map((item) => ({
        key: item.key,
        label: labels.get(item.key) ?? item.key,
        note: item.note,
      }));

    const preStartId = await driverRepository.savePreStart({
      jobId: first._id.toHexString(),
      driverId: caller.userId,
      driverName: caller.name,
      completedAt: new Date(input.occurredAt),
      vehicleRego: input.vehicleRego,
      odometerKm: input.odometerKm,
      failedItems: failed,
      // The denominator. A wall of green ticks is noise, but "3 of 14" is not.
      itemsChecked: input.items.length,
    });

    /*
     * One defect per failed item, so each is closed on its own. `unroadworthy`
     * is not inferred from the checklist — the driver grades severity when they
     * report it directly. A pre-start failure defaults to needing attention,
     * which is a booking, not a grounding.
     */
    for (const item of failed) {
      await driverRepository.reportDefect({
        vehicleRego: input.vehicleRego,
        reportedByUserId: caller.userId,
        reportedByName: caller.name,
        severity: 'needs-attention',
        summary: item.label,
        detail: item.note,
        photoIds: [],
        occurredAt: new Date(input.occurredAt),
        latitude: input.position?.latitude ?? null,
        longitude: input.position?.longitude ?? null,
        preStartId,
        preStartItemKey: item.key,
      });
    }

    log.info(
      { driverId: caller.userId, date: input.date, failures: failed.length },
      'pre-start submitted',
    );
  },

  /**
   * M4.8b — the Site Risk Assessment.
   *
   * Saved as a plain replayable payload. The PDF, the QR scan and the handoff to
   * the builder's portal are recorded as STATES on it rather than being
   * prerequisites for saving, because this has to work at a fence with no
   * signal.
   */
  async submitRiskAssessment(input: SiteRiskAssessment, caller: DriverCaller): Promise<void> {
    const stop = await requireStop(input.jobId, caller);

    // Resolved to labels on write, so the office never needs the key table to
    // read the record back — and so a later change to the key list cannot
    // silently rewrite what a past assessment said.
    const hazardLabels = new Map<string, string>(SITE_HAZARDS.map((item) => [item.key, item.label]));
    const controlLabels = new Map<string, string>(
      RISK_CONTROLS.map((item) => [item.key, item.label]),
    );

    await driverRepository.saveRiskAssessment({
      jobId: input.jobId,
      driverId: caller.userId,
      driverName: caller.name,
      completedAt: new Date(input.occurredAt),
      hazards: input.hazardKeys.map((key) => hazardLabels.get(key) ?? key),
      controls: input.controlKeys.map((key) => controlLabels.get(key) ?? key),
      note: input.note,
      safeToProceed: input.safeToProceed,
      swmsVersion: input.swmsVersion,
      builderPortalCode: input.builderPortalCode,
    });

    await driverRepository.appendEvent({
      jobId: input.jobId,
      at: new Date(input.occurredAt),
      label: input.safeToProceed ? 'Risk assessment completed' : 'Work stopped — site unsafe',
      actor: caller.name,
      status: null,
      detail: input.note.trim() || null,
      latitude: input.position?.latitude ?? null,
      longitude: input.position?.longitude ?? null,
    });

    if (!input.safeToProceed) {
      log.warn(
        { jobId: input.jobId, jobNumber: stop.jobNumber, driver: caller.name },
        'driver judged a site unsafe and stopped work',
      );

      /*
       * ⚠️ One of only two URGENT notifications in the system.
       *
       * A driver has walked off a site. Somebody has to ring the builder now —
       * waiting for the nightly sweep would mean finding out tomorrow that a
       * pickup did not happen and nobody knew why.
       */
      await notificationService.notifyOffice({
        category: 'exception',
        severity: 'urgent',
        title: `Site unsafe — #${String(stop.jobNumber)} stopped`,
        body: `${caller.name} judged ${stop.siteName} unsafe and did not collect. ${input.note.trim() || 'No note given.'}`,
        href: `/jobs/${input.jobId}`,
        subjectKey: `site-unsafe:${input.jobId}`,
        jobId: input.jobId,
        jobNumber: stop.jobNumber,
      });
    }
  },

  /**
   * M4.4 — the reconciliation preview.
   *
   * A read, so the driver sees the deduct-and-average result BEFORE committing
   * it. A wildly wrong imputed figure almost always means a mistyped crane
   * weight, and they are still standing at the weighbridge.
   */
  async previewTipOff(
    runId: string,
    totalKg: number,
    caller: DriverCaller,
  ): Promise<TipOffReconciliation> {
    const run = await driverRepository.stopsForReconciliation(runId, caller.userId);
    if (!run) throw AppError.notFound('No such run on your sheet');

    return reconcileTipOff({ runId, runName: run.runName, date: run.date, totalKg, stops: run.stops });
  },

  /**
   * M4.4 — somewhere to put the weighbridge docket photo.
   *
   * The docket belongs to the RUN, not to any one stop, so it cannot go through
   * `presignPhoto`: that writes a `jobphotos` row, and there is no job to hang
   * this on. Nor should there be — the docket evidences the whole load, and
   * filing it against an arbitrary stop would misattribute it.
   *
   * So there is no photo RECORD here, only an object. The key comes straight
   * back to the caller, who sends it as `docketPhotoId` on the tip-off, and it
   * is stored as `docketPhotoKey` on the run's docket. That is why `photoId`
   * below IS the storage key: the ticket shape stays identical to the job one,
   * so a client handles both the same way.
   */
  async presignDocketPhoto(
    runId: string,
    input: { contentType: string; contentLength: number },
    caller: DriverCaller,
  ): Promise<{ photoId: string; upload: PresignedUpload }> {
    // Same ownership gate as the tip-off itself — a driver may only attach a
    // docket to a run on their own sheet.
    const run = await driverRepository.stopsForReconciliation(runId, caller.userId);
    if (!run) throw AppError.notFound('No such run on your sheet');

    assertUploadable(input);

    const key = buildKey({
      scope: 'runs',
      ownerId: runId,
      kind: 'dockets',
      contentType: input.contentType,
    });

    const upload = await getStorage().presignUpload({
      key,
      contentType: input.contentType,
      contentLength: input.contentLength,
    });

    return { photoId: key, upload };
  },

  /**
   * M4.4 — commit the docket and write the imputed weights.
   *
   * ⚠️ Refuses a reconciliation that does not add up. These figures go onto
   * diversion certificates and EPA records; committing a negative or
   * unattributable remainder would corrupt one, and unpicking it later means
   * reissuing a document with a customer's name on it.
   */
  async recordTipOff(input: TipOffEntry, caller: DriverCaller): Promise<void> {
    const run = await driverRepository.stopsForReconciliation(input.runId, caller.userId);
    if (!run) throw AppError.notFound('No such run on your sheet');

    const reconciliation = reconcileTipOff({
      runId: input.runId,
      runName: run.runName,
      date: run.date,
      totalKg: input.totalKg,
      stops: run.stops,
    });

    if (reconciliation.looksWrong) {
      throw AppError.conflict(
        reconciliation.warning ?? 'That docket does not reconcile against the weights captured',
      );
    }

    await driverRepository.recordTipOff({
      runId: input.runId,
      driverId: caller.userId,
      date: input.date,
      totalKg: input.totalKg,
      docketReference: input.docketReference,
      // The wire calls it an id; it is the storage key the run-scoped upload returned.
      docketPhotoKey: input.docketPhotoId,
      tippedOffAt: new Date(input.occurredAt),
    });

    await driverRepository.applyImputedWeights(
      reconciliation.lines
        .filter((line): line is typeof line & { imputedKg: number } => line.imputedKg !== null)
        .map((line) => ({ jobId: line.jobId, imputedKg: line.imputedKg })),
    );

    log.info(
      {
        runId: input.runId,
        totalKg: input.totalKg,
        measuredKg: reconciliation.measuredKg,
        remainderKg: reconciliation.remainderKg,
        apportionedTo: reconciliation.lines.filter((line) => line.imputedKg !== null).length,
      },
      'tip-off recorded and reconciled',
    );
  },

  /** M4.9 — a defect reported directly, rather than off a pre-start item. */
  async reportDefect(input: DefectReport, caller: DriverCaller): Promise<void> {
    const defectId = await driverRepository.reportDefect({
      vehicleRego: input.vehicleRego,
      reportedByUserId: caller.userId,
      reportedByName: caller.name,
      severity: input.severity,
      summary: input.summary,
      detail: input.detail,
      photoIds: input.photoIds,
      occurredAt: new Date(input.occurredAt),
      latitude: input.position?.latitude ?? null,
      longitude: input.position?.longitude ?? null,
    });

    // An unroadworthy truck is the one report that has to reach somebody today.
    const level = input.severity === 'unroadworthy' ? 'warn' : 'info';
    log[level](
      { defectId, rego: input.vehicleRego, severity: input.severity, driver: caller.name },
      'vehicle defect reported',
    );

    /*
     * ⚠️ The other URGENT case. An unroadworthy truck cannot be driven, and the
     * allocator may be about to put it on tomorrow's run. Everything else a
     * driver reports waits for the sweep.
     */
    if (input.severity === 'unroadworthy') {
      await notificationService.notifyOffice({
        category: 'exception',
        severity: 'urgent',
        title: `${input.vehicleRego} reported UNROADWORTHY`,
        body: `${caller.name}: ${input.summary}. Do not allocate this vehicle until it is cleared.`,
        href: '/fleet',
        subjectKey: `unroadworthy:${defectId}`,
      });
    }
  },
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * The upload rules, shared by the job photo and the tip-off docket.
 *
 * Both hand out a presigned URL with the declared length signed into it, so both
 * have to refuse the same things — and refuse them HERE, before a URL exists,
 * rather than letting the bucket reject the PUT where the phone gets a signature
 * error it cannot explain to the driver.
 */
function assertUploadable(input: { contentType: string; contentLength: number }): void {
  if (!UPLOADABLE_TYPES.has(input.contentType)) {
    throw AppError.validation('That file type cannot be uploaded', [
      { path: 'contentType', message: 'Photos must be JPEG, PNG, HEIC or WebP' },
    ]);
  }

  if (input.contentLength > MAX_UPLOAD_BYTES) {
    throw AppError.validation('That photo is too large', [
      {
        path: 'contentLength',
        message: `Photos must be under ${String(Math.round(MAX_UPLOAD_BYTES / 1024 / 1024))} MB`,
      },
    ]);
  }
}

/**
 * The stop, or a 404.
 *
 * 404 rather than 403 for a job belonging to another driver: a 403 confirms the
 * job exists, and the phone has no business learning that.
 */
async function requireStop(jobId: string, caller: DriverCaller): Promise<DriverStopRow> {
  const stop = await driverRepository.findJobForDriver(jobId, caller.userId);
  if (!stop) throw AppError.notFound('That job is not on your run sheet');
  return stop;
}

/**
 * Raises a driver charge at most once per job.
 *
 * ⚠️ The idempotency that matters most in this file. A phone replaying a queued
 * contamination report would otherwise raise a second $90 charge, and the office
 * would approve both — the customer is then billed twice for one pile of timber.
 */
async function raiseChargeOnce(input: {
  jobId: string;
  code: typeof CONTAMINATION_CODE | typeof FUTILE_CODE;
  caller: DriverCaller;
  occurredAt: Date;
  photoCount: number;
  note: string | null;
}): Promise<void> {
  if (await driverRepository.hasCharge(input.jobId, input.code)) return;

  const priced = await pricingService.priceAdditionalService(input.code);

  await driverRepository.raiseCharge({
    jobId: input.jobId,
    code: input.code,
    description: priced.label,
    quantity: 1,
    unitRate: priced.amountExGst,
    amount: centsToMoney(moneyToCents(priced.amountExGst)),
    raisedBy: input.caller.name,
    raisedAt: input.occurredAt,
    photoCount: input.photoCount,
    note: input.note,
  });
}

function toRunStop(row: DriverStopRow): RunStop {
  return {
    jobId: row._id.toHexString(),
    jobNumber: row.jobNumber,
    // 1-based: the driver navigates by "job 3 of 7", and a zero would read as
    // a bug on a screen somebody is holding at a gate.
    sequence: row.runSequence ?? 1,
    status: row.status,
    accountName: row.accountName,
    builderName: row.builderName,
    siteName: row.siteName,
    lotNumber: row.lotNumber,
    addressLine: row.addressLine,
    suburb: row.suburb,
    postcode: row.postcode,
    zone: row.zone,
    latitude: row.latitude,
    longitude: row.longitude,
    // The contract wants a number here. The distinction between "no area" and
    // "zero area" matters to PRICING and to the tip-off split, both of which
    // read the job directly — not to a driver looking at a stop card.
    expectedAreaM2: row.expectedAreaM2 ?? 0,
    bagCount: row.bagCount,
    loadType: row.loadType,
    capturesWeight: row.capturesWeight,
    poNumber: row.poNumber,
    urgent: row.serviceLevel === 'urgent',
    riskAssessmentRequired: row.riskAssessmentRequired,
    riskAssessmentDoneAt: row.riskAssessmentDoneAt
      ? row.riskAssessmentDoneAt.toISOString()
      : null,
    photoCount: row.photoCount,
    // Server-side there is no outbox: anything the API can see has arrived.
    hasQueuedActions: false,
    runId: row.runId ? row.runId.toHexString() : '',
  };
}

/* ── Status machinery ────────────────────────────────────────────────────── */

const TRANSITION_TARGETS = {
  'in-transit': 'in-transit',
  arrived: 'arrived',
  completed: 'completed',
} as const;

const ALLOWED_FROM = {
  'in-transit': ['assigned'],
  arrived: ['assigned', 'in-transit'],
  completed: ['assigned', 'in-transit', 'arrived'],
} as const satisfies Record<string, readonly RunStop['status'][]>;

/**
 * How far through the day each status is.
 *
 * Used only to tell a REPLAY (same state, fine) from a STALE action arriving
 * after a later one (backwards, refused). Terminal states rank highest so
 * nothing reopens them.
 */
const RANK: Record<RunStop['status'], number> = {
  booked: 0,
  assigned: 1,
  'in-transit': 2,
  arrived: 3,
  completed: 4,
  'admin-complete': 5,
  futile: 4,
  cancelled: 5,
};

const LABEL: Record<RunStop['status'], string> = {
  booked: 'booked',
  assigned: 'assigned',
  'in-transit': 'en route',
  arrived: 'on site',
  completed: 'completed',
  'admin-complete': 'admin complete',
  futile: 'futile',
  cancelled: 'cancelled',
};

const EVENT_LABEL = {
  'in-transit': 'Driver en route',
  arrived: 'Driver on site',
  completed: 'Job completed',
} as const;

/**
 * M4.5 — their photo protocol, as data.
 *
 * Matt described it as a prompt rather than a fixed form: *"a prompt of what's
 * in the photos that are required, and a space to put in any others"*. Sent to
 * the phone so the app renders the checklist without hard-coding it, and so
 * changing the protocol later is a server change rather than an app release.
 *
 * "Cars on site" is the conditional one — it only applies where the driver could
 * not close the site, which is exactly the case that gets disputed.
 */
const REQUIRED_PHOTOS = [
  {
    key: 'front-of-site',
    label: 'Front of site',
    hint: 'Wide shot from the street, showing the lot number if you can',
    required: true,
  },
  {
    key: 'pile-before',
    label: 'Pile before',
    hint: 'The whole stack before you start loading',
    required: true,
  },
  {
    key: 'pile-after',
    label: 'Pile after',
    hint: 'The same spot once the load is on the truck',
    required: true,
  },
  {
    key: 'site-closed',
    label: 'Site closed',
    hint: 'Gates shut and the site left as you found it',
    required: true,
  },
  {
    key: 'cars-on-site',
    label: 'Cars on site',
    hint: 'Only if you could not close the site — shows why',
    required: false,
  },
] as const;
