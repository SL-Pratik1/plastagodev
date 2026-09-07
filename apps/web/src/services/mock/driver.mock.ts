import { type DriverJob, type DriverPhoto, type TipOffReconciliation } from '@plastago/shared';
import { enqueue } from '@/offline/outbox';
import { setOutboxTransport, type OutboxRequest } from '@/offline/transport';
import type { DriverRunService } from '../driver-run.types.js';
import { driverStore, findJob, updateDay, updateJob } from './driver-store.js';
import { DEMO_DRIVER, RUN_DATE } from './fixtures/driver-run.js';

/**
 * The mock implementation of the driver surface (M4).
 *
 * ── Every write goes through the outbox, exactly as it will in production ──
 * `enqueue()` first, local state second. That ordering is the whole point of
 * M4.12: the durable record of "the driver did this" exists before the
 * optimistic UI does, so a phone killed mid-action loses the pixels and keeps
 * the fact.
 *
 * It also means the queue is genuinely exercised in the demo — the badge counts
 * real operations, the retry backoff is the real backoff, and turning on the
 * offline switch fills a real queue. The only thing standing in for the server
 * is `mockTransport` below.
 *
 * ⚠️ This is the one mock in the app that does NOT use `mock-transport.ts`'s
 * shared `latency()`. Not an oversight: those helpers model a request/response
 * round trip, and a driver write has none — it resolves at the queue. Borrowing
 * them here would quietly reintroduce the very assumption this surface exists to
 * remove.
 *
 * ── What the mock transport does NOT do ───────────────────────────────────
 * It does not re-apply the operation. The local state was already updated when
 * the action was taken, because that is what the driver has to see offline.
 * Applying it again on drain would be modelling a server round trip that the
 * offline design specifically avoids.
 */

const latency = (base = 220, jitter = 120) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, base + Math.random() * jitter);
  });

/* ── The stand-in for the server ──────────────────────────────────────────── */

/**
 * Accepts a queued operation, slowly and occasionally badly.
 *
 * The 1-in-12 failure is deliberate: the failure path — a red "not sent" badge,
 * a retry with backoff, a driver who can still work — is the part of M4.12 that
 * actually needs demonstrating, and a transport that never fails would leave it
 * untested and unseen.
 */
const mockTransport = async (request: OutboxRequest): Promise<void> => {
  await latency(420, 260);
  if (Math.random() < 1 / 12) {
    throw new Error(`The office did not acknowledge ${request.path}`);
  }
};

/* ── M4.4 · the deduct-and-average reconciliation ─────────────────────────── */

/**
 * Matt's algorithm, as he restated it at 56:11:
 *
 * ```
 *   tip_off_total_kg                     weighbridge, per run
 * − Σ crane_scale_weight (bagged jobs)   actually measured
 * = remainder_kg
 * × (this job's m² ÷ Σ hand-load m²)     PROPORTIONAL, not per head
 * = imputed_weight_kg for that job
 * ```
 *
 * His worked example: *"one's 1000 square meters and one's 500 square meters. We
 * want to give 2/3 of the weight left over to that 1000 square meter job and 1/3
 * of that weight left over to the 500 square meter job."*
 *
 * ⚠️ This replaced an equal `remainder ÷ count` split. The difference is not
 * cosmetic: an equal split puts identical tonnage on a garage and a two-storey
 * house, and that tonnage is what gets printed on each customer's own diversion
 * certificate. Splitting by size is the only version that survives a customer
 * comparing their certificate with their neighbour's.
 *
 * ⚠️ Computed here as the stand-in for the server, and it must stay there. This
 * number IS the tonnes-diverted figure on a diversion certificate (M9.5 · F52),
 * it goes into builders' Green Star submissions and EPA RRO14 records, and the
 * Flutter app must produce the same answer. A second implementation on a phone
 * would be a second thing to keep correct.
 */
