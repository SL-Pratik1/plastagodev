import type { ApiClient } from '@plastago/api-client';
import {
  API_PREFIX,
  ContaminationReportSchema,
  DriverJobSchema,
  DriverVehicleChoiceSchema,
  DriverListsSchema,
  DriverVehicleOptionsSchema,
  FutileReportSchema,
  RunSheetDaySchema,
  TipOffReconciliationSchema,
  type ChooseVehicle,
  type Completion,
  type ContaminationReport,
  type DefectReport,
  type DriverJob,
  type DriverPhoto,
  type FutileReport,
  type Unarrive,
  type RunStop,
  type PreStartSubmission,
  type SiteRiskAssessment,
  type StatusUpdate,
  type TipOffEntry,
  type WeightCapture,
} from '@plastago/shared';
import * as z from 'zod';
import { cacheDriverLists } from '@/offline/driver-lists-cache';
import { enqueue, queuedOperations } from '@/offline/outbox';
import { ServiceError, StorageUploadError } from '../service-error.js';
import type { DriverRunService } from '../driver-run.types.js';
import { viaService } from './to-service-error.js';

/**
 * The driver surface (M4) over HTTP.
 *
 * ── ⚠️ Writes go to the OUTBOX, not to the network ────────────────────────
 * M4.12: everything works with no signal. So every mutation below calls
 * `enqueue()` and resolves as soon as the operation is durably recorded on the
 * phone — NOT when the server has it. `offline/outbox.ts` drains the queue in
 * order, with an idempotency key per operation so a retry after a timeout
 * cannot double-record a completion.
 *
 * There is deliberately no "online path" that behaves differently. If there
 * were, the offline case would rot from disuse and only fail in a paddock with
 * no reception, which is the one place nobody can debug it.
 *
 * Reads are direct: a run sheet the phone has never seen cannot be invented, and
 * the driver app caches what it has already fetched.
 */

/**
 * What the phone has done to a job that the server has not heard yet.
 *
 * ── Why the reads need this ───────────────────────────────────────────────
 * A report is queued, and the screen is patched the moment it is — but that
 * patch lives in memory. Reload the app, or have the OS restart it, while the
 * report is still waiting for signal, and the job comes back from the server
 * exactly as it was before the driver acted: Can't collect and Contaminated
 * offered again for a job already reported. So the queue itself is the record
 * of what the driver did, and it is laid over the server's answer until it
 * drains.
 */
interface QueuedForJob {
  futile: FutileReport | null;
  contamination: ContaminationReport | null;
  /** Photos whose bytes reached storage, with the confirmation still queued. */
  sentPhotoIds: Set<string>;
  /** Photos waiting to be removed. */
  removedPhotoIds: Set<string>;
}

/** `/api/v1/driver/jobs/<id>/<action>` — the job actions the queue can hold. */
const JOB_ACTION_PATH = /\/driver\/jobs\/([0-9a-f]{24})\/([a-z-]+)/i;

/** `/api/v1/driver/jobs/<id>/photos/<photoId>[/uploaded]` — a photo's confirmation or removal. */
const PHOTO_PATH = /\/driver\/jobs\/[0-9a-f]{24}\/photos\/([0-9a-f]{24})(\/uploaded)?$/i;

/** The statuses a futile report can still move a job out of. */
const FUTILE_FROM: ReadonlySet<string> = new Set(['assigned', 'in-transit', 'arrived']);

async function queuedByJob(): Promise<Map<string, QueuedForJob>> {
  const byJob = new Map<string, QueuedForJob>();

  for (const operation of await queuedOperations()) {
    const match = JOB_ACTION_PATH.exec(operation.path);
    const jobId = match?.[1];
    const action = match?.[2];
    if (!jobId || !action) continue;

    const entry = byJob.get(jobId) ?? {
      futile: null,
      contamination: null,
      sentPhotoIds: new Set<string>(),
      removedPhotoIds: new Set<string>(),
    };

    if (action === 'futile') {
      const parsed = FutileReportSchema.safeParse(operation.body);
      if (parsed.success) entry.futile = parsed.data;
    }
    if (action === 'contamination') {
      const parsed = ContaminationReportSchema.safeParse(operation.body);
      if (parsed.success) entry.contamination = parsed.data;
    }
    const photo = PHOTO_PATH.exec(operation.path);
    if (photo?.[1] && photo[2] && operation.method === 'POST') entry.sentPhotoIds.add(photo[1]);
    if (photo?.[1] && !photo[2] && operation.method === 'DELETE') {
      entry.removedPhotoIds.add(photo[1]);
    }

    byJob.set(jobId, entry);
  }

  return byJob;
}

