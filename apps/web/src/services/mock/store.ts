import type {
  FutileOutcome,
  InvoiceListItem,
  Job,
  JobListItem,
  Site,
  User,
} from '@plastago/shared';
import { ACCOUNTS } from './fixtures/reference';
import { JOBS, SITE_FIXTURES, toListItem } from './fixtures/jobs';
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
export const store = {
  jobs: JOBS.map((job) => ({ ...job })) as Job[],
  sites: SITE_FIXTURES.map((site) => ({ ...site })) as Site[],
  users: USERS.map((user) => ({ ...user })) as User[],

  // ── Queue state (M2.6, M7.3, M2.12, M5 · Journey A) ────────────────────
  // Futile decisions and chases are keyed rather than stored on the job,
  // because they are office actions ABOUT a job, not properties of it — the
  // same distinction the real schema will make between `jobs` and the queue
  // collections that reference them.
  futileDecisions: new Map<string, FutileDecisionRecord>(),
  chases: new Map<string, ChaseRecord>(),
  invoiceOverrides: new Map<string, InvoiceOverride>(),
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
        customerReference: job.customerReference,
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
      customerReference: job.customerReference,
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