function reconcile(runId: string, totalKg: number): TipOffReconciliation {
  const run = driverStore.day.runs.find((candidate) => candidate.runId === runId);
  const onThisRun = new Set(run?.stops.map((stop) => stop.jobId) ?? []);

  /*
   * Only the stops on THIS run.
   *
   * The docket in the driver's hand is for one trip (Matt, 43:50). Reconciling
   * a morning weighbridge figure against the whole day's completed jobs would
   * hand the afternoon's stops a share of weight that was never on the truck —
   * and that share is what gets printed on a diversion certificate.
   */
  const collected = driverStore.jobs.filter(
    (job) =>
      onThisRun.has(job.jobId) &&
      (job.status === 'completed' || job.status === 'admin-complete'),
  );

  const bagged = collected.filter((job) => job.loadType === 'bagged');
  const handLoad = collected.filter((job) => job.loadType === 'hand-load');

  const measuredKg = bagged.reduce((sum, job) => sum + (job.craneScaleKg ?? 0), 0);
  const remainderKg = Math.round((totalKg - measuredKg) * 10) / 10;

  const handLoadAreaM2 = handLoad.reduce((sum, job) => sum + job.expectedAreaM2, 0);

  /*
   * Each hand-load job's share of the leftover, weighted by its size.
   *
   * The zero-area fallback is an equal split rather than a crash or a null: a
   * job with no recorded m² is a data gap in the office, and the driver at the
   * weighbridge cannot fix it. Dropping the weight entirely would lose recovered
   * tonnage out of the mass balance, which is worse than distributing it evenly.
   */
  const shareFor = (areaM2: number): number | null => {
    if (handLoad.length === 0) return null;
    const fraction = handLoadAreaM2 > 0 ? areaM2 / handLoadAreaM2 : 1 / handLoad.length;
    return Math.round(remainderKg * fraction * 10) / 10;
  };

  const largestShare = handLoad.reduce(
    (max, job) => Math.max(max, shareFor(job.expectedAreaM2) ?? 0),
    0,
  );

  /*
   * A negative remainder means the crane weights already exceed the weighbridge
   * total, which is physically impossible — almost always a mistyped kilogram
   * figure. Flagged rather than committed, because the driver is standing at the
   * weighbridge and can still fix it; a bad number here corrupts a certificate
   * that ends up in a Green Star submission.
   *
   * The implausibility check is on the LARGEST share, not an average: with a
   * proportional split one oversized job can absorb most of the remainder while
   * the mean still looks reasonable.
   */
  const looksWrong = remainderKg < 0 || largestShare > 2000;

  return {
    runId,
    runName: run?.runName ?? 'This run',
    date: RUN_DATE,
    totalKg,
    measuredKg,
    remainderKg,
    handLoadJobCount: handLoad.length,
    handLoadAreaM2,
    looksWrong,
    warning:
      remainderKg < 0
        ? 'The weights you entered on bagged jobs already add up to more than this tip-off figure. Check the docket and the crane readings before saving.'
        : largestShare > 2000
          ? 'That works out to more than two tonnes on one hand-load job, which is unusually high. Worth a second look.'
          : handLoad.length === 0 && remainderKg > 50
            ? 'Every job on this run was weighed, so this remainder has nowhere to go. It will be recorded against the run rather than a job.'
            : null,
    lines: collected.map((job) => {
      const imputedKg = job.loadType === 'hand-load' ? shareFor(job.expectedAreaM2) : null;
      return {
        jobId: job.jobId,
        jobNumber: job.jobNumber,
        siteName: job.siteName,
        loadType: job.loadType,
        areaM2: job.expectedAreaM2,
        measuredKg: job.loadType === 'bagged' ? job.craneScaleKg : null,
        imputedKg,
        shareOfRemainder:
          imputedKg === null || remainderKg <= 0 ? null : imputedKg / remainderKg,
      };
    }),
  };
}

/* ── The service ──────────────────────────────────────────────────────────── */

