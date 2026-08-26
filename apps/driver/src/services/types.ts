import type {
  Completion,
  ContaminationReport,
  DefectReport,
  DriverJob,
  DriverPhoto,
  FutileReport,
  OtpChallenge,
  OtpRequest,
  OtpVerify,
  PreStartSubmission,
  RunSheetDay,
  Session,
  SiteRiskAssessment,
  StatusUpdate,
  TipOffEntry,
  TipOffReconciliation,
  WeightCapture,
} from '@plastago/shared';

/**
 * The driver app's service seam (M4).
 *
 * Same pattern as the web app: screens depend on these interfaces and nothing
 * else, so swapping the mock for HTTP adapters is one line in `main.tsx`.
 *
 * ── One thing is genuinely different here, and it matters ──────────────────
 * The web app's services are request/response. These are not, because M4.12
 * says everything works with no signal. So a **write returns as soon as it is
 * queued**, not when the server has it — the return value is the optimistic
 * local state, and `offline/outbox.ts` owns getting it to the server later.
 *
 * The consequence to keep in mind when writing screens: a successful mutation
 * here does NOT mean the office knows. That is what the sync indicator is for,
 * and why every write is idempotent (`idempotencyKey`) — a retry after a timeout
 * must not double-create a job completion.
 */
export interface DriverAuthService {
  getSession: () => Promise<Session | null>;
  /** §9 A2 — SMS OTP. Drivers are mobile-first; there is no password. */
  requestCode: (input: OtpRequest) => Promise<OtpChallenge>;
  resendCode: (challengeId: string) => Promise<OtpChallenge>;
  verifyCode: (input: OtpVerify) => Promise<Session>;
  signOut: () => Promise<void>;
}

/**
 * Reads. These come from the local database when offline (M4.12), which is why
 * they take a date rather than a cursor — a driver needs *today*, and yesterday
 * for the tip-off they forgot to record.
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
  previewTipOff: (date: string, totalKg: number) => Promise<TipOffReconciliation>;
  recordTipOff: (input: TipOffEntry) => Promise<void>;

  // ── M4.9 · vehicle defects ─────────────────────────────────────────────
  reportDefect: (input: DefectReport) => Promise<void>;

  // ── M8.6 · W102 · the office ↔ driver thread ───────────────────────────
  sendMessage: (jobId: string, body: string) => Promise<void>;
}

export interface DriverServices {
  readonly auth: DriverAuthService;
  readonly run: DriverRunService;
}
