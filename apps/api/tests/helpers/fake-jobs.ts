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

/** The run a seeded job is a stop on. */
interface SeedRun {
  id: string;
  /** `YYYY-MM-DD` — the day the truck goes. */
  date: string;
  name?: string;
  number?: number;
}

interface SeedJob {
  id?: string;
  status?: Job['status'];
  driverId?: string | null;
  jobNumber?: number;
  accountId?: string;
  accountName?: string;
  siteName?: string;
  bookedByUserId?: string | null;
  readyDate?: string;
  targetDate?: string;
  siteContactEmail?: string | null;
  siteContactMobile?: string | null;
  run?: SeedRun | null;
}

interface StoredJob {
  jobNumber: number;
  status: Job['status'];
  driverId: string | null;
  accountId: string;
  accountName: string;
  siteName: string;
  bookedByUserId: string | null;
  readyDate: string;
  targetDate: string;
  siteContactEmail: string | null;
  siteContactMobile: string | null;
  run: SeedRun | null;
}

/** The account a seeded job belongs to unless a test says otherwise. */
export const FAKE_JOB_ACCOUNT_ID = 'acc0000000000000000000a1';

export function createFakeJobRepository() {
  const jobs = new Map<string, StoredJob>();

  const calls = {
    lastScope: null as JobScope | null,
    lastQuery: null as ListJobsQuery | null,
    lastCreate: null as CreateJobInput | null,
    events: [] as AppendEventInput[],
    comments: [] as CreateCommentInput[],
    cancels: [] as Array<{ id: string; reason: string; note: string | null }>,
    reschedules: [] as Array<{ id: string; readyDate: string; targetDate: string }>,
    /** Jobs taken off a run because their date moved past it. */
    releases: [] as Array<{ id: string; runId: string }>,
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
      const job = jobs.get(id);
      if (!job) return Promise.resolve(null);

      // Only what a notice reads — the rest of a `Job` is not this fake's business.
      const { run: _run, ...fields } = job;
      return Promise.resolve({ id, ...fields, photos: [] } as unknown as Job);
    },

    async findSummary(id: string, scope: JobScope) {
      calls.lastScope = scope;
      const job = jobs.get(id);
      return Promise.resolve(job ? { id, ...job } : null);
    },

    async allocationOf(id: string) {
      const job = jobs.get(id);
      if (!job?.run) return Promise.resolve(null);

      return Promise.resolve({
        runId: job.run.id,
        runNumber: job.run.number ?? 1,
        runName: job.run.name ?? 'Run 1',
        runDate: job.run.date,
        driverId: job.driverId,
        status: job.status,
      });
    },

    async releaseFromRun(id: string, runId: string): Promise<boolean> {
      const job = jobs.get(id);
      if (job?.run?.id !== runId) return Promise.resolve(false);

      calls.releases.push({ id, runId });
      jobs.set(id, { ...job, run: null, driverId: null, status: 'booked' });
      return Promise.resolve(true);
    },

    async create(input: CreateJobInput): Promise<JobListItem> {
      calls.lastCreate = input;
      const id = nextId();
      jobs.set(id, {
        jobNumber: input.jobNumber,
        status: 'booked',
        driverId: null,
        accountId: input.accountId,
        accountName: input.accountName,
        siteName: input.siteName,
        bookedByUserId: input.bookedByUserId,
        readyDate: input.readyDate,
        targetDate: input.targetDate,
        // Not carried: the booking-notice suite pins the no-contact path.
        siteContactEmail: null,
        siteContactMobile: null,
        run: null,
      });
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
      const job = jobs.get(id);
      if (job) jobs.set(id, { ...job, readyDate, targetDate });
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
        fromCustomer: input.fromCustomer,
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
        accountId: options.accountId ?? FAKE_JOB_ACCOUNT_ID,
        accountName: options.accountName ?? 'Clarendon Homes',
        siteName: options.siteName ?? 'Lot 214 Allambie Circuit',
        bookedByUserId: options.bookedByUserId ?? null,
        readyDate: options.readyDate ?? '2026-09-24',
        targetDate: options.targetDate ?? '2026-10-01',
        siteContactEmail: options.siteContactEmail ?? null,
        siteContactMobile: options.siteContactMobile ?? null,
        run: options.run ?? null,
      });
      return id;
    },

    /** The run a job is on now, or null — to assert a job came off it. */
    runOf(id: string): SeedRun | null {
      return jobs.get(id)?.run ?? null;
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
