import type {
  FutileOutcome,
  InvoiceListItem,
  Job,
  JobListItem,
  RunStatus,
  RunTipOff,
  TermsAcceptance,
  User,
} from '@plastago/shared';
import { ACCOUNTS, objectId, type AccountFixture } from './fixtures/reference';
import { JOBS, toListItem } from './fixtures/jobs';
import { buildLeads, buildPoExtractions } from './fixtures/queues';
import { USERS } from './fixtures/users';

/** M2.6 — what the office decided about a futile pickup, keyed by job id. */
export interface FutileDecisionRecord {
  outcome: Exclude<FutileOutcome, 'pending'>;
  note: string;
  decidedAt: string;
  decidedBy: string;
  newReadyDate: string | null;
}

/** M7.3 — chase history, keyed by the additional-charges invoice id. */
export interface ChaseRecord {
  lastChasedAt: string;
  chaseCount: number;
}

/**
 * Changes made to a derived invoice — sending it, or recording the PO that
 * releases it.
 *
 * Lives HERE rather than inside `invoices.mock.ts` because two domains read it:
 * the invoice list and the awaiting-PO queue are the same fact seen from two
 * places (M7.3). When the map was private to the invoice mock, recording a PO
 * updated the invoice and left the queue row exactly where it was.
 */
export interface InvoiceOverride {
  status?: InvoiceListItem['status'];
  poNumber?: string;
  sentAt?: string | null;
  xeroState?: 'not-synced' | 'synced' | 'failed' | 'unknown';
  xeroLastSyncAt?: string | null;
  xeroMessage?: string | null;
}

/**
 * One mutable in-memory store, shared by every mock service.
 *
 * ── Why a store and not per-service arrays ─────────────────────────────────
 * Because the domains are connected and a demo has to behave like it. Assigning
 * a job on the allocation board must change the driver shown in the jobs grid;
 * suspending a user must change their row. If each mock kept its own copy of the
 * fixtures, those actions would appear to work and then silently disagree —
 * which is worse than not being wired at all, because it undermines trust in
 * everything else on screen.
 *
 * State lives for the page session only. A reload restores the fixtures, which
 * is the right behaviour for a demo: any experiment is one refresh from undone.
 */
/**
 * A run, as the mock holds it (M3.1).
 *
 * Deliberately thin: an ordered list of job ids plus who is on it. Everything
 * the board and the run sheet render — suburbs, totals, at-risk counts — is
 * derived from the jobs at read time, so a job edited anywhere cannot leave a
 * run quoting a stale figure.
 *
 * The ORDER of `jobIds` is the stop sequence. Route optimisation rewrites this
 * array rather than writing a separate sequence field, because two sources of
 * order is how a driver ends up with a printed run sheet that disagrees with
 * the one on his phone.
 */
export interface RunRecord {
  id: string;
  runNumber: number;
  name: string;
  date: string;
  /** Null while the run is still being built — a run is shaped before it is staffed. */
  driverId: string | null;
  status: RunStatus;
  jobIds: string[];
  optimisedAt: string | null;
  /** The weighbridge docket that closed this run. One docket, one run (Matt, 43:50). */
  tipOff: RunTipOff | null;
}

export const store = {
  jobs: JOBS.map((job) => ({ ...job })) as Job[],
  users: USERS.map((user) => ({ ...user })) as User[],
  /**
   * M3.1 — runs are the unit of allocation (Matt, 39:41).
   *
   * Seeded below from whatever the job fixtures already put a driver on, so the
   * board opens on a day that looks worked rather than on an empty column.
   */
  runs: [] as RunRecord[],

  // ── Queue state (M2.6, M7.3, M2.12, M5 · Journey A) ────────────────────
  // Futile decisions and chases are keyed rather than stored on the job,
  // because they are office actions ABOUT a job, not properties of it — the
  // same distinction the real schema will make between `jobs` and the queue
  // collections that reference them.
  futileDecisions: new Map<string, FutileDecisionRecord>(),
  chases: new Map<string, ChaseRecord>(),
  /*
   * M4.8b — the office's overrides of each account's risk-assessment rule.
   *
   * A Map keyed by account id rather than a field mutated on the `ACCOUNTS`
   * fixture, because those are `readonly` module constants shared by every
   * mock: writing into one would leak a demo edit into the jobs, dispatch and
   * portal fixtures that also read them. Per-SITE overrides do live on the row,
   * since the jobs themselves are already a mutable copy.
   */
  accountRiskAssessment: new Map<string, boolean>(),
  invoiceOverrides: new Map<string, InvoiceOverride>(),
  /**
   * Journey A.4 — accounts whose customer has accepted the terms.
   *
   * A Map keyed by account id rather than a field on the `ACCOUNTS` fixture,
   * for the same reason as `accountRiskAssessment`: those are readonly module
   * constants shared by every mock, and writing into one would leak a demo edit
   * into the jobs, dispatch and portal fixtures that read them too.
   */
  termsAcceptance: new Map<string, TermsAcceptance>(),
  /**
   * Where each account's diversion certificates are emailed (Matt, 31:04).
   *
   * Set by the customer during onboarding, because they are the ones who know
   * which of their teams reads them — the office only knows the accounts inbox.
   */
  accountCertificateEmail: new Map<string, string>(),
  /**
   * Accounts created during the session, with no lead behind them (Matt, 6:10).
   *
   * A separate list rather than a mutable copy of `ACCOUNTS`, because that
   * fixture is a readonly module constant that the jobs, dispatch, portal and
   * report fixtures all read at import time — replacing it would mean rebuilding
   * every one of them. Readers use `allAccounts()`, which is the only place the
   * two are joined.
   */
  createdAccounts: [] as AccountFixture[],
  leads: buildLeads(),
  poExtractions: buildPoExtractions(),
};