/**
 * A stop as it will read once its queued actions land.
 *
 * ⚠️ `futile` only over a status it can move out of. A job the office has
 * cancelled meanwhile will refuse the report, and painting it futile would
 * hide the cancellation from the one person who must not collect it.
 */
function withQueuedStop<T extends RunStop>(stop: T, queued: QueuedForJob | undefined): T {
  if (!queued) return stop;

  return {
    ...stop,
    // What the field was always meant to say; the server can only ever send false.
    hasQueuedActions: true,
    ...(queued.futile && FUTILE_FROM.has(stop.status) ? { status: 'futile' as const } : {}),
  };
}

function withQueued(job: DriverJob, queued: QueuedForJob | undefined): DriverJob {
  if (!queued) return job;

  const stop = withQueuedStop(job, queued);
  const futileNow = stop.status === 'futile' && job.status !== 'futile' && queued.futile;
  const report = queued.contamination;

  return {
    ...stop,
    ...(futileNow ? { completedAt: queued.futile?.occurredAt ?? job.completedAt } : {}),
    /*
     * A photo whose bytes are in storage counts as sent while its confirmation
     * waits in the queue — the phone saw the upload succeed. One waiting to be
     * removed is already gone as far as the driver is concerned.
     */
    photos: job.photos
      .filter((photo) => !queued.removedPhotoIds.has(photo.id))
      .map((photo) =>
        queued.sentPhotoIds.has(photo.id) ? { ...photo, uploaded: true } : photo,
      ),
    contamination:
      job.contamination ??
      (report && job.status !== 'cancelled' && job.status !== 'futile'
        ? { reportedAt: report.occurredAt, type: report.type, extent: report.extent }
        : null),
  };
}

/** The queue only needs to know the reply parsed. */
const PresignPhotoResponseSchema = z.object({
  photoId: z.string(),
  upload: z.object({
    key: z.string(),
    uploadUrl: z.string(),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.string(),
  }),
});

/**
 * PUT the bytes straight to storage, or throw the error that says why not.
 *
 * ⚠️ Every failure here used to be thrown as OFFLINE, and the screen turned
 * that into "Photos need signal" — so a phone with full signal, whose upload
 * storage had refused, sent Matt looking for a location setting (21 Oct).
 */
async function putToStorage(
  upload: z.infer<typeof PresignPhotoResponseSchema>['upload'],
  blob: Blob,
): Promise<void> {
  let stored: Response;
  try {
    stored = await fetch(upload.uploadUrl, { method: 'PUT', headers: upload.headers, body: blob });
  } catch (cause) {
    if (!navigator.onLine) {
      throw new ServiceError('OFFLINE', 'The photo could not be uploaded — no signal', { cause });
    }
    throw new StorageUploadError(null);
  }
  if (!stored.ok) throw new StorageUploadError(stored.status);
}

