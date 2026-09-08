import type { PortalBookingDraft, Role } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The customer portal (M5).
 *
 * ── What is actually under test ───────────────────────────────────────────
 * Isolation, and the two rules that hang off it. A builder must never see
 * another builder's work — that would expose what a competitor pays. And a site
 * supervisor must never RECEIVE a price, not merely be prevented from
 * displaying one (M1.5).
 *
 * The third theme is M5.4's editability rule: a booking is the customer's until
 * it reaches a run sheet, and after that it belongs to the operation.
 */

interface CertifyCall {
  jobId: string;
  jobReady: boolean;
  truckAccessible: boolean;
  freeOfContaminants: boolean;
  certifiedByName: string;
}

let scopesSeen: Array<{ accountId: string; bookedByUserId: string | null }> = [];
let pricingSeen: boolean[] = [];
let certified: CertifyCall[] = [];
let changeRequests: Array<{ jobId: string; kind: string; requestedDate: string | null }> = [];
let jobDrafts: Array<Record<string, unknown>> = [];
let edits: Array<Record<string, unknown>> = [];

/** What the repository reports back. Set per test. */
let jobEditable = true;
let jobStatus = 'booked';
let jobFound = true;
let editApplied = true;
let urgencyApplied = true;
let hasOpenRequest = false;

const ACCOUNT = {
  id: 'acc0000000000000000000a1',
  name: 'Clarendon Homes',
  code: 'CLA001',
  accountType: 'builder' as const,
  captureMode: 'area-and-weight' as 'area-and-weight' | 'area-only',
  poPolicy: 'required-before-invoice' as 'required-before-invoice' | 'not-required',
  status: 'active' as 'active' | 'inactive',
};

vi.mock('../src/domains/portal/portal.repository.js', () => ({
  portalRepository: {
    listJobs: (
      _query: unknown,
      scope: { accountId: string; bookedByUserId: string | null },
      canSeePricing: boolean,
    ) => {
      scopesSeen.push(scope);
      pricingSeen.push(canSeePricing);
      return Promise.resolve({
        data: [],
        meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
      });
    },
    findJob: (
      _id: string,
      scope: { accountId: string; bookedByUserId: string | null },
      canSeePricing: boolean,
    ) => {
      scopesSeen.push(scope);
      pricingSeen.push(canSeePricing);
      return Promise.resolve(
        jobFound
          ? {
              id: 'job1',
              jobNumber: 61_400,
              status: jobStatus,
              totalIncGst: canSeePricing ? '386.93' : null,
              editable: jobEditable,
            }
          : null,
      );
    },
    dashboardCounts: (scope: { accountId: string; bookedByUserId: string | null }) => {
      scopesSeen.push(scope);
      return Promise.resolve({
        openJobs: 3,
        atRiskJobs: 1,
        completedThisMonth: 8,
        areaThisMonthM2: 6400,
        weightThisMonthKg: 4250,
        awaitingReadiness: 2,
        nextPickup: null,
      });
    },
    outstandingInvoices: () => Promise.resolve({ count: 2, totalIncGst: '773.86' }),
    findJobForEdit: () =>
      Promise.resolve(
        jobFound ? { id: 'job1', status: jobStatus, editable: jobEditable, runId: null } : null,
      ),
    editJob: (_id: string, _scope: unknown, input: Record<string, unknown>) => {
      if (!editApplied) return Promise.resolve(false);
      edits.push(input);
      return Promise.resolve(true);
    },
    setUrgency: () => Promise.resolve(urgencyApplied),
    certify: (input: CertifyCall) => {
      certified.push(input);
      return Promise.resolve();
    },
    requestChange: (input: { jobId: string; kind: string; requestedDate: string | null }) => {
      changeRequests.push(input);
      return Promise.resolve('req1');
    },
    hasOpenChangeRequest: () => Promise.resolve(hasOpenRequest),
  },
}));

vi.mock('../src/domains/accounts/account.repository.js', () => ({
  accountRepository: { findById: () => Promise.resolve({ ...ACCOUNT }) },
}));

vi.mock('../src/domains/settings/settings.repository.js', () => ({
  settingsRepository: {
    get: () =>
      Promise.resolve({
        general: { slaBusinessDays: 5 },
        invoicing: { invoiceNumberPrefix: 'PGA-' },
      }),
  },
}));

