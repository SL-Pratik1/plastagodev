import {
  normaliseMobile,
  type DriverJob,
  type DriverPhoto,
  type OtpChallenge,
  type Session,
  type TipOffReconciliation,
} from '@plastago/shared';
import { setOutboxTransport, type OutboxRequest } from '@/offline/transport';
import { enqueue } from '@/offline/outbox';
import { DEMO_DRIVER, DEMO_OTP_CODE, RUN_DATE } from './fixtures';
import { driverStore, findJob, updateDay, updateJob } from './store';
import type { DriverServices } from '../types';

/**
 * The mock implementation of the driver app's services.
 *
 * ── Every write goes through the outbox, exactly as it will in production ──
 * `enqueue()` first, local state second. That ordering is the whole point of
 * M4.12: the durable record of "the driver did this" exists before the optimistic
 * UI does, so a phone killed mid-action loses the pixels and keeps the fact.
 *
 * It also means the queue is genuinely exercised in the demo — the badge counts
 * real operations, the retry backoff is the real backoff, and turning on the
 * offline switch fills a real queue. The only thing standing in for the server is
 * `mockTransport` below.
 *
 * ── What the mock transport does NOT do ───────────────────────────────────
 * It does not re-apply the operation. The local state was already updated when
 * the action was taken, because that is what the driver has to see offline.
 * Applying it again on drain would be modelling a server round trip that the
 * offline design specifically avoids.
 */

const SESSION_KEY = 'plastago.driver.session';
const CHALLENGE_KEY = 'plastago.driver.challenge';

function readStored<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A locked-down browser degrades to "signed out on refresh". Survivable.
  }
}

function clearStored(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // As above.
  }
}

const latency = (base = 220, jitter = 120) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, base + Math.random() * jitter);
  });

/* ── The stand-in for the server ──────────────────────────────────────────── */

/**
 * Accepts a queued operation, slowly and occasionally badly.
 *
 * The 1-in-12 failure is deliberate: the failure path — a red "not sent" badge, a
 * retry with backoff, a driver who can still work — is the part of M4.12 that
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
 * Matt's algorithm, verbatim:
 *
 * ```
 *   tip_off_total_kg                     weighbridge, per run
 * − Σ crane_scale_weight (bagged jobs)   actually measured
 * = remainder_kg
 * ÷ count(hand-load jobs on that run)
 * = imputed_weight_kg per hand-load job
 * ```
 *
 * His worked example: 5 jobs, 3 bagged @ 200 kg, tip-off 846 kg →
 * `846 − 600 = 246 ÷ 2 = 123 kg each`.
 *
 * ⚠️ Computed here as the stand-in for the server, and it must stay there. This
 * number IS the tonnes-diverted figure on a diversion certificate (M9.5 · F52),
 * it goes into builders' Green Star submissions and EPA RRO14 records, and the
 * Flutter app must produce the same answer. A second implementation on a phone
 * would be a second thing to keep correct.
 */
function reconcile(totalKg: number): TipOffReconciliation {
  const collected = driverStore.jobs.filter(
    (job) => job.status === 'completed' || job.status === 'admin-complete',
  );

  const bagged = collected.filter((job) => job.loadType === 'bagged');
  const handLoad = collected.filter((job) => job.loadType === 'hand-load');

  const measuredKg = bagged.reduce((sum, job) => sum + (job.craneScaleKg ?? 0), 0);
  const remainderKg = Math.round((totalKg - measuredKg) * 10) / 10;
  const imputed =
    handLoad.length === 0 ? null : Math.round((remainderKg / handLoad.length) * 10) / 10;

  /*
   * A negative remainder means the crane weights already exceed the weighbridge
   * total, which is physically impossible — almost always a mistyped kilogram
   * figure. Flagged rather than committed, because the driver is standing at the
   * weighbridge and can still fix it; a bad number here corrupts a certificate
   * that ends up in a Green Star submission.
   */
  const looksWrong = remainderKg < 0 || (imputed !== null && imputed > 2000);

  return {
    date: RUN_DATE,
    totalKg,
    measuredKg,
    remainderKg,
    handLoadJobCount: handLoad.length,
    imputedKgPerHandLoadJob: imputed,
    looksWrong,
    warning:
      remainderKg < 0
        ? 'The weights you entered on bagged jobs already add up to more than this tip-off figure. Check the docket and the crane readings before saving.'
        : imputed !== null && imputed > 2000
          ? 'That works out to more than two tonnes per hand-load job, which is unusually high. Worth a second look.'
          : handLoad.length === 0 && remainderKg > 50
            ? 'Every job on this run was weighed, so this remainder has nowhere to go. It will be recorded against the run rather than a job.'
            : null,
    lines: collected.map((job) => ({
      jobId: job.jobId,
      jobNumber: job.jobNumber,
      siteName: job.siteName,
      loadType: job.loadType,
      measuredKg: job.loadType === 'bagged' ? job.craneScaleKg : null,
      imputedKg: job.loadType === 'hand-load' ? imputed : null,
    })),
  };
}

