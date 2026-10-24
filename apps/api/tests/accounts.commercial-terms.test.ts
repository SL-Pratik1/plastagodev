import type { AccountCommercialTerms, Role } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Changing a customer's rate card and commercial terms (show-and-tell, 21 Oct).
 *
 * Matt: *"there's currently no way to change the rate card that they're on…
 * commercial terms, the rate card, payment terms, all of that."*
 *
 * Pinned here: open jobs keep their booked price unless the office opts in,
 * only a CHANGED card re-prices anything, a job the new card cannot price keeps
 * its old price and is named, and switching "PO required" off releases the
 * invoices that were waiting for one.
 */

const ACCOUNT_ID = 'acc0000000000000000000a1';

const stored = {
  id: ACCOUNT_ID,
  name: 'Wisdom Homes',
  rateCardId: 'default',
  paymentTermsDays: 7,
  poPolicy: 'required-before-invoice' as 'required-before-invoice' | 'not-required',
  captureMode: 'area-and-weight' as 'area-and-weight' | 'area-only',
  receivesCertificates: false,
};

let writes: Array<Record<string, unknown>> = [];
let repriced: Array<{ jobId: string; rateCardId: string; reason: string }> = [];
let released: string[] = [];
let failingJob: string | null = null;

vi.mock('../src/domains/accounts/account.repository.js', () => ({
  accountRepository: {
    findById: () => Promise.resolve({ ...stored }),
    setCommercialTerms: (_id: string, terms: Record<string, unknown>) => {
      writes.push(terms);
      Object.assign(stored, terms);
      return Promise.resolve(true);
    },
  },
}));

vi.mock('../src/domains/settings/settings.repository.js', () => ({
  settingsRepository: {
    findRateCard: (id: string) =>
      Promise.resolve(
        ['default', 'wisdom'].includes(id) ? { id, label: id === 'wisdom' ? 'Wisdom Homes' : 'Standard' } : null,
      ),
  },
}));

vi.mock('../src/domains/jobs/job.repository.js', () => ({
  jobRepository: {},
  countRepriceableJobs: () => Promise.resolve(2),
  repriceableJobs: () =>
    Promise.resolve([
      { id: 'job1', jobNumber: 61_401 },
      { id: 'job2', jobNumber: 61_402 },
    ]),
}));

vi.mock('../src/domains/jobs/job.service.js', () => ({
  jobService: {
    reprice: (jobId: string, rateCardId: string, change: { reason: string }) => {
      if (jobId === failingJob) {
        return Promise.reject(
          Object.assign(new Error('No rate is configured for Newcastle on 2026-10-30.'), {
            status: 503,
          }),
        );
      }
      repriced.push({ jobId, rateCardId, reason: change.reason });
      return Promise.resolve({ jobNumber: 61_401, previous: '364.00', next: '302.00' });
    },
  },
}));

vi.mock('../src/domains/invoices/invoice.repository.js', () => ({
  invoiceRepository: { countAwaitingPo: () => Promise.resolve(3) },
}));

vi.mock('../src/domains/invoices/invoice.service.js', () => ({
  invoiceService: {
    releaseAwaitingPoForAccount: (accountId: string) => {
      released.push(accountId);
      return Promise.resolve(3);
    },
  },
}));

const { accountService } = await import('../src/domains/accounts/account.service.js');
const { AppError } = await import('../src/lib/app-error.js');

const OPS = { roles: ['operations'] as Role[], accountId: null, name: 'Renee Boyle' };
const CUSTOMER = { roles: ['customer-administrator'] as Role[], accountId: ACCOUNT_ID };

function terms(overrides: Partial<AccountCommercialTerms> = {}): AccountCommercialTerms {
  return {
    rateCardId: 'wisdom',
    paymentTermsDays: 14,
    poPolicy: 'required-before-invoice',
    captureMode: 'area-and-weight',
    repriceOpenJobs: false,
    ...overrides,
  };
}

beforeEach(() => {
  Object.assign(stored, {
    rateCardId: 'default',
    paymentTermsDays: 7,
    poPolicy: 'required-before-invoice',
    captureMode: 'area-and-weight',
    receivesCertificates: false,
  });
  writes = [];
  repriced = [];
  released = [];
  failingJob = null;
});