vi.mock('../src/domains/jobs/job.service.js', () => ({
  jobService: {
    create: (draft: Record<string, unknown>) => {
      jobDrafts.push(draft);
      return Promise.resolve({ id: 'job1', jobNumber: 61_400 });
    },
    preview: (draft: Record<string, unknown>) => {
      jobDrafts.push(draft);
      return Promise.resolve({ subtotalExGst: '351.75', totalIncGst: '386.93' });
    },
  },
}));

const { portalService } = await import('../src/domains/portal/portal.service.js');

const ADMIN = {
  userId: 'usr0000000000000000000c1',
  name: 'Angela Fitzgerald',
  roles: ['customer-administrator'] as Role[],
  accountId: ACCOUNT.id,
};

const SUPERVISOR = {
  userId: 'usr0000000000000000000s1',
  name: 'Dave Nguyen',
  roles: ['customer-site-supervisor'] as Role[],
  accountId: ACCOUNT.id,
};

const CERTIFICATION = {
  jobReady: true as const,
  truckAccessible: true as const,
  freeOfContaminants: true as const,
};

function draft(overrides: Partial<PortalBookingDraft> = {}): PortalBookingDraft {
  return {
    siteName: 'Lot 214 Allambie Circuit',
    lotNumber: '214',
    addressLine: '46 Allambie Circuit',
    placeId: 'kellyville',
    builderName: 'GJ Gardner',
    accessNotes: '',
    gateHours: '',
    inductionRequired: false,
    craneAvailable: false,
    siteContactName: '',
    siteContactMobile: '',
    siteContactEmail: '',
    readyDate: '2026-10-05',
    expectedAreaM2: 823.41,
    bagCount: 0,
    serviceLevel: 'standard',
    poNumber: 'PO-88213',
    notes: '',
    certification: CERTIFICATION,
    ...overrides,
  };
}

beforeEach(() => {
  scopesSeen = [];
  pricingSeen = [];
  certified = [];
  changeRequests = [];
  jobDrafts = [];
  edits = [];
  jobEditable = true;
  jobStatus = 'booked';
  jobFound = true;
  editApplied = true;
  urgencyApplied = true;
  hasOpenRequest = false;
  ACCOUNT.poPolicy = 'required-before-invoice';
  ACCOUNT.captureMode = 'area-and-weight';
  ACCOUNT.status = 'active';
});

