import type { DriverJob, RunSheetDay } from '@plastago/shared';
import { buildRunSheet, toStop } from './fixtures/driver-run';

/**
 * The driver's local state, standing in for the on-device database.
 *
 * ── Why this is a plain module and not Dexie ───────────────────────────────
 * Dexie is already in the app for the outbox and the upload queue, and those are
 * the parts that genuinely need durability — a queued job completion must
 * survive the phone being killed. The *read* cache does not: on a real device it
 * is repopulated by sync, and in a demo a reload restoring the fixtures is the
 * right behaviour, because any experiment is then one refresh from undone.
 *
 * So: writes go through the outbox (durable, visible, replayable) and land here
 * as the optimistic local state that the screens render.
 */
const initial = buildRunSheet();

export const driverStore = {
  day: { ...initial.day },
  jobs: initial.jobs.map((job) => ({ ...job })) as DriverJob[],
};

export function findJob(jobId: string): DriverJob | undefined {
  return driverStore.jobs.find((job) => job.jobId === jobId);
}

/**
 * Applies a change to one job and re-derives the run sheet row from it.
 *
 * Both in one place on purpose: the run sheet and the job detail are two views of
 * the same record, and a driver who marks a job complete and then sees the list
 * still say "assigned" stops trusting the whole app — which, offline, is the only
 * thing they have.
 */
export function updateJob(jobId: string, change: (job: DriverJob) => DriverJob): DriverJob {
  const index = driverStore.jobs.findIndex((job) => job.jobId === jobId);
  const current = driverStore.jobs[index];
  if (index === -1 || !current) throw new Error(`No job ${jobId}`);

  const updated = change(current);
  driverStore.jobs[index] = updated;
  driverStore.day = {
    ...driverStore.day,
    stops: driverStore.jobs.map(toStop),
  };
  return updated;
}

export function updateDay(change: (day: RunSheetDay) => RunSheetDay): void {
  driverStore.day = change(driverStore.day);
}