export function createHttpDriverRunService(api: ApiClient): DriverRunService {
  const base = `${API_PREFIX}/driver`;

  /** Every queued write, in one place. */
  const queue = async (path: string, body?: unknown): Promise<void> => {
    await enqueue({ method: 'POST', path: `${base}${path}`, body });
  };

  return {
    /* ── Reads ────────────────────────────────────────────────────────────── */

    /*
     * Both reads lay the phone's still-queued reports over what the server
     * answered — see `withQueued`. Until the queue drains the server is
     * answering from before the driver acted, and after a reload that answer
     * is all the screen has.
     */
    runSheet: async (date: string) => {
      const [day, queued] = await Promise.all([
        viaService(() =>
          api.request(`${base}/run-sheet`, {
            searchParams: { date },
            schema: RunSheetDaySchema,
          }),
        ),
        queuedByJob(),
      ]);

      if (queued.size === 0) return day;

      const overlay = (stop: RunStop) => withQueuedStop(stop, queued.get(stop.jobId));
      return {
        ...day,
        stops: day.stops.map(overlay),
        runs: day.runs.map((run) => ({ ...run, stops: run.stops.map(overlay) })),
      };
    },

    job: async (jobId: string) => {
      const [job, queued] = await Promise.all([
        viaService(() => api.request(`${base}/jobs/${jobId}`, { schema: DriverJobSchema })),
        queuedByJob(),
      ]);
      return withQueued(job, queued.get(jobId));
    },

    /*
     * A read, so it is direct rather than queued: the driver is standing at the
     * weighbridge looking at the deduct-and-average result before committing it,
     * and a wildly wrong imputed figure almost always means a mistyped crane
     * weight they can still correct.
     */
    previewTipOff: (runId: string, totalKg: number) =>
      viaService(() =>
        api.request(`${base}/runs/${runId}/tip-off/preview`, {
          method: 'POST',
          body: { totalKg },
          schema: TipOffReconciliationSchema,
        }),
      ),

    /*
     * Today's vehicle (Matt, 21 Oct). Direct rather than queued: the driver
     * needs the answer — "taken by X" — before the pre-start, and a choice
     * replayed hours later could land on a truck somebody else has by then.
     */
    lists: async () => {
      const lists = await viaService(() =>
        api.request(`${base}/lists`, { schema: DriverListsSchema }),
      );
      cacheDriverLists(lists);
      return lists;
    },

    vehicleOptions: () =>
      viaService(() => api.request(`${base}/vehicles`, { schema: DriverVehicleOptionsSchema })),

    chooseVehicle: (input: ChooseVehicle) =>
      viaService(() =>
        api.request(`${base}/vehicle`, {
          method: 'POST',
          body: input,
          schema: DriverVehicleChoiceSchema,
        }),
      ),

    /* ── M4.2 · status ────────────────────────────────────────────────────── */

    updateStatus: (jobId: string, input: StatusUpdate) =>
      queue(`/jobs/${jobId}/status`, input),

    complete: (jobId: string, input: Completion) => queue(`/jobs/${jobId}/complete`, input),

    /* ── M4.3 · m² and kg are two different quantities ────────────────────── */

    captureWeights: (jobId: string, input: WeightCapture) =>
      queue(`/jobs/${jobId}/weights`, input),

    /* ── M4.5 · photos ────────────────────────────────────────────────────── */

    /**
     * ⚠️ THE ONE WRITE THAT NEEDS SIGNAL, and the reason is structural.
     *
     * §6A.10 #9 says photo bytes never pass through the API — the server signs a
     * URL and the phone PUTs straight to S3. A signature cannot be obtained
     * offline, and it expires, so it cannot be queued either: a URL signed on
     * Tuesday is useless when the queue drains on Wednesday.
     *
     * Making this work with no signal needs a second queue that stores the BLOB
     * and asks for a fresh signature at drain time — the "separate resumable
     * upload queue" the interface's own comment refers to. That queue is not
     * built, so this throws OFFLINE rather than pretending: a photo that
     * silently vanishes is worse than one the driver is told to retake, because
     * the five-shot protocol is what settles a contamination dispute.
     */
    addPhoto: async (jobId, input): Promise<DriverPhoto> => {
      const takenAt = new Date().toISOString();

      const { photoId } = await viaService(() =>
        api.request(`${base}/jobs/${jobId}/photos`, {
          method: 'POST',
          body: {
            caption: input.caption,
            slot: input.slot,
            contentType: input.blob.type || 'image/jpeg',
            contentLength: input.blob.size,
            takenAt,
            position: input.position,
          },
          schema: PresignPhotoResponseSchema,
        }),
      ).then(async (result) => {
        // Direct to storage: this request does NOT go through the api client,
        // because it is not going to the API.
        try {
          await putToStorage(result.upload, input.blob);
        } catch (error) {
          /*
           * The API wrote the photo's record before the upload. Left behind,
           * it would sit on the job as a shot that never arrived — so it goes,
           * queued like any other removal. Best effort: the failure the
           * driver needs to hear about is the upload's.
           */
          await enqueue({
            method: 'DELETE',
            path: `${base}/jobs/${jobId}/photos/${result.photoId}`,
          }).catch(() => undefined);
          throw error;
        }

        /*
         * Tell the API the bytes actually landed.
         *
         * Only this phone ever sees the PUT's response — the bucket does not
         * report back to the API — so without this the server can only guess,
         * and it used to guess "uploaded" from the mere existence of the record
         * it wrote before the upload began. That put a green tick on shots that
         * had failed to send.
         *
         * QUEUED rather than awaited: the confirmation is bookkeeping, and a
         * driver whose signal dies in the half-second after a successful upload
         * should not be told the photo failed when it did not. The outbox
         * retries it; until it drains, the photo reads as still sending, which
         * is the harmless direction to be wrong in.
         */
        await enqueue({
          method: 'POST',
          path: `${base}/jobs/${jobId}/photos/${result.photoId}/uploaded`,
        }).catch((error: unknown) => {
          // The bytes are safe in storage; the job just reads "still sending".
          console.warn('Could not queue the upload confirmation', error);
        });

        return result;
      });

      return {
        id: photoId,
        slot: input.slot,
        caption: input.caption,
        takenAt,
        latitude: null,
        longitude: null,
        // True, unlike the queued path: the bytes are in S3 by the time this
        // resolves, so claiming otherwise would leave a permanent "pending"
        // badge on a photo that is already safe.
        uploaded: true,
        /*
         * No URL yet, and not worth inventing one. This value is superseded the
         * moment the job refetches, and the server signs a real one then; a
         * placeholder here would only render as a broken image for that instant.
         */
        url: null,
      };
    },

    removePhoto: async (jobId: string, photoId: string) => {
      await enqueue({ method: 'DELETE', path: `${base}/jobs/${jobId}/photos/${photoId}` });
    },

    /* ── M4.6, M4.7 · the exception branches that carry charges ───────────── */

    markFutile: (jobId: string, input: FutileReport) => queue(`/jobs/${jobId}/futile`, input),

    unarrive: (jobId: string, input: Unarrive) => queue(`/jobs/${jobId}/unarrive`, input),

    markContaminated: (jobId: string, input: ContaminationReport) =>
      queue(`/jobs/${jobId}/contamination`, input),

    /* ── M4.8 · pre-start and site risk ───────────────────────────────────── */

    // Not nested under a job: a pre-start is about the TRUCK and the day, and
    // a risk assessment carries its own job id in the body.
    submitPreStart: (input: PreStartSubmission) => queue('/pre-start', input),

    submitRiskAssessment: (input: SiteRiskAssessment) => queue('/risk-assessment', input),

    /* ── M4.4 · tip-off ───────────────────────────────────────────────────── */

    /*
     * Direct, not queued — and deliberately so.
     *
     * The tip-off itself queues, but its docket photo cannot: the server hands
     * back the storage key the tip-off has to carry, and a queued write has no
     * reply to read. A weighbridge has signal in a way a building site does not,
     * so requiring it here costs the driver nothing and keeps the key honest.
     *
     * `photoId` IS the storage key for a docket (there is no photo record to
     * point at), which is why the ticket shape matches the job one exactly.
     */
    uploadDocketPhoto: async (runId: string, blob: Blob): Promise<string> => {
      const result = await api.request(`${base}/runs/${runId}/docket-photo`, {
        method: 'POST',
        body: {
          contentType: blob.type || 'image/jpeg',
          contentLength: blob.size,
        },
        schema: PresignPhotoResponseSchema,
      });

      await putToStorage(result.upload, blob);

      return result.photoId;
    },

    recordTipOff: (input: TipOffEntry) => queue('/tip-off', input),

    /* ── M4.9 · vehicle defects ───────────────────────────────────────────── */

    // Keyed by REGO in the body — the driver reports the truck they are in,
    // which is not necessarily the one on their roster row.
    /**
     * ⚠️ This did not exist, and the screen pretended it did.
     *
     * The defect form pushed a `crypto.randomUUID()` into `photoIds` and told
     * the driver the photo was saved. Nothing was ever uploaded, and the API
     * discarded the id as unparseable — so a cracked windscreen photographed
     * three times reached the workshop with no pictures at all.
     */
    uploadDefectPhoto: async (blob: Blob): Promise<string> => {
      const result = await viaService(() =>
        api.request(`${base}/defect-photo`, {
          method: 'POST',
          body: {
            contentType: blob.type || 'image/jpeg',
            contentLength: blob.size,
          },
          schema: PresignPhotoResponseSchema,
        }),
      );

      // Straight to storage — not through the API. See `addPhoto`.
      await putToStorage(result.upload, blob);

      return result.photoId;
    },

    reportDefect: (input: DefectReport) => queue('/defects', input),

    /* ── M8.6 · W102 · the office ↔ driver thread ─────────────────────────── */

    sendMessage: (jobId: string, body: string) => queue(`/jobs/${jobId}/messages`, { body }),
  };
}