describe('a customer sees their own account and nothing else', () => {
  it('scopes an administrator to the whole account', async () => {
    await portalService.jobs({ page: 1, pageSize: 20 }, ADMIN);

    expect(scopesSeen[0]).toEqual({ accountId: ACCOUNT.id, bookedByUserId: null });
  });

  /*
   * Matt, 18:15: *"site supervisors can submit their jobs and be able to see
   * the jobs they've submitted."* This replaces the site-list scoping of M1.5,
   * which went with the sites.
   */
  it('scopes a site supervisor to the jobs they raised', async () => {
    await portalService.jobs({ page: 1, pageSize: 20 }, SUPERVISOR);

    expect(scopesSeen[0]).toEqual({
      accountId: ACCOUNT.id,
      bookedByUserId: SUPERVISOR.userId,
    });
  });

  it('gives a supervisor who is also an administrator the wider view', async () => {
    await portalService.jobs(
      { page: 1, pageSize: 20 },
      { ...SUPERVISOR, roles: ['customer-site-supervisor', 'customer-administrator'] },
    );

    expect(scopesSeen[0]?.bookedByUserId).toBeNull();
  });

  /* A customer-role session with no account is broken, not permissive. */
  it('refuses a session not linked to an account', async () => {
    await expect(
      portalService.jobs({ page: 1, pageSize: 20 }, { ...ADMIN, accountId: null }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a suspended account with something a human can act on', async () => {
    ACCOUNT.status = 'inactive';

    await expect(portalService.dashboard(ADMIN)).rejects.toMatchObject({ status: 403 });
  });

  it('404s a job outside the scope rather than 403', async () => {
    jobFound = false;

    // A 403 would confirm another customer's job exists.
    await expect(portalService.job('a'.repeat(24), ADMIN)).rejects.toMatchObject({ status: 404 });
  });
});

describe('a site supervisor never receives a price (M1.5)', () => {
  /*
   * ⚠️ Nulled by the SERVER, not hidden in the UI. A role check in the browser
   * still ships the figure into the network tab and any cached response.
   */
  it('asks the repository to withhold pricing for a supervisor', async () => {
    await portalService.jobs({ page: 1, pageSize: 20 }, SUPERVISOR);

    expect(pricingSeen[0]).toBe(false);
  });

  it('allows pricing for an administrator', async () => {
    await portalService.jobs({ page: 1, pageSize: 20 }, ADMIN);

    expect(pricingSeen[0]).toBe(true);
  });

  it('refuses a quote outright for a supervisor', async () => {
    await expect(portalService.quote(draft(), SUPERVISOR)).rejects.toMatchObject({ status: 403 });

    // And never reached the pricing engine at all.
    expect(jobDrafts).toHaveLength(0);
  });

  it('gives an administrator the quote', async () => {
    await expect(portalService.quote(draft(), ADMIN)).resolves.toMatchObject({
      totalIncGst: '386.93',
    });
  });

  it('shows outstanding money to an administrator only', async () => {
    const forAdmin = await portalService.dashboard(ADMIN);
    const forSupervisor = await portalService.dashboard(SUPERVISOR);

    expect(forAdmin.outstandingInvoiceTotalIncGst).toBe('773.86');
    // Null, not zero — zero would read as "nothing outstanding".
    expect(forSupervisor.outstandingInvoiceTotalIncGst).toBeNull();
    expect(forSupervisor.outstandingInvoiceCount).toBeNull();
  });
});

describe('booking (M5.1)', () => {
  it('books against the session’s account, never a supplied one', async () => {
    await portalService.book(draft(), SUPERVISOR);

    // The account is absent from the form BY DESIGN — a free-text account name
    // is exactly why leads arrive disguised as jobs.
    expect(jobDrafts[0]?.accountId).toBe(ACCOUNT.id);
  });

  it('files the three certifications against the job', async () => {
    await portalService.book(draft(), SUPERVISOR);

    expect(certified[0]).toMatchObject({
      jobId: 'job1',
      jobReady: true,
      truckAccessible: true,
      freeOfContaminants: true,
      certifiedByName: 'Dave Nguyen',
    });
  });

  /*
   * M2.10 — asked while the builder is filling in the form, not three weeks
   * later when the invoice will not go out.
   */
  it('refuses to book without a PO where the account requires one', async () => {
    await expect(portalService.book(draft({ poNumber: '  ' }), ADMIN)).rejects.toMatchObject({
      status: 422,
    });
  });

  it('books without a PO where the account does not require one', async () => {
    ACCOUNT.poPolicy = 'not-required';

    await expect(portalService.book(draft({ poNumber: '' }), ADMIN)).resolves.toBeDefined();
  });

  /*
   * ⚠️ Matt, 29:21 — a supervisor books without knowing the area: *"they're
   * running the site, they're not going to know it's 823.4 square metres."*
   * Null means the PO has it. Zero would say the job is empty.
   */
  it('accepts a booking with no area, because the PO carries it', async () => {
    await expect(
      portalService.book(draft({ expectedAreaM2: null }), SUPERVISOR),
    ).resolves.toBeDefined();
  });

  it('refuses a half-completed certification', async () => {
    await expect(
      portalService.book(
        draft({
          certification: { ...CERTIFICATION, truckAccessible: false as unknown as true },
        }),
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 422 });

    expect(certified).toHaveLength(0);
  });
});

describe('changing a booking (M5.4)', () => {
  it('edits a job that has not reached a run sheet', async () => {
    await portalService.editJob(
      'job1',
      {
        readyDate: '2026-10-12',
        expectedAreaM2: 900,
        bagCount: 2,
        serviceLevel: 'standard',
        poNumber: 'PO-88213',
        notes: '',
      },
      ADMIN,
    );

    expect(edits[0]).toMatchObject({ readyDate: '2026-10-12', expectedAreaM2: 900 });
  });

  it('restarts the SLA clock from the new ready date', async () => {
    await portalService.editJob(
      'job1',
      {
        // A Monday.
        readyDate: '2026-10-05',
        expectedAreaM2: 900,
        bagCount: 0,
        serviceLevel: 'standard',
        poNumber: '',
        notes: '',
      },
      ADMIN,
    );

    // Five BUSINESS days — the following Monday, not the Saturday.
    expect(edits[0]?.targetDate).toBe('2026-10-12');
  });

  /*
   * The client's own rule. After allocation the driver has it and the day is
   * planned around it — a silent edit would change work somebody is holding.
   */
  it('refuses a direct edit once the job is allocated', async () => {
    jobEditable = false;

    await expect(
      portalService.editJob(
        'job1',
        {
          readyDate: '2026-10-12',
          expectedAreaM2: 900,
          bagCount: 0,
          serviceLevel: 'standard',
          poNumber: '',
          notes: '',
        },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses when the allocator claims it mid-edit', async () => {
    editApplied = false;

    await expect(
      portalService.editJob(
        'job1',
        {
          readyDate: '2026-10-12',
          expectedAreaM2: 900,
          bagCount: 0,
          serviceLevel: 'standard',
          poNumber: '',
          notes: '',
        },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('routes a reschedule to the office as a request', async () => {
    await portalService.requestChange(
      'job1',
      { kind: 'reschedule', requestedDate: '2026-10-20', note: 'Plasterer running late' },
      ADMIN,
    );

    expect(changeRequests[0]).toMatchObject({
      kind: 'reschedule',
      requestedDate: '2026-10-20',
    });
  });

  it('refuses a reschedule with no date', async () => {
    await expect(
      portalService.requestChange(
        'job1',
        { kind: 'reschedule', requestedDate: null, note: 'Move it' },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('does not carry a date onto a cancellation request', async () => {
    await portalService.requestChange(
      'job1',
      { kind: 'cancel', requestedDate: '2026-10-20', note: 'Builder pulled the job' },
      ADMIN,
    );

    expect(changeRequests[0]?.requestedDate).toBeNull();
  });

  /* A second identical ask makes the queue longer, not the office faster. */
  it('refuses a second open request on the same job', async () => {
    hasOpenRequest = true;

    await expect(
      portalService.requestChange('job1', { kind: 'other', requestedDate: null, note: 'x' }, ADMIN),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('readiness (M5.2)', () => {
  it('records a re-confirmation as a new record', async () => {
    await portalService.certifyReadiness('job1', CERTIFICATION, ADMIN);

    // Append-only: "what did they promise, and when" is the question an invoice
    // dispute asks, and an editable record cannot answer it.
    expect(certified).toHaveLength(1);
    expect(certified[0]?.certifiedByName).toBe('Angela Fitzgerald');
  });

  it('refuses to certify a finished pickup', async () => {
    jobStatus = 'completed';

    await expect(
      portalService.certifyReadiness('job1', CERTIFICATION, ADMIN),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('the dashboard (M5.7)', () => {
  it('reports tonnes for an account that records weight', async () => {
    const dashboard = await portalService.dashboard(ADMIN);

    // 4,250 kg → 4.3 t.
    expect(dashboard.tonnesThisMonth).toBe(4.3);
  });

  /*
   * ⚠️ Null on an m²-only account, not zero. A zero would read as "we recovered
   * nothing this month" to a customer who never buys weight capture (M2.3).
   */
  it('reports null tonnes for an m²-only account', async () => {
    ACCOUNT.captureMode = 'area-only';

    const dashboard = await portalService.dashboard(ADMIN);

    expect(dashboard.tonnesThisMonth).toBeNull();
    expect(dashboard.areaThisMonthM2).toBe(6400);
  });

  it('surfaces the unconfirmed-readiness count', async () => {
    // M8.3 — the direct attack on futile pickups.
    const dashboard = await portalService.dashboard(ADMIN);

    expect(dashboard.awaitingReadinessConfirmation).toBe(2);
  });
});

describe('the scope call', () => {
  it('tells the UI a supervisor sees only their own jobs', async () => {
    const scope = await portalService.scope(SUPERVISOR);

    expect(scope.visibility).toBe('own-jobs');
    expect(scope.canSeePricing).toBe(false);
  });

  it('carries the office’s invoice prefix so the customer can quote it back', async () => {
    const scope = await portalService.scope(ADMIN);

    // Matt, 7:07 — the customer quotes the same number when they pay.
    expect(scope.invoiceNumberPrefix).toBe('PGA-');
    expect(scope.visibility).toBe('account');
  });
});
