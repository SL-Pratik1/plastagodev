import type {
  Completion,
  ContaminationReport,
  DefectReport,
  DriverJob,
  DriverPhoto,
  FutileReport,
  PreStartSubmission,
  RunSheetDay,
  SiteRiskAssessment,
  StatusUpdate,
  TipOffEntry,
  TipOffReconciliation,
  WeightCapture,
} from '@plastago/shared';

/**
 * The driver surface's data seam (M4).
 *
 * ── Why this interface lives apart from the rest of `types.ts` ─────────────
 * Every other service in this app is request/response. This one is not, and the
 * difference is load-bearing rather than stylistic: M4.12 says everything works
 * with no signal, so a **write here resolves as soon as it is queued**, not when
 * the server has it. The return value is the optimistic local state and
 * `offline/outbox.ts` owns getting it to the office later.
 *
 * The consequence to hold on to when writing a driver screen: a successful
 * mutation does NOT mean the office knows. That is what the sync indicator in
 * the driver header is for, and why every write carries an `idempotencyKey` — a
 * retry after a timeout must not double-record a job completion.
 *
 * ⚠️ Keeping it in its own file is deliberate. The Flutter app (§6A.4)
 * implements this same protocol against Drift, so this interface is a shared
 * artefact in a way the office services are not — mixing it into the console's
 * types would bury the one contract two codebases have to agree on.
 */
export interface DriverRunService {
  runSheet: (date: string) => Promise<RunSheetDay>;
  job: (jobId: string) => Promise<DriverJob>;

  // ── M4.2 · status, with timestamp and position on every change ──────────
  updateStatus: (jobId: string, input: StatusUpdate) => Promise<void>;
  /** M4.10 — a plain note on completion. F41's review flow is out of scope. */
  complete: (jobId: string, input: Completion) => Promise<void>;

  // ── M4.3 · m² and kg are two different quantities ───────────────────────
  captureWeights: (jobId: string, input: WeightCapture) => Promise<void>;

  // ── M4.5 · photos, queued locally and uploaded when signal returns ──────
  /**
   * Registers a photo against the job. The bytes go to a separate resumable
   * upload queue (§6A.10 #9 — direct to S3), which is why this takes a blob but
   * resolves before it has left the phone.
   */
  addPhoto: (
    jobId: string,
    input: { slot: string | null; caption: string; blob: Blob },
  ) => Promise<DriverPhoto>;
  removePhoto: (jobId: string, photoId: string) => Promise<void>;

  // ── M4.6, M4.7 · the exception branches that carry charges ──────────────
  markFutile: (jobId: string, input: FutileReport) => Promise<void>;
  markContaminated: (jobId: string, input: ContaminationReport) => Promise<void>;

  // ── M4.8 · pre-start and site risk ─────────────────────────────────────
  submitPreStart: (input: PreStartSubmission) => Promise<void>;
  submitRiskAssessment: (input: SiteRiskAssessment) => Promise<void>;

  // ── M4.4 · tip-off reconciliation ──────────────────────────────────────
  /**
   * The preview, computed from what has been captured on the run so far.
   *
   * A read, not a write, so the driver sees the deduct-and-average result BEFORE
   * committing it — a wildly wrong imputed figure almost always means a mistyped
   * crane weight, and they are still standing at the weighbridge.
   */
  /** Keyed by RUN — a driver tips off twice on a two-run day (Matt, 43:50). */
  previewTipOff: (runId: string, totalKg: number) => Promise<TipOffReconciliation>;
  recordTipOff: (input: TipOffEntry) => Promise<void>;

  // ── M4.9 · vehicle defects ─────────────────────────────────────────────
  reportDefect: (input: DefectReport) => Promise<void>;

  // ── M8.6 · W102 · the office ↔ driver thread ───────────────────────────
  sendMessage: (jobId: string, body: string) => Promise<void>;
}