export function createMockDriverRunService(): DriverRunService {
  // Installed here rather than in `main.tsx` so the mock service and the mock
  // transport cannot be wired up separately by mistake.
  setOutboxTransport(mockTransport);

  return {
    async runSheet() {
      await latency(260, 140);
      return { ...driverStore.day, stops: [...driverStore.day.stops] };
    },

    async job(jobId) {
      await latency(200, 120);
      const job = findJob(jobId);
      if (!job) throw new Error(`No job ${jobId}`);
      return { ...job };
    },

    async updateStatus(jobId, input) {
      await enqueue({
        method: 'POST',
        path: `/api/v1/driver/jobs/${jobId}/status`,
        body: input,
      });

      updateJob(jobId, (job) => ({
        ...job,
        status: input.transition,
        // M4.2 — `arrived` starts the on-site clock that the Extra Load Time
        // charge is computed from (M6.7), so the timestamp is the driver's,
        // not the server's.
        arrivedAt: input.transition === 'arrived' ? input.occurredAt : job.arrivedAt,
        hasQueuedActions: true,
      }));
    },

    async complete(jobId, input) {
      await enqueue({
        method: 'POST',
        path: `/api/v1/driver/jobs/${jobId}/complete`,
        body: input,
      });

      updateJob(jobId, (job) => ({
        ...job,
        status: 'completed',
        completedAt: input.occurredAt,
        notes: input.note ? `${job.notes}\n${input.note}`.trim() : job.notes,
        hasQueuedActions: true,
      }));
    },

    async captureWeights(jobId, input) {
      await enqueue({
        method: 'POST',
        path: `/api/v1/driver/jobs/${jobId}/weights`,
        body: input,
      });

      updateJob(jobId, (job) => ({
        ...job,
        // The m² are NOT touched here. They were set in the office from the
        // builder's order before the run and the driver never sees a field for
        // them — 55:32, "that will be entered in the admin side before the job".
        bagCount: input.bagCount,
        loadType: input.loadType,
        // Null, never zero, on a hand load: there is no bag to lift, so no
        // measurement exists — and a zero would enter the reconciliation as
        // "we collected nothing" and skew every imputed weight on the run.
        craneScaleKg: input.loadType === 'bagged' ? input.craneScaleKg : null,
        weightsRecordedAt: input.occurredAt,
        hasQueuedActions: true,
      }));
    },

    async addPhoto(jobId, input) {
      // The bytes belong to the resumable upload queue (§6A.10 #9 — direct to
      // S3), which is why this resolves before the file has left the phone.
      const photoId = crypto.randomUUID();
      await enqueue({
        method: 'POST',
        path: `/api/v1/driver/jobs/${jobId}/photos`,
        body: { photoId, slot: input.slot, caption: input.caption },
      });

      const position = await currentPosition();
      const photo: DriverPhoto = {
        id: photoId,
        slot: input.slot,
        caption: input.caption,
        takenAt: new Date().toISOString(),
        latitude: position?.latitude ?? null,
        longitude: position?.longitude ?? null,
        uploaded: false,
      };

      updateJob(jobId, (job) => ({
        ...job,
        photos: [...job.photos, photo],
        photoCount: job.photos.length + 1,
        hasQueuedActions: true,
      }));

      return photo;
    },

    async removePhoto(jobId, photoId) {
      await enqueue({
        method: 'DELETE',
        path: `/api/v1/driver/jobs/${jobId}/photos/${photoId}`,
      });

      updateJob(jobId, (job) => ({
        ...job,
        photos: job.photos.filter((photo) => photo.id !== photoId),
        photoCount: job.photos.filter((photo) => photo.id !== photoId).length,
        hasQueuedActions: true,
      }));
    },

    async markFutile(jobId, input) {
      await enqueue({
        method: 'POST',
        path: `/api/v1/driver/jobs/${jobId}/futile`,
        body: input,
      });

      updateJob(jobId, (job) => ({
        ...job,
        status: 'futile',
        hasQueuedActions: true,
      }));
    },

    async markContaminated(jobId, input) {
      await enqueue({
        method: 'POST',
        path: `/api/v1/driver/jobs/${jobId}/contamination`,
        body: input,
      });

      updateJob(jobId, (job) => ({ ...job, hasQueuedActions: true }));
    },

    async submitPreStart(input) {
      await enqueue({ method: 'POST', path: '/api/v1/driver/pre-start', body: input });
      updateDay((day) => ({ ...day, preStartCompletedAt: input.occurredAt }));
    },

    async submitRiskAssessment(input) {
      await enqueue({
        method: 'POST',
        path: `/api/v1/driver/jobs/${input.jobId}/risk-assessment`,
        body: input,
      });

      updateJob(input.jobId, (job) => ({
        ...job,
        riskAssessmentDoneAt: input.occurredAt,
        /*
         * The PDF is stamped here so the driver has something to hand off with.
         *
         * Matt, 1:03:25: *"once it generates the PDF, just attaches it to that
         * job and gives the driver a copy he can upload onto the builder's
         * site."* Real generation is server-side — page 1 the assessment, page 2
         * the versioned SWMS — so what is modelled is the *record* of it, not
         * the bytes. The document appears immediately and offline, because a
         * driver standing at a fence with no signal still needs to know the copy
         * is coming and that they are not expected to wait for it.
         */
        riskAssessment: {
          completedAt: input.occurredAt,
          safeToProceed: input.safeToProceed,
          uploadState: 'queued' as const,
          document: {
            documentId: crypto.randomUUID(),
            fileName: `SRA-${String(job.jobNumber)}-${input.occurredAt.slice(0, 10)}.pdf`,
            generatedAt: input.occurredAt,
            pageCount: 2,
            sizeBytes: 148_000 + Math.round(Math.random() * 40_000),
          },
        },
        hasQueuedActions: true,
      }));
    },

    async previewTipOff(runId, totalKg) {
      await latency(280, 140);
      return reconcile(runId, totalKg);
    },

    async recordTipOff(input) {
      await enqueue({ method: 'POST', path: '/api/v1/driver/tip-off', body: input });
      // Recorded against the run the docket belongs to, not against the day.
      updateDay((day) => ({
        ...day,
        runs: day.runs.map((run) =>
          run.runId === input.runId
            ? { ...run, tipOffRecordedAt: input.occurredAt, tipOffKg: input.totalKg }
            : run,
        ),
      }));
    },

    async reportDefect(input) {
      await enqueue({ method: 'POST', path: '/api/v1/driver/defects', body: input });
    },

    async sendMessage(jobId, body) {
      await enqueue({
        method: 'POST',
        path: `/api/v1/driver/jobs/${jobId}/messages`,
        body: { body, visibility: 'driver' },
      });

      updateJob(jobId, (job) => ({
        ...job,
        messages: [
          ...job.messages,
          {
            id: crypto.randomUUID(),
            body,
            author: DEMO_DRIVER?.name ?? 'Driver',
            at: new Date().toISOString(),
            fromDriver: true,
          },
        ],
        hasQueuedActions: true,
      }));
    },
  };
}

