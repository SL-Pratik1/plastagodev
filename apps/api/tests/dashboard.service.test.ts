import { DashboardSummarySchema, type Role } from '@plastago/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

/**
 * The admin dashboard (M9.4 · F15).
 *
 * ── What is actually worth testing here ───────────────────────────────────
 * Not the aggregations — those are Mongo's arithmetic and are exercised in QA
 * against real data. What is worth testing is everything the SERVICE decides on
 * top of them, because each of those is a way the screen can lie:
 *
 *  - a rate divided by a month with no work (NaN renders as a number nobody can
 *    read, and "NaN%" is worse than "0%")
 *  - money summed as floats (0.1 + 0.2 on a dashboard the owner reconciles
 *    against invoices)
 *  - an ageing figure taken from the wrong end of the queue — the whole reason
 *    `oldestAt` exists is the futile pickup that sat in TransVirtual for a year
 *  - the response shape drifting away from the contract the UI is built on
 *
 * The last one is asserted by parsing the whole response through the shared Zod
 * schema, so a field added to the service but not the contract fails here rather
 * than in Chrome.
 */

/* ── What the repositories report. Set per test. ──────────────────────────── */

let counters = { openJobs: 12, unallocatedJobs: 3, atRiskJobs: 1, completedToday: 4 };
let exceptions = { futile: 3, contamination: 1, completedOrFutile: 40 };
let invoiceTotals = {
  invoicedThisMonthCents: 1_234_56,
  awaitingPoCents: 90_00,
  overdueCount: 2,
};
let medianOnSite: number | null = 47;
let queueCounts = { futileReview: 2, serviceApprovals: 3, awaitingPo: 1, poReview: 5 };

/** Charge rows the approvals queue is holding, as the queue repository returns them. */
let approvalRows: Array<{ raisedAt: string; amountExGst: string }> = [
  { raisedAt: '2026-09-01T02:00:00.000Z', amountExGst: '0.10' },
  { raisedAt: '2026-09-03T02:00:00.000Z', amountExGst: '0.20' },
];
let awaitingPoRows: Array<{ approvedAt: string; totalExGst: string }> = [
  { approvedAt: '2026-08-20T02:00:00.000Z', totalExGst: '351.75' },
];
let futileRows: Array<{ markedAt: string }> = [{ markedAt: '2025-08-28T02:00:00.000Z' }];
let poReviewRows: Array<{ receivedAt: string }> = [{ receivedAt: '2026-09-07T02:00:00.000Z' }];

/** Query objects the service sent, so paging intent can be asserted. */
let listQueriesSeen: Array<Record<string, unknown>> = [];

vi.mock('../src/domains/dashboard/dashboard.repository.js', () => ({
  dashboardRepository: {
    counters: () => Promise.resolve(counters),
    exceptionsThisMonth: () => Promise.resolve(exceptions),
    invoiceTotals: () => Promise.resolve(invoiceTotals),
    medianOnSiteMinutes: () => Promise.resolve(medianOnSite),
    statusCounts: () => Promise.resolve([{ status: 'booked' as const, count: 9 }]),
    dailyVolume: () => Promise.resolve([{ date: '2026-09-07', jobs: 4, areaM2: 823.41 }]),
    exceptionRates: () =>
      Promise.resolve([
        { weekStarting: '2026-09-01', futilePercent: 7.5, contaminationPercent: 2.5 },
      ]),
    driverHealth: () =>
      Promise.resolve([
        {
          driverId: '650000000000000000000001',
          driverName: 'Dave',
          jobsToday: 3,
          capacity: 6,
          lastSyncAt: '2026-09-08T01:00:00.000Z',
          pendingSyncActions: 0,
        },
      ]),
    recentActivity: () =>
      Promise.resolve([
        {
          id: '650000000000000000000002',
          at: '2026-09-08T01:30:00.000Z',
          actor: 'Dave',
          summary: 'Completed job #61301',
          jobId: '650000000000000000000003',
          jobNumber: 61_301,
          kind: 'status' as const,
        },
      ]),
  },
}));

vi.mock('../src/domains/queues/queue.repository.js', () => ({
  queueRepository: {
    counts: () => Promise.resolve(queueCounts),
    futileList: (query: Record<string, unknown>) => {
      listQueriesSeen.push({ queue: 'futile', ...query });
      return Promise.resolve({ data: futileRows, meta: {} });
    },
    approvalList: (query: Record<string, unknown>) => {
      listQueriesSeen.push({ queue: 'approvals', ...query });
      return Promise.resolve({ data: approvalRows, meta: {} });
    },
    awaitingPoList: (query: Record<string, unknown>) => {
      listQueriesSeen.push({ queue: 'awaiting-po', ...query });
      return Promise.resolve({ data: awaitingPoRows, meta: {} });
    },
  },
}));

