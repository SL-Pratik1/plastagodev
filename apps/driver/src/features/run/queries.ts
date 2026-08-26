import type {
  Completion,
  ContaminationReport,
  DefectReport,
  FutileReport,
  PreStartSubmission,
  SiteRiskAssessment,
  StatusUpdate,
  TipOffEntry,
  WeightCapture,
} from '@plastago/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useServices } from '@/services/services-context-value';

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
export const runKeys = {
  all: ['run'] as const,
  sheet: (date: string) => ['run', 'sheet', date] as const,
  job: (jobId: string) => ['run', 'job', jobId] as const,
  tipOffPreview: (date: string, totalKg: number) => ['run', 'tip-off', date, totalKg] as const,
};

export function useRunSheet(date: string) {
  const { run } = useServices();
  return useQuery({
    queryKey: runKeys.sheet(date),
    queryFn: () => run.runSheet(date),
  });
}

export function useDriverJob(jobId: string | undefined) {
  const { run } = useServices();
  return useQuery({
    queryKey: runKeys.job(jobId ?? 'none'),
    queryFn: () => run.job(jobId ?? ''),
    enabled: Boolean(jobId),
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
  const { run } = useServices();
  return useRunMutation(({ jobId, input }: { jobId: string; input: StatusUpdate }) =>
    run.updateStatus(jobId, input),
  );
}

export function useCompleteJob() {
  const { run } = useServices();
  return useRunMutation(({ jobId, input }: { jobId: string; input: Completion }) =>
    run.complete(jobId, input),
  );
}

export function useCaptureWeights() {
  const { run } = useServices();
  return useRunMutation(({ jobId, input }: { jobId: string; input: WeightCapture }) =>
    run.captureWeights(jobId, input),
  );
}

export function useAddPhoto() {
  const { run } = useServices();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      jobId,
      slot,
      caption,
      blob,
    }: {
      jobId: string;
      slot: string | null;
      caption: string;
      blob: Blob;
    }) => run.addPhoto(jobId, { slot, caption, blob }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: runKeys.all });
    },
  });
}

export function useRemovePhoto() {
  const { run } = useServices();
  return useRunMutation(({ jobId, photoId }: { jobId: string; photoId: string }) =>
    run.removePhoto(jobId, photoId),
  );
}

export function useMarkFutile() {
  const { run } = useServices();
  return useRunMutation(({ jobId, input }: { jobId: string; input: FutileReport }) =>
    run.markFutile(jobId, input),
  );
}

export function useMarkContaminated() {
  const { run } = useServices();
  return useRunMutation(({ jobId, input }: { jobId: string; input: ContaminationReport }) =>
    run.markContaminated(jobId, input),
  );
}

export function useSubmitPreStart() {
  const { run } = useServices();
  return useRunMutation((input: PreStartSubmission) => run.submitPreStart(input));
}

export function useSubmitRiskAssessment() {
  const { run } = useServices();
  return useRunMutation((input: SiteRiskAssessment) => run.submitRiskAssessment(input));
}

/**
 * M4.4 — the reconciliation preview.
 *
 * `enabled` holds it back until there is a figure to reconcile, and `retry:
 * false` because this is arithmetic over local data: a failure is a bug, not a
 * network blip, and retrying would hide it.
 */
export function useTipOffPreview(date: string, totalKg: number, enabled: boolean) {
  const { run } = useServices();
  return useQuery({
    queryKey: runKeys.tipOffPreview(date, totalKg),
    queryFn: () => run.previewTipOff(date, totalKg),
    enabled: enabled && totalKg > 0,
    retry: false,
  });
}

export function useRecordTipOff() {
  const { run } = useServices();
  return useRunMutation((input: TipOffEntry) => run.recordTipOff(input));
}

export function useReportDefect() {
  const { run } = useServices();
  return useRunMutation((input: DefectReport) => run.reportDefect(input));
}

export function useSendDriverMessage() {
  const { run } = useServices();
  return useRunMutation(({ jobId, body }: { jobId: string; body: string }) =>
    run.sendMessage(jobId, body),
  );
}
