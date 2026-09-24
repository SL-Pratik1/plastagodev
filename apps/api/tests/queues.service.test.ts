import type { Role } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearOutbound,
  makeFakeNotificationRepository,
  providerFailure,
  recordingProviders,
  sentMessages,
} from './helpers/fake-outbound.js';

/**
 * The office's worklists (M2.6, M2.7, M7.3).
 *
 * ── What is actually under test ────────────────────────────────────
 * The rules that stop a queue lying. Two people deciding the same row must not
 * both win; a rejection must say why, because the driver is told; and the futile
 * decision must never touch the money — Matt was explicit that *either way the
 * futile fee applies*.
 */

interface DecideFutileInput {
  id: string;
  outcome: 'rescheduled' | 'cancelled';
  decisionNote: string | null;
  decidedBy: string;
  newReadyDate: string | null;
}

interface DecideChargesInput {
  ids: readonly string[];
  to: 'approved' | 'rejected';
  note: string | null;
  decidedBy: string;
}

let futileDecisions: DecideFutileInput[] = [];
let chargeDecisions: DecideChargesInput[] = [];
let chases: ReadonlyArray<readonly string[]> = [];

/** What the repository is told to return. Set per test. */
let futileMatches = true;
let chargesChanged = 1;
let chasesChanged = 1;
let feeLookupFails = false;

let listedFee: string | null = null;

/** The awaiting-PO invoices a chase finds. Set per test. */
interface ChaseInvoice {
  id: string;
  invoiceNumber: number;
  accountId: string;
  accountName: string;
  jobId: string | null;
  jobNumber: number | null;
  siteName: string | null;
  totalIncGst: string;
  chargeSummary: string;
  chaseCount: number;
  billingContacts: Array<{ id: string; name: string; email: string }>;
}
let chaseInvoices: ChaseInvoice[] = [];

vi.mock('../src/domains/queues/queue.repository.js', () => ({
  /*
   * ⚠️ Not just `queueRepository`. The service imports this constant from the
   * same module to look the fallback price up with, and a factory that omits it
   * hands the service `undefined` — which fails the lookup and silently turns
   * every fee into "0.00" rather than erroring anywhere useful.
   */
  FUTILE_CHARGE_CODE: 'futile-pickup',
  queueRepository: {
    counts: () =>
      Promise.resolve({
        futileReview: 3,
        serviceApprovals: 5,
        awaitingPo: 2,
        poReview: 0,
        leads: 0,
      }),
    futileList: (_query: unknown, fee: string) => {
      listedFee = fee;
      return Promise.resolve({
        data: [],
        meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
      });
    },
    futileGet: (id: string, fee: string) => {
      listedFee = fee;
      return Promise.resolve(id === 'missing'.padEnd(24, '0') ? null : { id });
    },
    decideFutile: (input: DecideFutileInput) => {
      futileDecisions.push(input);
      return Promise.resolve(futileMatches ? { jobId: 'job1' } : null);
    },
    approvalList: () =>
      Promise.resolve({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } }),
    approvalGet: (id: string) =>
      Promise.resolve(id === 'missing'.padEnd(24, '0') ? null : { id }),
    decideCharges: (input: DecideChargesInput) => {
      chargeDecisions.push(input);
      return Promise.resolve({
        changed: chargesChanged,
        jobIds: ['job1'],
        // The charges the repository reports as decided.
        decided: Array.from({ length: chargesChanged }, (_unused, index) => ({
          id: `65000000000000000000000${String(index + 1)}`,
          jobId: 'job1',
          description: 'Contamination',
          amountExGst: '120.00',
        })),
      });
    },
    awaitingPoList: () =>
      Promise.resolve({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } }),
    awaitingPoForChase: (ids: readonly string[]) =>
      Promise.resolve(chaseInvoices.filter((invoice) => ids.includes(invoice.id))),
    recordChase: (ids: readonly string[]) => {
      chases = [...chases, ids];
      return Promise.resolve(chasesChanged);
    },
  },
}));

/*
 * "Send reminder" emails for real now, so the send log and the provider are
 * faked at their edges — the real `outboundService` runs between them.
 */
vi.mock('../src/domains/notifications/notification.repository.js', () => ({
  notificationRepository: makeFakeNotificationRepository(),
}));

