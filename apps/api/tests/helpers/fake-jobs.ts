import type { Job, JobComment, JobListItem, PageMeta } from '@plastago/shared';
import type {
  AppendEventInput,
  CreateCommentInput,
  CreateJobInput,
  JobScope,
  ListJobsQuery,
} from '../../src/domains/jobs/job.repository.js';

/**
 * An in-memory stand-in for the job repository.
 *
 * ── Why a fake and not a mocked Mongo ─────────────────────────────────────
 * The service's job is rules — who sees which jobs, what the office is told when
 * a cancel races a completion, which date the SLA counts from. None of that
 * needs a database, and a test that spins one up measures Mongo's availability
 * rather than the rule under test.
 *
 * It records the SCOPE it was handed as well as what it returned, because the
 * access assertions are about the query the service builds, not the rows that
 * come back. A repository that ignored its scope would still return plausible
 * data.
 */

let counter = 0;

function nextId(): string {
  counter += 1;
  return counter.toString(16).padStart(24, '0');
}

interface SeedJob {
  id?: string;
  status?: Job['status'];
  driverId?: string | null;
  jobNumber?: number;
}

export function createFakeJobRepository() {
  const jobs = new Map<string, { jobNumber: number; status: Job['status']; driverId: string | null }>();

  const calls = {
    lastScope: null as JobScope | null,
    lastQuery: null as ListJobsQuery | null,
    lastCreate: null as CreateJobInput | null,
    events: [] as AppendEventInput[],
    comments: [] as CreateCommentInput[],
    cancels: [] as Array<{ id: string; reason: string; note: string | null }>,
    reschedules: [] as Array<{ id: string; readyDate: string; targetDate: string }>,
  };

  /** Set false to simulate the job moving underneath a cancel. */
  let cancelSucceeds = true;

  const repository = {
    async list(
      query: ListJobsQuery,
      scope: JobScope,
    ): Promise<{ data: JobListItem[]; meta: PageMeta }> {
      calls.lastQuery = query;
      calls.lastScope = scope;
      return Promise.resolve({
        data: [],
        meta: { page: query.page, pageSize: query.pageSize, total: 0, totalPages: 1 },
      });
    },

    async findById(id: string, scope: JobScope): Promise<Job | null> {
      calls.lastScope = scope;
      return Promise.resolve(jobs.has(id) ? ({ id } as unknown as Job) : null);
    },

    async findSummary(id: string, scope: JobScope) {
      calls.lastScope = scope;
      const job = jobs.get(id);
      return Promise.resolve(job ? { id, ...job } : null);
    },

    async create(input: CreateJobInput): Promise<JobListItem> {
      calls.lastCreate = input;
      const id = nextId();
      jobs.set(id, { jobNumber: input.jobNumber, status: 'booked', driverId: null });
      return Promise.resolve({ id, jobNumber: input.jobNumber } as unknown as JobListItem);
    },

    async deleteCascade(id: string): Promise<void> {
      jobs.delete(id);
      return Promise.resolve();
    },

    async appendEvent(input: AppendEventInput): Promise<void> {
      calls.events.push(input);
      return Promise.resolve();
    },

    async cancel(
      id: string,
      reason: string,
      note: string | null,
      _cancellableFrom: readonly string[],
    ): Promise<boolean> {
      calls.cancels.push({ id, reason, note });
      if (!cancelSucceeds) return Promise.resolve(false);

      const job = jobs.get(id);
      if (job) jobs.set(id, { ...job, status: 'cancelled' });
      return Promise.resolve(true);
    },

    async reschedule(id: string, readyDate: string, targetDate: string): Promise<boolean> {
      calls.reschedules.push({ id, readyDate, targetDate });
      return Promise.resolve(jobs.has(id));
    },

    async addComment(input: CreateCommentInput): Promise<JobComment> {
      calls.comments.push(input);
      return Promise.resolve({
        id: nextId(),
        body: input.body,
        author: input.author,
        at: new Date().toISOString(),
        visibility: input.visibility,
        deliveredAt: input.deliveredAt ? input.deliveredAt.toISOString() : null,
        fromDriver: input.fromDriver,
      });
    },

    async builderNames(): Promise<string[]> {
      return Promise.resolve([]);
    },
  };

  return {
    repository,
    calls,

    /** Put a job in the store so the service can find it. */
    seed(options: SeedJob = {}): string {
      const id = options.id ?? nextId();
      jobs.set(id, {
        jobNumber: options.jobNumber ?? 61_300,
        status: options.status ?? 'booked',
        driverId: options.driverId ?? null,
      });
      return id;
    },

    /** Make the guarded cancel match nothing — a completion racing a cancel. */
    failNextCancel(): void {
      cancelSucceeds = false;
    },

    statusOf(id: string): Job['status'] | undefined {
      return jobs.get(id)?.status;
    },
  };
}
