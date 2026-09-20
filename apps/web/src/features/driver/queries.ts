import type {
  Completion,
  ContaminationReport,
  DefectReport,
  DriverJob,
  FutileReport,
  GeoFix,
  PreStartSubmission,
  RunSheetDay,
  SiteRiskAssessment,
  StatusUpdate,
  TipOffEntry,
  WeightCapture,
} from '@plastago/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useServices } from '@/services/services-context';

/**
 * The driver app's data hooks.
 *
 * ── Mutations are "queued", not "saved" ───────────────────────────────────
 * Every write below resolves once the action is in the outbox, which is what
 * lets a driver work through a run in a dead zone. So the toast wording on each
 * screen says *queued* or *saved on this phone* rather than implying the office
 * has it — the sync badge is the only honest answer to that question.
 *
 * ── Why local reads are invalidated rather than optimistically patched ────
 * The services already write the optimistic local state; invalidating just
 * re-reads it. One source of truth for what the screen shows, and no second copy
 * of the update logic living in a hook.
 */
/**
 * Query options every driver read shares.
 *
 * ── Why these are per-query and not on the QueryClient ───────────────────
 * The client in `app/providers.tsx` is tuned for the office: a 30-second stale
 * time and TanStack's default `networkMode: 'online'`, which PAUSES a query
 * whenever the browser reports itself offline. On a desk that is correct — a
 * paused query beats a spinner over a dead link.
 *
 * On a phone in a greenfield estate it is the exact opposite of what M4.12
 * requires. A paused query never calls the service, so the local read never
 * happens and the driver gets a permanent loading state instead of their run
 * sheet. `offlineFirst` runs the query regardless and lets the service answer
 * from local state.
 *
 * Set here rather than by widening the shared client, because the office
 * defaults are right for the office and one surface's needs should not
 * quietly re-tune the other two.
 */
const DRIVER_QUERY_OPTIONS = {
  networkMode: 'offlineFirst',
  // Longer than the office: a driver on a weak cell should reuse what is
  // already on screen rather than spin on a refetch.
  staleTime: 60_000,
  // A full shift. The cache IS the offline read path once the app is
  // backgrounded and brought back at the next stop.
  gcTime: 24 * 60 * 60 * 1_000,
} as const;

export const runKeys = {
  all: ['run'] as const,
  sheet: (date: string) => ['run', 'sheet', date] as const,
  job: (jobId: string) => ['run', 'job', jobId] as const,
  tipOffPreview: (runId: string, totalKg: number) => ['run', 'tip-off', runId, totalKg] as const,
};

export function useRunSheet(date: string) {
  const { driverRun: run } = useServices();
  return useQuery({
    queryKey: runKeys.sheet(date),
    queryFn: () => run.runSheet(date),
    ...DRIVER_QUERY_OPTIONS,
  });
}

export function useDriverJob(jobId: string | undefined) {
  const { driverRun: run } = useServices();
  return useQuery({
    queryKey: runKeys.job(jobId ?? 'none'),
    queryFn: () => run.job(jobId ?? ''),
    enabled: Boolean(jobId),
    ...DRIVER_QUERY_OPTIONS,
  });
}

/**
 * Anything that touches a job re-reads the job AND the run sheet.
 *
 * Both, always: the run sheet row and the job screen are two views of one
 * record, and a driver who marks a job complete then goes back to a list still
 * saying "assigned" has no way to tell whether the tap registered.
 */
function useRunMutation<TInput>(mutationFn: (input: TInput) => Promise<void>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: runKeys.all });
    },
  });
}

export function useUpdateStatus() {
  const { driverRun: run } = useServices();
  return useRunMutation(({ jobId, input }: { jobId: string; input: StatusUpdate }) =>
    run.updateStatus(jobId, input),
  );
}

export function useCompleteJob() {
  const { driverRun: run } = useServices();
  return useRunMutation(({ jobId, input }: { jobId: string; input: Completion }) =>
    run.complete(jobId, input),
  );
}

export function useCaptureWeights() {
  const { driverRun: run } = useServices();
  return useRunMutation(({ jobId, input }: { jobId: string; input: WeightCapture }) =>
    run.captureWeights(jobId, input),
  );
}

export function useAddPhoto() {
  const { driverRun: run } = useServices();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      jobId,
      slot,
      caption,
      blob,
      position,
    }: {
      jobId: string;
      slot: string | null;
      caption: string;
      blob: Blob;
      position: GeoFix | null;
    }) => run.addPhoto(jobId, { slot, caption, blob, position }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: runKeys.all });
    },
  });
}

/**
 * M4.5 — dropping a photo the driver does not want kept.
 *
 * ── Why this patches the cache instead of invalidating ────────────────────
 * Same reason as `useSubmitPreStart`: the delete is QUEUED, so this resolves
 * while the server still has the photo. Invalidating here asks the API a
 * question it has not been told the answer to, gets "the photo is still there",
 * and caches that as fresh — the driver taps the X, the thumbnail disappears
 * for an instant and then pops back, which reads as the app refusing to delete
 * it. Reloading did not help either, because the stale answer was cached.
 *
 * So the photo is dropped locally and `onOutboxSynced` in the driver shell
 * re-reads once the DELETE has actually landed.
 */