/**
 * Never wait longer than this for a fix.
 *
 * 2.5 seconds is a compromise, not a round number: outdoors a warm GPS returns
 * in well under a second, so this almost never fires in practice — but it is
 * short enough that a driver whose phone cannot get a fix does not stand there
 * wondering whether the tap registered. See the note below for why the browser's
 * own timeout cannot be relied on for this.
 */
const POSITION_TIMEOUT_MS = 2_500;

/**
 * A position fix, or null.
 *
 * ── This must never block, and the browser's own timeout is not enough ─────
 * M4.2 wants a position on every status change, but "wants" is not "requires":
 * losing the *action* because the GPS was slow is far worse than losing the
 * coordinates. A driver in a basement car park, or one who denied location, still
 * has to be able to mark a job complete.
 *
 * ⚠️ The `timeout` option covers *acquiring* a fix — it does NOT cover the
 * permission prompt. Where permission has never been granted or the prompt is
 * sitting behind the app, neither callback fires and the promise never settles.
 * That is not theoretical: it made every driver action hang silently with no
 * error, no toast and no navigation, which is the worst possible failure on the
 * button that finishes a job.
 *
 * So the race below is the actual guarantee. `Promise.race` against a timer means
 * this settles within `POSITION_TIMEOUT_MS` no matter what the geolocation
 * implementation does.
 */
export function currentPosition(): Promise<{
  latitude: number;
  longitude: number;
  accuracyMetres: number | null;
} | null> {
  if (!('geolocation' in navigator)) return Promise.resolve(null);

  const fix = new Promise<{
    latitude: number;
    longitude: number;
    accuracyMetres: number | null;
  } | null>((resolve) => {
    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            latitude: Number(position.coords.latitude.toFixed(6)),
            longitude: Number(position.coords.longitude.toFixed(6)),
            accuracyMetres:
              position.coords.accuracy === null ? null : Math.round(position.coords.accuracy),
          });
        },
        () => {
          resolve(null);
        },
        { enableHighAccuracy: true, timeout: POSITION_TIMEOUT_MS, maximumAge: 30_000 },
      );
    } catch {
      // Some embedded browsers throw synchronously on a blocked API.
      resolve(null);
    }
  });

  const giveUp = new Promise<null>((resolve) => {
    window.setTimeout(() => {
      resolve(null);
    }, POSITION_TIMEOUT_MS);
  });

  return Promise.race([fix, giveUp]);
}

/** Exposed so a screen can show what the run currently adds up to. */
export function previewReconciliation(runId: string, totalKg: number): TipOffReconciliation {
  return reconcile(runId, totalKg);
}

/** Exposed for the run-sheet screen's "next stop" logic. */
export function jobsSnapshot(): readonly DriverJob[] {
  return driverStore.jobs;
}