describe('changing the commercial terms', () => {
  it('saves the rate card, payment terms, PO policy and capture mode', async () => {
    const result = await accountService.setCommercialTerms(ACCOUNT_ID, terms(), OPS);

    expect(writes).toEqual([
      {
        rateCardId: 'wisdom',
        paymentTermsDays: 14,
        poPolicy: 'required-before-invoice',
        captureMode: 'area-and-weight',
      },
    ]);
    expect(result.account.rateCardId).toBe('wisdom');
  });

  it('leaves open jobs on their booked price by default', async () => {
    const result = await accountService.setCommercialTerms(ACCOUNT_ID, terms(), OPS);

    expect(repriced).toHaveLength(0);
    expect(result.repricedJobs).toBe(0);
  });

  it('re-prices open jobs on the new card when the office opts in', async () => {
    const result = await accountService.setCommercialTerms(
      ACCOUNT_ID,
      terms({ repriceOpenJobs: true }),
      OPS,
    );

    expect(repriced).toEqual([
      { jobId: 'job1', rateCardId: 'wisdom', reason: 'Rate card changed to Wisdom Homes' },
      { jobId: 'job2', rateCardId: 'wisdom', reason: 'Rate card changed to Wisdom Homes' },
    ]);
    expect(result.repricedJobs).toBe(2);
  });

  it('re-prices nothing when the card did not change', async () => {
    stored.rateCardId = 'wisdom';

    await accountService.setCommercialTerms(ACCOUNT_ID, terms({ repriceOpenJobs: true }), OPS);

    expect(repriced).toHaveLength(0);
  });

  it('keeps the old price on a job the new card cannot price, and names it', async () => {
    failingJob = 'job2';

    const result = await accountService.setCommercialTerms(
      ACCOUNT_ID,
      terms({ repriceOpenJobs: true }),
      OPS,
    );

    expect(result.repricedJobs).toBe(1);
    expect(result.notRepriced).toEqual([
      { jobNumber: 61_402, reason: expect.any(String) as string },
    ]);
  });

  it('refuses a rate card that does not exist, on the field', async () => {
    await expect(
      accountService.setCommercialTerms(ACCOUNT_ID, terms({ rateCardId: 'gone' }), OPS),
    ).rejects.toMatchObject({ status: 422, issues: [{ path: 'rateCardId' }] });

    expect(writes).toHaveLength(0);
  });

  it('refuses a customer, before anything is written', async () => {
    await expect(
      accountService.setCommercialTerms(ACCOUNT_ID, terms(), CUSTOMER),
    ).rejects.toBeInstanceOf(AppError);

    expect(writes).toHaveLength(0);
  });
});

/* Found by us: without this, Awaiting-PO invoices wait for a PO nobody will send. */
describe('switching the PO requirement off', () => {
  it('releases the invoices that were waiting for a PO', async () => {
    const result = await accountService.setCommercialTerms(
      ACCOUNT_ID,
      terms({ poPolicy: 'not-required' }),
      OPS,
    );

    expect(released).toEqual([ACCOUNT_ID]);
    expect(result.releasedInvoices).toBe(3);
  });

  it('releases nothing when the PO requirement stays on', async () => {
    await accountService.setCommercialTerms(ACCOUNT_ID, terms(), OPS);

    expect(released).toHaveLength(0);
  });
});

describe('what a change would touch', () => {
  it('counts open, not-invoiced jobs and invoices awaiting a PO', async () => {
    await expect(accountService.commercialTermsImpact(ACCOUNT_ID, OPS)).resolves.toEqual({
      openJobs: 2,
      awaitingPoInvoices: 3,
    });
  });

  it('refuses a customer', async () => {
    await expect(accountService.commercialTermsImpact(ACCOUNT_ID, CUSTOMER)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('a customer who receives certificates (21 Oct)', () => {
  it('keeps their kg — the capture mode cannot drop to m² only', async () => {
    Object.assign(stored, { receivesCertificates: true });

    const error = await accountService
      .setCommercialTerms(ACCOUNT_ID, terms({ captureMode: 'area-only' }), OPS)
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 422 });
    expect((error as { issues?: { path: string }[] }).issues?.[0]?.path).toBe('captureMode');
    expect(writes).toHaveLength(0);
  });
});
