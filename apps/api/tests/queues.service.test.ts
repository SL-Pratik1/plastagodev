import type { Role } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeAuditRepository } from './helpers/fake-audit.js';

/**
 * The office's worklists (M2.6, M2.7, M7.3).
 *
 * ── What is actually under test ───────────────────────────────────────────
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

/*
 * M1.6 — this suite's service records to the audit log. Faked like every other
 * repository: the real one would buffer a write against a MongoDB that is not
 * there and time out. See `helpers/fake-audit.ts`.
 */
vi.mock('../src/domains/audit/audit.repository.js', () => ({
  auditRepository: makeFakeAuditRepository(),
}));


vi.mock('../src/domains/queues/queue.repository.js', () => ({
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
        // M1.6 — the rows the service audits, one entry per charge.
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
    recordChase: (ids: readonly string[]) => {
      chases = [...chases, ids];
      return Promise.resolve(chasesChanged);
    },
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

const { queueService } = await import('../src/domains/queues/queue.service.js');

const OFFICE = {
  userId: 'usr0000000000000000000f1',
  name: 'Priya Raman',
  roles: ['office-staff'] as Role[],
};

const ALLOCATOR = {
  userId: 'usr0000000000000000000a1',
  name: 'Dean Kelly',
  roles: ['allocator', 'driver'] as Role[],
};

const CUSTOMER = {
  userId: 'usr0000000000000000000c1',
  name: 'Angela Fitzgerald',
  roles: ['customer-administrator'] as Role[],
};

const DRIVER = {
  userId: 'usr0000000000000000000d1',
  name: 'Troy Holm',
  roles: ['driver'] as Role[],
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
});

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

  it('shows the futile fee from the price list, not a hard-coded figure', async () => {
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
    ).resolves.toBe(3);

    expect(chargeDecisions[0]?.to).toBe('approved');
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
    ).resolves.toBe(1);
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
  it('records a chase against the selected invoices', async () => {
    chasesChanged = 2;

    await expect(queueService.awaitingPoChase([ID, ID], OFFICE)).resolves.toBe(2);
    expect(chases[0]).toHaveLength(2);
  });

  /*
   * Chasing an invoice that has since been released would be a call nobody
   * needed to make — the repository filters on `awaiting-po`, and nothing
   * matching means the queue has moved on.
   */
  it('conflicts when nothing is waiting on a PO any more', async () => {
    chasesChanged = 0;

    await expect(queueService.awaitingPoChase([ID], OFFICE)).rejects.toMatchObject({
      status: 409,
    });
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