/** The invoice-number prefix the PO request prints ("PGA-104234"). */
vi.mock('../src/domains/settings/settings.repository.js', () => ({
  settingsRepository: {
    get: () => Promise.resolve({ invoicing: { invoiceNumberPrefix: 'PGA' } }),
  },
}));

vi.mock('../src/domains/settings/pricing.service.js', () => ({
  pricingService: {
    priceAdditionalService: () =>
      feeLookupFails
        ? Promise.reject(new Error('not configured'))
        : Promise.resolve({ label: 'Futile pickup', amountExGst: '120.00', requiresApproval: true }),
  },
}));

/**
 * A "rescheduled" decision books a replacement pickup, so the queue reaches
 * into the jobs domain. Recorded rather than exercised — what the new job looks
 * like belongs to `jobs`; what this suite asserts is that the queue asks for one
 * on a reschedule and never on a cancel.
 */
const rebooked: Array<{ jobId: string; newReadyDate: string }> = [];
/** Cancels noted on the original job's timeline. */
const closedFutile: Array<{ jobId: string; note: string | null }> = [];

vi.mock('../src/domains/jobs/job.service.js', () => ({
  jobService: {
    rebookFromFutile: (jobId: string, newReadyDate: string) => {
      rebooked.push({ jobId, newReadyDate });
      return Promise.resolve({ id: 'newjob1', jobNumber: 99001 });
    },
    recordFutileClosed: (jobId: string, note: string | null) => {
      closedFutile.push({ jobId, note });
      return Promise.resolve();
    },
  },
}));

/**
 * M2.7 → M7.3 — an approval bills the charges it made billable.
 *
 * Recorded rather than exercised: which invoice a charge lands on belongs to
 * `invoices.service.test.ts`. What this suite pins is that an approval asks for
 * billing, a rejection never does, and the answer reaches the caller.
 */
const billed: Array<readonly string[]> = [];
let billing = {
  invoices: [] as Array<Record<string, unknown>>,
  awaitingJobCompletion: [] as number[],
  notInvoiced: [] as Array<{ jobNumber: number; reason: string }>,
};

vi.mock('../src/domains/invoices/invoice.service.js', () => ({
  invoiceService: {
    billApprovedCharges: (jobIds: readonly string[]) => {
      billed.push(jobIds);
      return Promise.resolve(billing);
    },
  },
}));

const { queueService } = await import('../src/domains/queues/queue.service.js');
const { setMessagingProvidersForTests } = await import('../src/integrations/messaging.js');

const OFFICE = {
  userId: 'usr0000000000000000000f1',
  name: 'Priya Raman',
  roles: ['office-staff'] as Role[],
  accountId: null,
};

const ALLOCATOR = {
  userId: 'usr0000000000000000000a1',
  name: 'Dean Kelly',
  roles: ['allocator', 'driver'] as Role[],
  accountId: null,
};

const CUSTOMER = {
  userId: 'usr0000000000000000000c1',
  name: 'Angela Fitzgerald',
  roles: ['customer-administrator'] as Role[],
  accountId: 'acc0000000000000000000a1',
};

const DRIVER = {
  userId: 'usr0000000000000000000d1',
  name: 'Troy Holm',
  roles: ['driver'] as Role[],
  accountId: null,
};

const ID = 'a'.repeat(24);

beforeEach(() => {
  futileDecisions = [];
  chargeDecisions = [];
  chases = [];
  futileMatches = true;
  chargesChanged = 1;
  chasesChanged = 1;
  feeLookupFails = false;
  listedFee = null;
  rebooked.length = 0;
  closedFutile.length = 0;
  billed.length = 0;
  billing = { invoices: [], awaitingJobCompletion: [], notInvoiced: [] };
  chaseInvoices = [];
  clearOutbound();
  setMessagingProvidersForTests(recordingProviders());
});

/** An awaiting-PO invoice with one billing contact, unless a test says otherwise. */
function chaseInvoice(over: Partial<ChaseInvoice> = {}): ChaseInvoice {
  return {
    id: ID,
    invoiceNumber: 104_234,
    accountId: 'acc0000000000000000000a1',
    accountName: 'Clarendon Homes',
    jobId: 'job0000000000000000000j1',
    jobNumber: 61_473,
    siteName: 'Lot 88 Ridgeline Drive',
    totalIncGst: '132.00',
    chargeSummary: 'Contamination — timber offcuts',
    chaseCount: 0,
    billingContacts: [{ id: 'con1', name: 'Tomas Herrera', email: 'ap@clarendon.com.au' }],
    ...over,
  };
}