export function useRemovePhoto() {
  const { driverRun: run } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ jobId, photoId }: { jobId: string; photoId: string }) =>
      run.removePhoto(jobId, photoId),
    onSuccess: (_result, { jobId, photoId }) => {
      queryClient.setQueryData(runKeys.job(jobId), (current: DriverJob | undefined) =>
        current
          ? { ...current, photos: current.photos.filter((photo) => photo.id !== photoId) }
          : current,
      );
    },
  });
}

export function useMarkFutile() {
  const { driverRun: run } = useServices();
  return useRunMutation(({ jobId, input }: { jobId: string; input: FutileReport }) =>
    run.markFutile(jobId, input),
  );
}

export function useMarkContaminated() {
  const { driverRun: run } = useServices();
  return useRunMutation(({ jobId, input }: { jobId: string; input: ContaminationReport }) =>
    run.markContaminated(jobId, input),
  );
}

/**
 * M4.8a — the pre-start, and the one write that patches the cache itself.
 *
 * ── Why this does not use `useRunMutation` ────────────────────────────────
 * Because invalidating here is actively wrong. The mutation resolves when the
 * submission is durably on the PHONE, several awaits before the request leaves
 * it, so a refetch at this moment asks the server a question it has not been
 * told the answer to and gets back `preStartCompletedAt: null` — the driver taps
 * "Finish pre-start" and the run sheet still says the check is not done.
 *
 * Worse, that null is then cached as fresh for the full `staleTime`, so going
 * back to the run sheet does not fix it either. Only a reload did.
 *
 * So: write what we know locally, and let `onOutboxSynced` in the driver shell
 * re-read once the server actually has it. `occurredAt` rather than `now`,
 * because that is the timestamp the record will carry — the screen should not
 * show one time before the sync and a different one after it.
 */
export function useSubmitPreStart() {
  const { driverRun: run } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: PreStartSubmission) => run.submitPreStart(input),
    onSuccess: (_result, input) => {
      queryClient.setQueryData(runKeys.sheet(input.date), (current: RunSheetDay | undefined) =>
        current ? { ...current, preStartCompletedAt: input.occurredAt } : current,
      );
    },
  });
}

export function useSubmitRiskAssessment() {
  const { driverRun: run } = useServices();
  return useRunMutation((input: SiteRiskAssessment) => run.submitRiskAssessment(input));
}

/**
 * M4.4 — the reconciliation preview.
 *
 * `enabled` holds it back until there is a figure to reconcile, and `retry:
 * false` because this is arithmetic over local data: a failure is a bug, not a
 * network blip, and retrying would hide it.
 */
export function useTipOffPreview(runId: string | null, totalKg: number, enabled: boolean) {
  const { driverRun: run } = useServices();
  return useQuery({
    queryKey: runKeys.tipOffPreview(runId ?? 'none', totalKg),
    queryFn: () => run.previewTipOff(runId ?? '', totalKg),
    enabled: enabled && totalKg > 0 && runId !== null,
    ...DRIVER_QUERY_OPTIONS,
    // Overrides the shared block: this is arithmetic over local data, so a
    // failure is a bug rather than a network blip and retrying would hide it.
    retry: false,
  });
}

/**
 * The weighbridge docket photo.
 *
 * Not a `useRunMutation`: it uploads bytes and resolves to the storage key the
 * tip-off then carries, so there is nothing to invalidate until the tip-off
 * itself is recorded.
 */
export function useUploadDocketPhoto() {
  const { driverRun: run } = useServices();
  return useMutation({
    mutationFn: ({ runId, blob }: { runId: string; blob: Blob }) =>
      run.uploadDocketPhoto(runId, blob),
  });
}

export function useRecordTipOff() {
  const { driverRun: run } = useServices();
  return useRunMutation((input: TipOffEntry) => run.recordTipOff(input));
}

/**
 * M4.9 — the defect photo, uploaded for real.
 *
 * Not a `useRunMutation`: like the docket, it uploads bytes and resolves to the
 * storage key the defect report then carries, so there is nothing to invalidate
 * until the report itself is sent.
 */
export function useUploadDefectPhoto() {
  const { driverRun: run } = useServices();
  return useMutation({
    mutationFn: (blob: Blob) => run.uploadDefectPhoto(blob),
  });
}

export function useReportDefect() {
  const { driverRun: run } = useServices();
  return useRunMutation((input: DefectReport) => run.reportDefect(input));
}

export function useSendDriverMessage() {
  const { driverRun: run } = useServices();
  return useRunMutation(({ jobId, body }: { jobId: string; body: string }) =>
    run.sendMessage(jobId, body),
  );
}