/* ── Services ─────────────────────────────────────────────────────────────── */

export function createMockDriverServices(): DriverServices {
  // Installed here rather than in `main.tsx` so the mock services and the mock
  // transport cannot be wired up separately by mistake.
  setOutboxTransport(mockTransport);

  return {
    auth: {
      async getSession() {
        await latency(120, 60);
        const stored = readStored<Session>(SESSION_KEY);
        if (!stored) return null;
        if (new Date(stored.expiresAt).getTime() < Date.now()) {
          clearStored(SESSION_KEY);
          return null;
        }
        return stored;
      },

      async requestCode(input) {
        await latency(520, 240);
        const mobile = normaliseMobile(input.identifier);

        // One demo driver. An unknown number gets the real failure path rather
        // than being silently accepted — that is the message drivers will see.
        if (mobile !== DEMO_DRIVER.mobile) {
          throw new Error('UNKNOWN_MOBILE');
        }

        const challenge: OtpChallenge = {
          challengeId: crypto.randomUUID(),
          channel: 'sms',
          sentTo: `•••• ••• ${mobile.slice(-3)}`,
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          resendAvailableAt: new Date(Date.now() + 30_000).toISOString(),
          attemptsRemaining: 5,
        };
        writeStored(CHALLENGE_KEY, challenge);
        return challenge;
      },

      async resendCode(challengeId) {
        await latency(420, 200);
        const existing = readStored<OtpChallenge>(CHALLENGE_KEY);
        if (!existing || existing.challengeId !== challengeId) throw new Error('CHALLENGE_LOST');
        const refreshed: OtpChallenge = {
          ...existing,
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          resendAvailableAt: new Date(Date.now() + 30_000).toISOString(),
        };
        writeStored(CHALLENGE_KEY, refreshed);
        return refreshed;
      },

      async verifyCode(input) {
        await latency(620, 260);
        const challenge = readStored<OtpChallenge>(CHALLENGE_KEY);
        if (!challenge || challenge.challengeId !== input.challengeId) {
          throw new Error('CHALLENGE_LOST');
        }
        if (new Date(challenge.expiresAt).getTime() < Date.now()) throw new Error('CODE_EXPIRED');
        if (input.code !== DEMO_OTP_CODE) throw new Error('CODE_INCORRECT');

        const session: Session = {
          user: { ...DEMO_DRIVER, brandIds: [...DEMO_DRIVER.brandIds], lastSignedInAt: null },
          issuedAt: new Date().toISOString(),
          // A driver's shift is long and a re-auth on a building site is the
          // worst possible interruption, so the session outlasts the day.
          expiresAt: new Date(Date.now() + 14 * 3600_000).toISOString(),
        };
        writeStored(SESSION_KEY, session);
        clearStored(CHALLENGE_KEY);
        return session;
      },

      async signOut() {
        await latency(180, 80);
        clearStored(SESSION_KEY);
        clearStored(CHALLENGE_KEY);
      },
    },

    run: {
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
          capturedAreaM2: input.areaM2,
          bagCount: input.bagCount,
          loadType: input.loadType,
          // Null, never zero, on a hand load: there is no bag to lift, so no
          // measurement exists — and a zero would enter the reconciliation as
          // "we collected nothing" and skew every imputed weight on the run.
          craneScaleKg: input.loadType === 'bagged' ? input.craneScaleKg : null,
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
          hasQueuedActions: true,
        }));
      },

      async previewTipOff(_date, totalKg) {
        await latency(280, 140);
        return reconcile(totalKg);
      },

      async recordTipOff(input) {
        await enqueue({ method: 'POST', path: '/api/v1/driver/tip-off', body: input });
        updateDay((day) => ({ ...day, tipOffRecordedAt: input.occurredAt }));
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
              author: DEMO_DRIVER.name,
              at: new Date().toISOString(),
              fromDriver: true,
            },
          ],
          hasQueuedActions: true,
        }));
      },
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
export function previewReconciliation(totalKg: number): TipOffReconciliation {
  return reconcile(totalKg);
}

/** Exposed for the run-sheet screen's "next stop" logic. */
export function jobsSnapshot(): readonly DriverJob[] {
  return driverStore.jobs;
}
