import type { ApiClient } from '@plastago/api-client';
import {
  API_PREFIX,
  DriverJobSchema,
  OtpChallengeSchema,
  RunSheetDaySchema,
  SessionSchema,
  TipOffReconciliationSchema,
  type Completion,
  type ContaminationReport,
  type DefectReport,
  type DriverPhoto,
  type FutileReport,
  type OtpRequest,
  type OtpVerify,
  type PreStartSubmission,
  type SiteRiskAssessment,
  type StatusUpdate,
  type TipOffEntry,
  type WeightCapture,
} from '@plastago/shared';
import * as z from 'zod';
import { enqueue } from '@/offline/outbox';
import type { DriverAuthService, DriverRunService, DriverServices } from '../types';

/**
 * The driver app, over the real API.
 *
 * ── ⚠️ Writes go to the OUTBOX, not to the network ────────────────────────
 * M4.12: everything works with no signal. Every mutation below calls
 * `enqueue()` and resolves as soon as the operation is durably recorded on the
 * phone — NOT when the server has it. `offline/outbox.ts` drains the queue in
 * order, with an idempotency key per operation so a retry after a timeout
 * cannot double-record a job completion.
 *
 * There is deliberately no separate "online path". If there were, the offline
 * case would rot from disuse and only fail in a paddock with no reception,
 * which is the one place nobody can debug it.
 *
 * Nothing here calls `setOutboxTransport` — the outbox already defaults to
 * `httpTransport`, which is the point of that seam. The mock replaced only the
 * send; this file replaces nothing.
 */

/** What `POST /driver/jobs/:id/photos` answers with. */
const PresignPhotoResponseSchema = z.object({
  photoId: z.string(),
  upload: z.object({
    key: z.string(),
    uploadUrl: z.string(),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.string(),
  }),
});

function createHttpDriverAuthService(api: ApiClient): DriverAuthService {
  const base = `${API_PREFIX}/auth`;

  return {
    getSession: () =>
      api.request(`${base}/session`, {
        // `null` is a valid 200 body — "nobody is signed in" is not an error.
        schema: SessionSchema.nullable(),
      }),

    requestCode: (input: OtpRequest) =>
      api.request(`${base}/otp/request`, {
        method: 'POST',
        body: input,
        schema: OtpChallengeSchema,
      }),

    resendCode: (challengeId: string) =>
      api.request(`${base}/otp/resend`, {
        method: 'POST',
        body: { challengeId },
        schema: OtpChallengeSchema,
      }),

    verifyCode: (input: OtpVerify) =>
      api.request(`${base}/otp/verify`, {
        method: 'POST',
        body: input,
        schema: SessionSchema,
      }),

    signOut: async () => {
      await api.request(`${base}/sign-out`, { method: 'POST', schema: z.null() });
    },
  };
}

function createHttpDriverRunService(api: ApiClient): DriverRunService {
  const base = `${API_PREFIX}/driver`;

  /** Every queued write, in one place. */
  const queue = async (path: string, body?: unknown): Promise<void> => {
    await enqueue({ method: 'POST', path: `${base}${path}`, body });
  };

  return {
    /* ── Reads ────────────────────────────────────────────────────────────── */

    runSheet: (date: string) =>
      api.request(`${base}/run-sheet`, { searchParams: { date }, schema: RunSheetDaySchema }),

    job: (jobId: string) => api.request(`${base}/jobs/${jobId}`, { schema: DriverJobSchema }),

    /*
     * A read, so it is direct rather than queued: the driver is standing at the
     * weighbridge looking at the deduct-and-average result before committing it,
     * and a wildly wrong imputed figure almost always means a mistyped crane
     * weight they can still correct.
     */
    previewTipOff: (runId: string, totalKg: number) =>
      api.request(`${base}/runs/${runId}/tip-off/preview`, {
        method: 'POST',
        body: { totalKg },
        schema: TipOffReconciliationSchema,
      }),

    /* ── M4.2 · status ────────────────────────────────────────────────────── */

    updateStatus: (jobId: string, input: StatusUpdate) => queue(`/jobs/${jobId}/status`, input),

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
     * upload queue" this interface's own comment refers to. That queue is not
     * built, so this fails loudly rather than pretending: a photo that silently
     * vanishes is worse than one the driver is told to retake, because the
     * five-shot protocol is what settles a contamination dispute.
     */
    addPhoto: async (jobId, input): Promise<DriverPhoto> => {
      const takenAt = new Date().toISOString();

      const result = await api.request(`${base}/jobs/${jobId}/photos`, {
        method: 'POST',
        body: {
          caption: input.caption,
          slot: input.slot,
          contentType: input.blob.type || 'image/jpeg',
          contentLength: input.blob.size,
          takenAt,
          position: null,
        },
        schema: PresignPhotoResponseSchema,
      });

      // Direct to storage — this request does NOT go through the api client,
      // because it is not going to the API.
      const stored = await fetch(result.upload.uploadUrl, {
        method: 'PUT',
        headers: result.upload.headers,
        body: input.blob,
      }).catch(() => null);

      if (!stored?.ok) throw new Error('The photo could not be uploaded — try again');

      return {
        id: result.photoId,
        slot: input.slot,
        caption: input.caption,
        takenAt,
        latitude: null,
        longitude: null,
        // True, unlike the queued writes: the bytes are in S3 by the time this
        // resolves, so a "pending" badge would be permanently wrong.
        uploaded: true,
      };
    },

    removePhoto: async (jobId: string, photoId: string) => {
      await enqueue({ method: 'DELETE', path: `${base}/jobs/${jobId}/photos/${photoId}` });
    },

    /* ── M4.6, M4.7 · the exception branches that carry charges ───────────── */

    markFutile: (jobId: string, input: FutileReport) => queue(`/jobs/${jobId}/futile`, input),

    markContaminated: (jobId: string, input: ContaminationReport) =>
      queue(`/jobs/${jobId}/contamination`, input),

    /* ── M4.8 · pre-start and site risk ───────────────────────────────────── */

    // Not nested under a job: a pre-start is about the TRUCK and the day, and a
    // risk assessment carries its own job id in the body.
    submitPreStart: (input: PreStartSubmission) => queue('/pre-start', input),

    submitRiskAssessment: (input: SiteRiskAssessment) => queue('/risk-assessment', input),

    /* ── M4.4 · tip-off ───────────────────────────────────────────────────── */

    recordTipOff: (input: TipOffEntry) => queue('/tip-off', input),

    /* ── M4.9 · vehicle defects ───────────────────────────────────────────── */

    // Keyed by REGO in the body — the driver reports the truck they are in,
    // which is not necessarily the one on their roster row.
    reportDefect: (input: DefectReport) => queue('/defects', input),

    /* ── M8.6 · W102 · the office ↔ driver thread ─────────────────────────── */

    sendMessage: (jobId: string, body: string) => queue(`/jobs/${jobId}/messages`, { body }),
  };
}

export function createHttpDriverServices(api: ApiClient): DriverServices {
  return {
    auth: createHttpDriverAuthService(api),
    run: createHttpDriverRunService(api),
  };
}