vi.mock('../src/domains/queues/po-extraction.repository.js', () => ({
  poExtractionRepository: {
    list: (query: Record<string, unknown>) => {
      listQueriesSeen.push({ queue: 'po-review', ...query });
      return Promise.resolve({ data: poReviewRows, meta: {} });
    },
  },
}));

const { dashboardService } = await import('../src/domains/dashboard/dashboard.service.js');

function caller(...roles: Role[]): { userId: string; name: string; roles: Role[] } {
  return { userId: '650000000000000000000009', name: 'Matt', roles };
}

beforeEach(() => {
  counters = { openJobs: 12, unallocatedJobs: 3, atRiskJobs: 1, completedToday: 4 };
  exceptions = { futile: 3, contamination: 1, completedOrFutile: 40 };
  invoiceTotals = { invoicedThisMonthCents: 1_234_56, awaitingPoCents: 90_00, overdueCount: 2 };
  medianOnSite = 47;
  queueCounts = { futileReview: 2, serviceApprovals: 3, awaitingPo: 1, poReview: 5 };
  approvalRows = [
    { raisedAt: '2026-09-01T02:00:00.000Z', amountExGst: '0.10' },
    { raisedAt: '2026-09-03T02:00:00.000Z', amountExGst: '0.20' },
  ];
  awaitingPoRows = [{ approvedAt: '2026-08-20T02:00:00.000Z', totalExGst: '351.75' }];
  futileRows = [{ markedAt: '2025-08-28T02:00:00.000Z' }];
  poReviewRows = [{ receivedAt: '2026-09-07T02:00:00.000Z' }];
  listQueriesSeen = [];
});

/* ── Who may see it ──────────────────────────────────────────────────────── */