export function findJob(id: string): Job | undefined {
  return store.jobs.find((job) => job.id === id);
}

export function jobList(): JobListItem[] {
  return store.jobs.map(toListItem);
}

export function findUser(id: string): User | undefined {
  return store.users.find((user) => user.id === id);
}

export function accountName(accountId: string): string {
  return ACCOUNTS.find((account) => account.id === accountId)?.name ?? 'Unknown account';
}

/**
 * Invoices, projected from jobs.
 *
 * Derived rather than stored because that is what they are: M7.1 issues one
 * invoice per job on completion. Deriving also keeps the two-invoice workflow
 * honest — a job with approved charges still awaiting a PO produces a base
 * invoice and a *separate* additional-charges invoice, which is the whole point
 * of M7.2 and the reason cash is not delayed by a second PO.
 */
export function invoiceList(): InvoiceListItem[] {
  const invoices: InvoiceListItem[] = [];

  for (const job of store.jobs) {
    /*
     * ── The additional-charges invoice is emitted INDEPENDENTLY ────────────
     * M7.2 is explicit that a job can produce two invoices: the base one goes
     * out on completion against the original PO and is already earning, while
     * approved extras wait for their own PO. So this is not an `else` branch of
     * the base invoice — both can exist for the same job at the same time, and
     * modelling it as a choice was what made the awaiting-PO queue unreachable.
     */
    const extras = job.charges.filter(
      (charge) => charge.source !== 'office' && charge.approvalState === 'approved',
    );
    const completed = job.status === 'completed' || job.status === 'admin-complete';
    const poRequired =
      ACCOUNTS.find((account) => account.id === job.accountId)?.poPolicy ===
      'required-before-invoice';

    if (completed && extras.length > 0 && poRequired) {
      const subtotal = extras.reduce((sum, charge) => sum + Number(charge.amount), 0);
      invoices.push({
        id: `${job.id}-po`,
        invoiceNumber: 104900 + job.jobNumber - 61300,
        kind: 'additional-charges',
        status: 'awaiting-po',
        brandId: job.brandId,
        accountId: job.accountId,
        accountName: job.accountName,
        jobId: job.id,
        jobNumber: job.jobNumber,
        poNumber: null,
        issuedOn: null,
        dueOn: null,
        subtotalExGst: subtotal.toFixed(2),
        gst: (subtotal / 10).toFixed(2),
        totalIncGst: (subtotal * 1.1).toFixed(2),
        paidAt: null,
      });
    }

    if (job.invoiceNumber === null) continue;

    const issuedOn = job.invoicedAt?.slice(0, 10) ?? null;
    const dueOn = issuedOn ? addDays(issuedOn, 7) : null;
    const paid = job.invoiceStatus === 'paid';
    const overdue = !paid && dueOn !== null && dueOn < new Date().toISOString().slice(0, 10);

    invoices.push({
      id: `${job.id}-base`,
      invoiceNumber: job.invoiceNumber,
      kind: 'base',
      status: paid ? 'paid' : overdue ? 'overdue' : 'sent',
      brandId: job.brandId,
      accountId: job.accountId,
      accountName: job.accountName,
      jobId: job.id,
      jobNumber: job.jobNumber,
      poNumber: job.poNumber,
      issuedOn,
      dueOn,
      subtotalExGst: job.totalExGst,
      gst: job.gst,
      totalIncGst: job.totalIncGst,
      paidAt: paid ? job.invoicedAt : null,
    });
  }

  // Applied here, once, so every reader of this list sees the same invoice —
  // the grid, the detail page, and the awaiting-PO queue.
  return invoices.map((invoice) => {
    const override = store.invoiceOverrides.get(invoice.id);
    if (!override) return invoice;
    return {
      ...invoice,
      status: override.status ?? invoice.status,
      poNumber: override.poNumber ?? invoice.poNumber,
    };
  });
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Today, as a plain date, in the timezone the whole product renders in. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** True when a job has passed, or is about to pass, its target date (M2.4a). */
export function isAtRisk(job: Pick<Job, 'targetDate' | 'status'>): boolean {
  const open = !['completed', 'admin-complete', 'futile', 'cancelled'].includes(job.status);
  if (!open) return false;
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return job.targetDate <= tomorrow.toISOString().slice(0, 10);
}

/* ── Runs (M3.1) ────────────────────────────────────────────────────────── */

let runSequence = 0;

/**
 * Name a run the way the allocator would.
 *
 * Matt's own example is *"Newcastle run 1"* (39:41) — the area, then which trip
 * of the day it is. Naming it after the dominant suburb rather than the zone
 * keeps two Sydney runs distinguishable, which "Sydney run 1 / 2" does not once
 * one of them is Kellyville and the other is Cronulla.
 */
function nameRun(suburb: string, ordinal: number): string {
  return `${suburb} run ${String(ordinal)}`;
}

/** Create a run. Exported so the dispatch mock and the seeder share one path. */
export function addRun(input: {
  name: string;
  date: string;
  driverId: string | null;
  jobIds: string[];
}): RunRecord {
  runSequence += 1;
  const run: RunRecord = {
    id: objectId('run', runSequence),
    runNumber: 400 + runSequence,
    name: input.name.trim(),
    date: input.date,
    driverId: input.driverId,
    // A run with nobody on it is still being built, whatever else is true of it.
    status: input.driverId === null ? 'planning' : 'assigned',
    jobIds: [...input.jobIds],
    optimisedAt: null,
    tipOff: null,
  };
  store.runs = [...store.runs, run];
  return run;
}

/**
 * Build the opening set of runs from the job fixtures.
 *
 * Groups each driver's jobs for a date by suburb, because that is how a run is
 * actually assembled (Matt, 41:17). One driver with jobs in two areas therefore
 * opens with two runs — which is the case worth seeing on the board, since it is
 * the one the old job-per-driver model could not express.
 */
function seedRuns(): RunRecord[] {
  const open = store.jobs.filter(
    (job) =>
      job.driverId !== null &&
      !['completed', 'admin-complete', 'futile', 'cancelled'].includes(job.status),
  );

  const byDriverDate = new Map<string, Job[]>();
  for (const job of open) {
    const key = `${String(job.driverId)}|${job.readyDate}`;
    byDriverDate.set(key, [...(byDriverDate.get(key) ?? []), job]);
  }

  for (const [key, jobs] of byDriverDate) {
    const [driverId, date] = key.split('|');

    const bySuburb = new Map<string, Job[]>();
    for (const job of jobs) {
      bySuburb.set(job.suburb, [...(bySuburb.get(job.suburb) ?? []), job]);
    }

    let ordinal = 0;
    for (const [suburb, group] of bySuburb) {
      ordinal += 1;
      addRun({
        name: nameRun(suburb, ordinal),
        date: date ?? todayIso(),
        driverId: driverId ?? null,
        jobIds: group
          .sort((a, b) => a.jobNumber - b.jobNumber)
          .map((job) => job.id),
      });
    }
  }

  return store.runs;
}

/* ── Onboarding (Journey A.4) ───────────────────────────────────────────── */

/** The terms as they stand. Bumped whenever the wording changes. */
export const TERMS_VERSION = '2026-02';

/**
 * Seed the terms acceptances.
 *
 * Every established account has signed — they have been trading for years, and
 * a demo where twelve customers all look unsigned would make the state
 * meaningless. The two most recently won accounts are left outstanding, because
 * an account sitting in `awaiting-terms` is the case the office needs to see and
 * chase: no director's guarantee on file yet.
 */
function seedTermsAcceptance(): void {
  const outstanding = new Set(['PRE001', 'HAR001']);

  for (const account of ACCOUNTS) {
    if (outstanding.has(account.code)) continue;
    store.termsAcceptance.set(account.id, {
      acceptedAt: '2025-07-14T03:22:00.000Z',
      acceptedByName: account.contacts[0]?.name ?? 'Director',
      acceptedByRole: 'Director',
      termsVersion: TERMS_VERSION,
    });
  }
}

seedTermsAcceptance();

/**
 * Every account: the fixtures plus anything created this session.
 *
 * One accessor, so a screen cannot accidentally read only the seeded twelve and
 * leave a just-created customer invisible on its own detail page.
 */
export function allAccounts(): readonly AccountFixture[] {
  return [...ACCOUNTS, ...store.createdAccounts];
}

/** Which run a job is on, if any. */
export function runForJob(jobId: string): RunRecord | undefined {
  return store.runs.find((run) => run.jobIds.includes(jobId));
}

/**
 * Runs live behind a function call rather than an initialiser because
 * `seedRuns` reads `store.jobs`, which does not exist until the object literal
 * above has finished evaluating.
 */
seedRuns();