describe('who can see a worklist', () => {
  it('lets office staff in', async () => {
    await expect(queueService.counts(OFFICE)).resolves.toMatchObject({ serviceApprovals: 5 });
  });

  it('lets an allocator work the futile queue', async () => {
    await expect(queueService.futileList({ page: 1, pageSize: 20 }, ALLOCATOR)).resolves.toBeDefined();
  });

  /*
   * Queues are internal. A customer has no scoped view of "every pending
   * charge", and a driver must never see what the office decided about theirs.
   */
  it('keeps customers out', async () => {
    await expect(queueService.counts(CUSTOMER)).rejects.toMatchObject({ status: 403 });
  });

  it('keeps drivers out', async () => {
    await expect(
      queueService.approvalList({ page: 1, pageSize: 20 }, DRIVER),
    ).rejects.toMatchObject({ status: 403 });
  });

  /* Approving a charge is a pricing decision — narrower than reading a list. */
  it('lets an allocator read approvals but not decide them', async () => {
    await expect(
      queueService.approvalList({ page: 1, pageSize: 20 }, ALLOCATOR),
    ).resolves.toBeDefined();

    await expect(
      queueService.approvalDecide([ID], { decision: 'approve', note: '' }, ALLOCATOR),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('futile review (M2.6)', () => {
  it('records a reschedule with its new date', async () => {
    await queueService.futileDecide(
      ID,
      { outcome: 'rescheduled', newReadyDate: '2026-09-20', cancelReason: null, note: 'Rebooked' },
      OFFICE,
    );

    expect(futileDecisions[0]).toMatchObject({
      outcome: 'rescheduled',
      newReadyDate: '2026-09-20',
      decidedBy: 'Priya Raman',
    });
  });

  /*
   * The screen promises "Rescheduling books a new pickup" and the toast says
   * the job was rescheduled. For a long time neither was true: the decision was
   * recorded, `newReadyDate` was written and read by nothing, and no pickup was
   * ever booked — so the queue cleared and the customer was never collected.
   */
  it('books a replacement pickup when the outcome is rescheduled', async () => {
    await queueService.futileDecide(
      ID,
      { outcome: 'rescheduled', newReadyDate: '2026-09-20', cancelReason: null, note: '' },
      OFFICE,
    );

    expect(rebooked).toEqual([{ jobId: 'job1', newReadyDate: '2026-09-20' }]);
  });

  /* Cancelling books nothing: the job stays futile, which is what invoicing
   * accepts, so the $120 still reaches the invoice. */
  it('books nothing when the outcome is cancelled', async () => {
    await queueService.futileDecide(
      ID,
      { outcome: 'cancelled', newReadyDate: null, cancelReason: 'site-not-ready', note: '' },
      OFFICE,
    );

    expect(rebooked).toHaveLength(0);
  });

  /*
   * The job stays `futile` either way, so its timeline is the only place that
   * can say the review was decided. A cancel wrote nothing there, and the job
   * page went on sending people to decide it.
   */
  it('notes a cancel on the original job, with the office’s note', async () => {
    await queueService.futileDecide(
      ID,
      {
        outcome: 'cancelled',
        newReadyDate: null,
        cancelReason: 'site-not-ready',
        note: 'Builder pulled out',
      },
      OFFICE,
    );

    expect(closedFutile).toEqual([{ jobId: 'job1', note: 'Builder pulled out' }]);
  });

  it('does not note a cancel on a reschedule — that writes its own line', async () => {
    await queueService.futileDecide(
      ID,
      { outcome: 'rescheduled', newReadyDate: '2026-09-20', cancelReason: null, note: '' },
      OFFICE,
    );

    expect(closedFutile).toHaveLength(0);
  });

  it('refuses a reschedule with no date', async () => {
    await expect(
      queueService.futileDecide(
        ID,
        { outcome: 'rescheduled', newReadyDate: null, cancelReason: null, note: '' },
        OFFICE,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  /* M2.4 forbids a bare cancel: a reason people pick can be counted. */
  it('refuses a cancel with no structured reason', async () => {
    await expect(
      queueService.futileDecide(
        ID,
        { outcome: 'cancelled', newReadyDate: null, cancelReason: null, note: '' },
        OFFICE,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('does not carry a ready date onto a cancellation', async () => {
    await queueService.futileDecide(
      ID,
      {
        outcome: 'cancelled',
        newReadyDate: '2026-09-20',
        cancelReason: 'customer-request',
        note: '',
      },
      OFFICE,
    );

    // A cancelled job has no new ready date; carrying one would make the record
    // read as though it were rescheduled.
    expect(futileDecisions[0]?.newReadyDate).toBeNull();
  });

  /*
   * ⚠️ Two people working the queue at once. A second decision is a
   * contradiction, not an update — the filter does not match and we say so.
   */
  it('refuses a second decision on an already-decided review', async () => {
    futileMatches = false;

    await expect(
      queueService.futileDecide(
        ID,
        { outcome: 'cancelled', newReadyDate: null, cancelReason: 'access-blocked', note: '' },
        OFFICE,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  /*
   * ⚠️ This pins the FALLBACK, not what a row displays.
   *
   * Each row carries the fee frozen onto its own job when the driver marked the
   * pickup futile, joined in the repository — which this suite fakes, so the
   * join does not run here at all. What is asserted is that the price list is
   * still read (rather than a figure being hard-coded) and handed down for the
   * reviews that have no charge line to read.
   *
   * The behaviour that matters is in `futile-fee.integration.test.ts`, against
   * a real database.
   */
  it('passes the price-list fee down as the fallback, not a hard-coded figure', async () => {
    await queueService.futileList({ page: 1, pageSize: 20 }, OFFICE);

    expect(listedFee).toBe('120.00');
  });

  /*
   * The rows still need reviewing even if the price list is misconfigured — the
   * fee is shown for context here, not charged.
   */
  it('still lists when the fee cannot be looked up', async () => {
    feeLookupFails = true;

    await expect(queueService.futileList({ page: 1, pageSize: 20 }, OFFICE)).resolves.toBeDefined();
    expect(listedFee).toBe('0.00');
  });

  it('404s a review that does not exist', async () => {
    await expect(queueService.futileGet('missing'.padEnd(24, '0'), OFFICE)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('charge approvals (M2.7)', () => {
  it('approves a batch and reports how many moved', async () => {
    chargesChanged = 3;

    await expect(
      queueService.approvalDecide([ID, ID, ID], { decision: 'approve', note: '' }, OFFICE),
    ).resolves.toMatchObject({ changed: 3 });

    expect(chargeDecisions[0]?.to).toBe('approved');
  });

  /*
   * ⚠️ REGRESSION. Approving flipped a flag and nothing else, while the screen
   * said the charge had moved to Awaiting PO. Now the approval bills the jobs it
   * touched, and says where the money went.
   */
  it('bills what it approved, and says where it went', async () => {
    billing = {
      invoices: [
        {
          invoiceNumber: 104_101,
          jobNumber: 61_302,
          kind: 'additional-charges',
          status: 'awaiting-po',
          change: 'created',
        },
      ],
      awaitingJobCompletion: [61_300],
      notInvoiced: [],
    };

    const outcome = await queueService.approvalDecide(
      [ID],
      { decision: 'approve', note: '' },
      OFFICE,
    );

    expect(billed).toEqual([['job1']]);
    expect(outcome).toMatchObject({
      changed: 1,
      invoices: [{ invoiceNumber: 104_101, status: 'awaiting-po' }],
      awaitingJobCompletion: [61_300],
    });
  });

  it('bills nothing on a rejection', async () => {
    await queueService.approvalDecide(
      [ID],
      { decision: 'reject', note: 'Clean board in the photo' },
      OFFICE,
    );

    expect(billed).toEqual([]);
  });

  /*
   * ⚠️ The driver is told why. A rejection with no reason reads as the office
   * disbelieving them, and the next contamination goes unreported.
   */
  it('refuses a rejection with no reason', async () => {
    await expect(
      queueService.approvalDecide([ID], { decision: 'reject', note: '   ' }, OFFICE),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('allows an approval with no note', async () => {
    await expect(
      queueService.approvalDecide([ID], { decision: 'approve', note: '' }, OFFICE),
    ).resolves.toMatchObject({ changed: 1 });
  });

  it('records the rejection reason against the charge', async () => {
    await queueService.approvalDecide(
      [ID],
      { decision: 'reject', note: 'Photo shows clean board' },
      OFFICE,
    );

    expect(chargeDecisions[0]).toMatchObject({
      to: 'rejected',
      note: 'Photo shows clean board',
    });
  });

  /*
   * A grid selection is expected to contain rows somebody else already
   * actioned. Nothing moving at all is different — that is worth telling the
   * user about.
   */
  it('conflicts when nothing in the batch could be decided', async () => {
    chargesChanged = 0;

    await expect(
      queueService.approvalDecide([ID], { decision: 'approve', note: '' }, OFFICE),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses an empty selection', async () => {
    await expect(
      queueService.approvalDecide([], { decision: 'approve', note: '' }, OFFICE),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('awaiting a purchase order (M7.3)', () => {
  const SECOND = 'b'.repeat(24);

  it('records a chase against the selected invoices', async () => {
    chaseInvoices = [chaseInvoice(), chaseInvoice({ id: SECOND, invoiceNumber: 104_235 })];
    chasesChanged = 2;

    await expect(queueService.awaitingPoChase([ID, SECOND], OFFICE)).resolves.toMatchObject({
      changed: 2,
    });
    expect(chases[0]).toEqual([ID, SECOND]);
  });

  /*
   * ⚠️ The screen said "emailed to each account's billing contact" and nothing
   * was ever sent. Now it is — to the billing contact, naming the invoice as
   * its PDF prints it and what the PO is for.
   */
  it('emails the billing contact for the purchase order', async () => {
    chaseInvoices = [chaseInvoice()];

    const result = await queueService.awaitingPoChase([ID], OFFICE);

    expect(result).toEqual({ changed: 1, emailed: 1, noBillingEmail: 0, failed: 0 });
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({ channel: 'email', to: 'ap@clarendon.com.au' });
    expect(sentMessages[0]?.subject).toContain('PGA-104234');
    expect(sentMessages[0]?.body).toContain('Contamination — timber offcuts');
    expect(sentMessages[0]?.body).toContain('$132.00');
    expect(sentMessages[0]?.body).toContain('job #61473');
  });

  it('sends a new email on the next chase, not the same one again', async () => {
    chaseInvoices = [chaseInvoice({ chaseCount: 0 })];
    await queueService.awaitingPoChase([ID], OFFICE);

    chaseInvoices = [chaseInvoice({ chaseCount: 1 })];
    await queueService.awaitingPoChase([ID], OFFICE);

    expect(sentMessages).toHaveLength(2);
  });

  /* Somebody has to ring these — so the screen is told which. */
  it('reports an account with no billing email, and still logs the chase', async () => {
    chaseInvoices = [chaseInvoice({ billingContacts: [] })];

    const result = await queueService.awaitingPoChase([ID], OFFICE);

    expect(result).toEqual({ changed: 1, emailed: 0, noBillingEmail: 1, failed: 0 });
    expect(sentMessages).toHaveLength(0);
    expect(chases[0]).toEqual([ID]);
  });

  it('reports a send that failed rather than claiming it went', async () => {
    chaseInvoices = [chaseInvoice()];
    providerFailure.message = 'Graph is down';

    const result = await queueService.awaitingPoChase([ID], OFFICE);

    expect(result).toMatchObject({ emailed: 0, failed: 1 });
  });

  /*
   * Chasing an invoice that has since been released would be a call nobody
   * needed to make — the repository filters on `awaiting-po`, and nothing
   * matching means the queue has moved on.
   */
  it('conflicts when nothing is waiting on a PO any more', async () => {
    chaseInvoices = [];

    await expect(queueService.awaitingPoChase([ID], OFFICE)).rejects.toMatchObject({
      status: 409,
    });
    expect(chases).toHaveLength(0);
  });

  it('refuses an empty selection', async () => {
    await expect(queueService.awaitingPoChase([], OFFICE)).rejects.toMatchObject({ status: 422 });
  });

  it('keeps customers out of the chase list', async () => {
    await expect(queueService.awaitingPoChase([ID], CUSTOMER)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('badge counts', () => {
  it('returns every queue, including the ones not built yet', async () => {
    const counts = await queueService.counts(OFFICE);

    // Reported as 0 rather than omitted, so the badge renders and the shape
    // never changes under the UI when those queues land.
    expect(counts).toEqual({
      futileReview: 3,
      serviceApprovals: 5,
      awaitingPo: 2,
      poReview: 0,
      leads: 0,
    });
  });
});