describe('dashboard access', () => {
  it('is refused to a driver', async () => {
    await expect(dashboardService.summary(caller('driver'))).rejects.toMatchObject({
      status: 403,
    });
  });

  it('is refused to a customer, who has their own portal dashboard', async () => {
    await expect(
      dashboardService.summary(caller('customer-administrator')),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('is allowed to an allocator, who works the unallocated column from it', async () => {
    await expect(dashboardService.summary(caller('allocator'))).resolves.toBeDefined();
  });

  it('is allowed when one of several roles qualifies', async () => {
    await expect(
      dashboardService.summary(caller('driver', 'office-staff')),
    ).resolves.toBeDefined();
  });
});

/* ── The shape the UI is built against ───────────────────────────────────── */

describe('dashboard shape', () => {
  it('matches the shared contract exactly', async () => {
    const summary = await dashboardService.summary(caller('super-admin'));

    const parsed = DashboardSummarySchema.parse(summary);

    /*
     * The parse proves everything the contract requires is present and the right
     * type. Comparing the key sets afterwards proves the reverse: Zod STRIPS
     * unknown keys rather than rejecting them, so a field the service invented
     * and the UI is not typed for would survive an assertion that only parsed.
     */
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(summary).sort());
  });

  it('reports failed background jobs as 0 rather than omitting the field', async () => {
    const summary = await dashboardService.summary(caller('operations'));

    // §6A.8. The queue runner is off in development, but the shape must not
    // change under the UI when it lands.
    expect(summary.failedBackgroundJobs).toBe(0);
  });

  it('passes a null median through instead of inventing a zero', async () => {
    medianOnSite = null;

    const summary = await dashboardService.summary(caller('operations'));

    // Zero minutes on site would read as a real, alarming measurement.
    expect(summary.medianOnSiteMinutes).toBeNull();
  });
});

/* ── Rates ───────────────────────────────────────────────────────────────── */

describe('exception rates', () => {
  it('divides by the jobs that reached a site', async () => {
    exceptions = { futile: 3, contamination: 1, completedOrFutile: 40 };

    const summary = await dashboardService.summary(caller('operations'));

    expect(summary.futileRatePercent).toBe(7.5);
    expect(summary.contaminationRatePercent).toBe(2.5);
  });

  it('returns 0, not NaN, in a month with no completed work', async () => {
    exceptions = { futile: 0, contamination: 0, completedOrFutile: 0 };

    const summary = await dashboardService.summary(caller('operations'));

    // NaN survives JSON.stringify as null and renders as a blank tile, which
    // reads as "no data" rather than "nothing happened".
    expect(summary.futileRatePercent).toBe(0);
    expect(summary.contaminationRatePercent).toBe(0);
    expect(Number.isNaN(summary.futileRatePercent)).toBe(false);
  });

  it('rounds to one decimal place', async () => {
    exceptions = { futile: 1, contamination: 0, completedOrFutile: 3 };

    const summary = await dashboardService.summary(caller('operations'));

    expect(summary.futileRatePercent).toBe(33.3);
  });

  it('carries the raw counts alongside the rates', async () => {
    const summary = await dashboardService.summary(caller('operations'));

    // A rate without its numerator invites "is 7.5% three jobs or thirty?".
    expect(summary.futileThisMonth).toBe(3);
    expect(summary.contaminationThisMonth).toBe(1);
  });
});

/* ── Money ───────────────────────────────────────────────────────────────── */

describe('dashboard money', () => {
  it('formats cents as decimal strings on the wire', async () => {
    const summary = await dashboardService.summary(caller('operations'));

    expect(summary.invoicedThisMonthExGst).toBe('1234.56');
    expect(summary.awaitingPoExGst).toBe('90.00');
  });

  it('sums queue money in cents, not floats', async () => {
    approvalRows = [
      { raisedAt: '2026-09-01T02:00:00.000Z', amountExGst: '0.10' },
      { raisedAt: '2026-09-02T02:00:00.000Z', amountExGst: '0.20' },
    ];

    const summary = await dashboardService.summary(caller('operations'));
    const approvals = summary.queues.find((queue) => queue.key === 'service-approvals');

    // 0.1 + 0.2 in floating point is 0.30000000000000004 (§6A.10 #1). This is
    // the figure Matt reconciles against invoices, so it has to be exact.
    expect(approvals?.valueExGst).toBe('0.30');
  });

  it('sums a credit against the charges rather than adding it', async () => {
    approvalRows = [
      { raisedAt: '2026-09-01T02:00:00.000Z', amountExGst: '351.75' },
      { raisedAt: '2026-09-02T02:00:00.000Z', amountExGst: '-51.75' },
    ];

    const summary = await dashboardService.summary(caller('operations'));
    const approvals = summary.queues.find((queue) => queue.key === 'service-approvals');

    expect(approvals?.valueExGst).toBe('300.00');
  });

  it('reports an empty queue as 0.00, not as a missing figure', async () => {
    approvalRows = [];
    queueCounts = { ...queueCounts, serviceApprovals: 0 };

    const summary = await dashboardService.summary(caller('operations'));
    const approvals = summary.queues.find((queue) => queue.key === 'service-approvals');

    expect(approvals?.count).toBe(0);
    expect(approvals?.valueExGst).toBe('0.00');
  });
});

/* ── Queues ──────────────────────────────────────────────────────────────── */

describe('queue summaries', () => {
  it('returns the four actionable queues', async () => {
    const summary = await dashboardService.summary(caller('operations'));

    expect(summary.queues.map((queue) => queue.key)).toEqual([
      'futile-review',
      'service-approvals',
      'awaiting-po',
      'po-review',
    ]);
  });

  it('takes the counts from the count query, not from the page it fetched', async () => {
    // The lists are capped at 100 rows for the money; the count is the truth.
    queueCounts = { futileReview: 240, serviceApprovals: 3, awaitingPo: 1, poReview: 5 };

    const summary = await dashboardService.summary(caller('operations'));

    expect(summary.queues.find((queue) => queue.key === 'futile-review')?.count).toBe(240);
  });

  it('shows the age of the oldest waiting item', async () => {
    const summary = await dashboardService.summary(caller('operations'));
    const futile = summary.queues.find((queue) => queue.key === 'futile-review');

    // The August 2025 futile pickup is the entire reason this field exists.
    expect(futile?.oldestAt).toBe('2025-08-28T02:00:00.000Z');
  });

  it('reports a null age for an empty queue rather than today', async () => {
    futileRows = [];
    queueCounts = { ...queueCounts, futileReview: 0 };

    const summary = await dashboardService.summary(caller('operations'));

    expect(summary.queues.find((queue) => queue.key === 'futile-review')?.oldestAt).toBeNull();
  });

  it('carries no money for the queues that hold no money', async () => {
    const summary = await dashboardService.summary(caller('operations'));

    // A futile fee is per job and identical on each, so a queue total would
    // imply a single invoice that does not exist. An extraction is a proposal —
    // nothing is owed until a human confirms it into a purchase order.
    expect(summary.queues.find((queue) => queue.key === 'futile-review')?.valueExGst).toBeNull();
    expect(summary.queues.find((queue) => queue.key === 'po-review')?.valueExGst).toBeNull();
  });

  it('links each queue to the screen that works it', async () => {
    const summary = await dashboardService.summary(caller('operations'));

    expect(summary.queues.map((queue) => queue.href)).toEqual([
      '/queues/futile',
      '/queues/approvals',
      '/queues/awaiting-po',
      '/queues/po-review',
    ]);
  });

  it('asks for one row where it only needs a timestamp', async () => {
    await dashboardService.summary(caller('operations'));

    const futile = listQueriesSeen.find((query) => query.queue === 'futile');
    const poReview = listQueriesSeen.find((query) => query.queue === 'po-review');

    // Fetching a full page to read one date is a page nobody looks at.
    expect(futile?.pageSize).toBe(1);
    expect(poReview?.pageSize).toBe(1);
  });
});

/* ── Freshness ───────────────────────────────────────────────────────────── */

describe('generatedAt', () => {
  it('stamps the response so a stale tab is obvious', async () => {
    const before = Date.now();

    const summary = await dashboardService.summary(caller('operations'));

    expect(Date.parse(summary.generatedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(summary.generatedAt)).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
