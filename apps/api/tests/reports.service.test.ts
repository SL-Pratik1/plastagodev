import type { ReportFilters, Role } from '@plastago/shared';
import { ZONE } from './helpers/fake-settings.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Reporting (M9.1–M9.3, M9.6) and diversion certificates (M9.5 · F52).
 *
 * ── What is actually under test ───────────────────────────────────────────
 * Certificates, mostly. They go into builders' Green Star and NABERS
 * submissions, so the rules that matter are: the tonnage comes from the
 * WEIGHBRIDGE and never from the priced m², one job can never be certified
 * twice, and an issued certificate can never change.
 *
 * The reports themselves are tested for the arithmetic that would quietly be
 * wrong — a null weight reported as zero, a margin divided by nothing.
 */

let created: Array<Record<string, unknown>> = [];
let issued: Array<{ id: string; issuedTo: string | null; by: string }> = [];
let scopesSeen: Array<string | null> = [];
let filtersSeen: ReportFilters[] = [];

/** What the repository reports back. Set per test. */
let figures: { jobs: number; areaM2: number | null; weightKg: number; siteName: string | null } = {
  jobs: 3,
  areaM2: 2400,
  weightKg: 4250,
  siteName: 'Lot 214',
};
let certificateExists = false;
let storedCertificate: Record<string, unknown> | null = null;
let issueMatches = true;
let accountFound = true;

/** The site, pickup and docket a job-scoped certificate freezes. */
let jobContext: Record<string, unknown> | null = {
  jobNumber: 10_482,
  siteName: 'Lot 214',
  siteAddress: '42 Wattle St, Riverstone',
  collectedOn: '2026-09-02',
  docketNumber: 'WB-884213',
  tippedOffAt: new Date('2026-09-02T15:20:00.000Z'),
};

/** What the automatic path finds on a run. */
let certifiableJobs: Array<{ jobId: string; accountId: string; completedOn: string }> = [];

/** Null means the issued certificate has no rendered PDF yet. */
let storedPdfKey: string | null = 'certificates/cert1/pdf.pdf';
/** Makes the bucket refuse a write, so the "no PDF" path is real. */
let storageFails = false;
/** Makes the eligibility lookup blow up, so the never-throws claim is real. */
let certifiableJobsThrows = false;
let recordedPdfs: Array<{ id: string; key: string }> = [];
let storagePuts: string[] = [];
let sentEmails: Array<{ to: string; subject: string; attachments: number }> = [];

vi.mock('../src/domains/reports/report.repository.js', () => ({
  reportRepository: {
    volume: (filters: ReportFilters) => {
      filtersSeen.push(filters);
      return Promise.resolve([
        {
          key: 'acc1',
          label: 'Clarendon Homes',
          jobs: 4,
          areaM2: 3200.44,
          weightKg: 5200,
          bags: 6,
          chargesCents: 140_000,
        },
        {
          key: 'acc2',
          label: 'Wisdom Homes',
          jobs: 2,
          areaM2: 900,
          // An m²-only account — nothing was weighed.
          weightKg: null,
          bags: 0,
          chargesCents: 44_000,
        },
      ]);
    },
    byMonth: () =>
      Promise.resolve([{ month: '2026-09', jobs: 6, areaM2: 4100.44 }]),
    byZone: () =>
      Promise.resolve([
        { zoneId: ZONE.sydney, jobs: 4, areaM2: 3200, revenueCents: 140_000 },
        // A zone with no jobs — the average must not divide by zero.
        { zoneId: ZONE.newcastle, jobs: 0, areaM2: 0, revenueCents: 0 },
      ]),
    financial: () =>
      Promise.resolve([
        {
          key: 'acc1',
          label: 'Clarendon Homes',
          jobs: 4,
          baseRevenueCents: 140_000,
          additionalCents: 18_000,
        },
      ]),
    listCertificates: (_query: unknown, accountId: string | null) => {
      scopesSeen.push(accountId);
      return Promise.resolve({
        data: [],
        meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
      });
    },
    findCertificate: () => Promise.resolve(storedCertificate),
    certificateFigures: () => Promise.resolve(figures),
    createCertificate: (input: Record<string, unknown>) => {
      created.push(input);
      return Promise.resolve('cert1');
    },
    issueCertificate: (id: string, issuedTo: string | null, by: string) => {
      if (!issueMatches) return Promise.resolve(false);
      issued.push({ id, issuedTo, by });
      return Promise.resolve(true);
    },
    certificateExistsForJob: () => Promise.resolve(certificateExists),
    nextReferenceNumber: () => Promise.resolve(41),
    certificateJobContext: () => Promise.resolve(jobContext),
    certifiableJobsOnRun: () =>
      certifiableJobsThrows
        ? Promise.reject(new Error('mongo unavailable'))
        : Promise.resolve(certifiableJobs),
    certificateStorageKey: () => Promise.resolve(storedPdfKey),
    recordCertificatePdf: (id: string, key: string) => {
      recordedPdfs.push({ id, key });
      return Promise.resolve();
    },
  },
}));

vi.mock('../src/domains/accounts/account.repository.js', () => ({
  accountRepository: {
    findById: () =>
      Promise.resolve(
        accountFound
          ? {
              id: 'acc1',
              name: 'Clarendon Homes',
              certificateEmail: 'sustainability@clarendon.com.au',
            }
          : null,
      ),
  },
}));

vi.mock('../src/domains/settings/settings.repository.js', () => ({
  settingsRepository: {
    get: () =>
      Promise.resolve({
        pricing: { assumedCostPerJob: '100.00' },
        /*
         * The branding block a certificate prints. Real enough that the
         * renderer runs for real in these tests — the PDF is drawn, not
         * stubbed, so a layout change that throws is caught here.
         */
        invoicing: {
          logoKey: '',
          companyName: 'PlastaGo Pty Ltd',
          companyAbn: '51 824 753 556',
          companyAddress: '12 Example Rd, Sydney NSW 2000',
          companyPhone: '1300 395 438',
          companyEmail: 'info@plastago.com.au',
          termsText: '',
          footerText: '',
          bankBsb: '',
          bankAccount: '',
          bankAccountName: '',
          showGbcaBadge: true,
          certificateSignatureName: 'Matt Ryan',
          certificateSignatureTitle: 'Director',
          certificateSignatureKey: '',
        },
      }),
  },
}));

vi.mock('../src/integrations/storage.js', () => ({
  buildKey: (input: { ownerId: string }) => `certificates/${input.ownerId}/pdf.pdf`,
  getStorage: () => ({
    put: (key: string) => {
      if (storageFails) return Promise.reject(new Error('bucket unavailable'));
      storagePuts.push(key);
      return Promise.resolve();
    },
    get: () => Promise.resolve([Buffer.from('%PDF-1.7 stored')]),
    presignDownload: (key: string) => Promise.resolve(`https://storage.test/${key}?signed`),
  }),
}));

vi.mock('../src/integrations/messaging.js', () => ({
  getMailer: () => ({
    send: (email: { to: string; subject: string; attachments?: unknown[] }) => {
      sentEmails.push({
        to: email.to,
        subject: email.subject,
        attachments: email.attachments?.length ?? 0,
      });
      return Promise.resolve();
    },
  }),
}));

const { reportService } = await import('../src/domains/reports/report.service.js');

const OPERATIONS = {
  userId: 'usr0000000000000000000o1',
  name: 'Renee Alvarez',
  roles: ['operations'] as Role[],
  accountId: null,
};

const OFFICE = {
  userId: 'usr0000000000000000000f1',
  name: 'Priya Raman',
  roles: ['office-staff'] as Role[],
  accountId: null,
};

const CUSTOMER = {
  userId: 'usr0000000000000000000c1',
  name: 'Angela Fitzgerald',
  roles: ['customer-administrator'] as Role[],
  accountId: 'acc-mine',
};

function filters(overrides: Partial<ReportFilters> = {}): ReportFilters {
  return {
    from: '2026-09-01',
    to: '2026-09-30',
    accountId: null,
    suburb: null,
    zoneId: null,
    driverId: null,
    ...overrides,
  };
}

function certificate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cert1',
    reference: 'PG-CERT-2026-0041',
    scope: 'account',
    state: 'draft',
    accountId: 'acc1',
    accountName: 'Clarendon Homes',
    siteName: null,
    jobNumber: null,
    periodFrom: '2026-09-01',
    periodTo: '2026-09-30',
    jobs: 3,
    areaM2: 2400,
    tonnesDiverted: 4.3,
    weightBasis: 'weighed',
    siteAddress: null,
    collectedOn: null,
    docketNumber: null,
    tippedOffAt: null,
    issuedAt: null,
    issuedTo: null,
    issuedByName: null,
    hasPdf: false,
    ...overrides,
  };
}

beforeEach(() => {
  created = [];
  issued = [];
  scopesSeen = [];
  filtersSeen = [];
  figures = { jobs: 3, areaM2: 2400, weightKg: 4250, siteName: 'Lot 214' };
  certificateExists = false;
  storedCertificate = certificate();
  issueMatches = true;
  accountFound = true;
  jobContext = {
    jobNumber: 10_482,
    siteName: 'Lot 214',
    siteAddress: '42 Wattle St, Riverstone',
    collectedOn: '2026-09-02',
    docketNumber: 'WB-884213',
    tippedOffAt: new Date('2026-09-02T15:20:00.000Z'),
  };
  certifiableJobs = [];
  storedPdfKey = 'certificates/cert1/pdf.pdf';
  recordedPdfs = [];
  storagePuts = [];
  sentEmails = [];
  storageFails = false;
  certifiableJobsThrows = false;
});

describe('volume (M9.1)', () => {
  it('totals jobs, area and charges', async () => {
    const report = await reportService.monthlyVolume(filters(), OFFICE);

    expect(report.totalJobs).toBe(6);
    expect(report.totalAreaM2).toBe(4100.4);
    expect(report.totalChargesExGst).toBe('1840.00');
  });

  /*
   * ⚠️ Null, not zero. An m²-only account (M2.3) recovered kilograms nobody
   * measured — reporting 0 kg reads as "we diverted nothing", which is a
   * different and wrong claim.
   */
  it('reports null weight for an account that records none', async () => {
    const report = await reportService.monthlyVolume(filters(), OFFICE);

    expect(report.rows[0]?.weightKg).toBe(5200);
    expect(report.rows[1]?.weightKg).toBeNull();
  });

  it('refuses a backwards range', async () => {
    await expect(
      reportService.monthlyVolume(filters({ from: '2026-09-30', to: '2026-09-01' }), OFFICE),
    ).rejects.toMatchObject({ status: 422 });
  });

  /* An unbounded range is how one request aggregates every job ever done. */
  it('refuses a range longer than three years', async () => {
    await expect(
      reportService.monthlyVolume(filters({ from: '2016-01-01', to: '2026-01-01' }), OFFICE),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('zones (M9.3)', () => {
  it('averages job value per zone', async () => {
    const report = await reportService.zoneVolume(filters(), OFFICE);

    expect(report.rows[0]?.averageJobValueExGst).toBe('350.00');
  });

  /* Dividing by zero jobs renders NaN, which looks like a number. */
  it('does not divide by zero on an empty zone', async () => {
    const report = await reportService.zoneVolume(filters(), OFFICE);

    expect(report.rows[1]?.averageJobValueExGst).toBe('0.00');
  });
});

describe('financial (M9.6)', () => {
  it('splits base from additional and applies the assumed cost', async () => {
    const report = await reportService.financial(filters(), OPERATIONS);

    const row = report.byAccount[0];
    expect(row?.baseRevenueExGst).toBe('1400.00');
    expect(row?.additionalServicesExGst).toBe('180.00');
    expect(row?.totalRevenueExGst).toBe('1580.00');
    // 4 jobs × $100 assumed.
    expect(row?.assumedCostExGst).toBe('400.00');
    expect(row?.marginExGst).toBe('1180.00');
  });

  /*
   * ⚠️ The cost is an ASSUMPTION, surfaced so the screen can say so. A margin
   * presented as measured, on a cost nobody measured, is worse than none.
   */
  it('returns the assumed cost so the screen can label it', async () => {
    const report = await reportService.financial(filters(), OPERATIONS);

    expect(report.assumedCostPerJobExGst).toBe('100.00');
  });

  /* Margin is narrower than volume. */
  it('keeps office staff out of the margin report', async () => {
    await expect(reportService.financial(filters(), OFFICE)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('does not double-count by adding both groupings', async () => {
    const report = await reportService.financial(filters(), OPERATIONS);

    // Totalled from the account grouping only — the same jobs appear in both.
    expect(report.totalRevenueExGst).toBe('1580.00');
  });
});

describe('a customer cannot widen a report', () => {
  /*
   * ⚠️ A customer supplying somebody else's account id — or none, which is
   * everybody's — must not see past their own.
   */
  it('forces their own account onto the filters', async () => {
    await reportService.monthlyVolume(filters({ accountId: 'acc-someone-else' }), CUSTOMER);

    expect(filtersSeen[0]?.accountId).toBe('acc-mine');
  });

  it('forces it even when none was supplied', async () => {
    await reportService.monthlyVolume(filters({ accountId: null }), CUSTOMER);

    expect(filtersSeen[0]?.accountId).toBe('acc-mine');
  });

  it('fails closed when a customer session carries no account', async () => {
    await reportService.monthlyVolume(filters(), { ...CUSTOMER, accountId: null });

    expect(filtersSeen[0]?.accountId).toBe('000000000000000000000000');
  });

  it('scopes their certificate list to their own account', async () => {
    await reportService.certificates({ page: 1, pageSize: 20 }, CUSTOMER);

    expect(scopesSeen[0]).toBe('acc-mine');
  });

  it('does not scope the office', async () => {
    await reportService.certificates({ page: 1, pageSize: 20 }, OFFICE);

    expect(scopesSeen[0]).toBeNull();
  });
});

describe('⚠️ certificates (M9.5 · F52)', () => {
  /*
   * The tonnage is what an auditor checks. It comes from the reconciled
   * weighbridge figure (M4.4), never from the m² used for pricing.
   */
  it('converts the recovered weight to tonnes', async () => {
    figures = { jobs: 3, areaM2: 2400, weightKg: 4250, siteName: 'Lot 214' };

    await reportService.prepareCertificate(
      { scope: 'account', accountId: 'acc1', from: '2026-09-01', to: '2026-09-30' },
      OFFICE,
    );

    // 4,250 kg → 4.3 t.
    expect(created[0]?.tonnesDiverted).toBe(4.3);
  });

  /*
   * ⚠️ A certificate claiming nothing was diverted is worse than no
   * certificate — and it almost always means the tip-off is unreconciled.
   */
  it('refuses to certify when no weight has been recorded', async () => {
    figures = { jobs: 3, areaM2: 2400, weightKg: 0, siteName: 'Lot 214' };

    await expect(
      reportService.prepareCertificate(
        { scope: 'account', accountId: 'acc1', from: '2026-09-01', to: '2026-09-30' },
        OFFICE,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(created).toHaveLength(0);
  });

  it('refuses when there are no completed pickups at all', async () => {
    figures = { jobs: 0, areaM2: null, weightKg: 0, siteName: null };

    await expect(
      reportService.prepareCertificate(
        { scope: 'account', accountId: 'acc1', from: '2026-09-01', to: '2026-09-30' },
        OFFICE,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  /*
   * ⚠️ Matt, 31:04 — a fixed-price builder's POs carry no square metres. The
   * certificate is still valid; the auditable figure is the tonnage. A zero
   * would claim they installed no plasterboard.
   */
  it('issues a valid certificate with no area at all', async () => {
    figures = { jobs: 2, areaM2: null, weightKg: 3100, siteName: null };

    await reportService.prepareCertificate(
      { scope: 'account', accountId: 'acc1', from: '2026-09-01', to: '2026-09-30' },
      OFFICE,
    );

    expect(created[0]?.areaM2).toBeNull();
    expect(created[0]?.tonnesDiverted).toBe(3.1);
  });

  /*
   * ⚠️ Two certificates for one pickup would let the same tonnage be claimed
   * twice in two different Green Star submissions.
   */
  it('refuses a second certificate for the same job', async () => {
    certificateExists = true;

    await expect(
      reportService.prepareCertificate(
        {
          scope: 'job',
          accountId: 'acc1',
          from: '2026-09-01',
          to: '2026-09-30',
          jobId: 'job1',
        },
        OFFICE,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(created).toHaveLength(0);
  });

  it('always creates a draft, never an issued one', async () => {
    await reportService.prepareCertificate(
      { scope: 'account', accountId: 'acc1', from: '2026-09-01', to: '2026-09-30' },
      OFFICE,
    );

    // Draft first, so somebody can notice an unreconciled tip-off before the
    // figures freeze.
    expect(created[0]).not.toHaveProperty('state');
    expect(created[0]?.reference).toBe('PG-CERT-2026-0041');
  });

  it('refuses a backwards period', async () => {
    await expect(
      reportService.prepareCertificate(
        { scope: 'account', accountId: 'acc1', from: '2026-09-30', to: '2026-09-01' },
        OFFICE,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('issuing freezes it', () => {
  /*
   * Matt, 31:04 — certificates go to a different team from invoices. Sending a
   * sustainability document to accounts payable is how it gets ignored.
   */
  it('sends it to the certificate address, not the accounts one', async () => {
    await reportService.issueCertificate('cert1', OFFICE);

    expect(issued[0]?.issuedTo).toBe('sustainability@clarendon.com.au');
  });

  /*
   * ⚠️ An issued certificate is a document somebody has put into a Green Star
   * pack. Changing its figures afterwards leaves that copy disagreeing with
   * ours.
   */
  it('refuses to re-issue one', async () => {
    storedCertificate = certificate({ state: 'issued', issuedAt: '2026-09-15T00:00:00.000Z' });

    await expect(reportService.issueCertificate('cert1', OFFICE)).rejects.toMatchObject({
      status: 409,
    });

    expect(issued).toHaveLength(0);
  });

  it('refuses when somebody issued it mid-flow', async () => {
    issueMatches = false;

    await expect(reportService.issueCertificate('cert1', OFFICE)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('404s one that does not exist', async () => {
    storedCertificate = null;

    await expect(reportService.issueCertificate('cert1', OFFICE)).rejects.toMatchObject({
      status: 404,
    });
  });
});

/**
 * M9.5 — what the document itself carries.
 *
 * These are the fields that make a certificate checkable by somebody who does
 * not work here: the docket the load was tipped against, the site as an
 * assessor would recognise it, and the statement that the tonnage was weighed
 * rather than worked out.
 */
describe('the frozen audit trail', () => {
  it('freezes the pickup, the site address and the docket onto the draft', async () => {
    await reportService.prepareCertificate(
      { scope: 'job', accountId: 'acc1', from: '2026-09-02', to: '2026-09-02', jobId: 'job1' },
      OFFICE,
    );

    expect(created[0]).toMatchObject({
      jobNumber: 10_482,
      siteAddress: '42 Wattle St, Riverstone',
      collectedOn: '2026-09-02',
      docketNumber: 'WB-884213',
      weightBasis: 'weighed',
    });
  });

  /*
   * The bug this pins: `jobNumber` was hard-coded to null on every certificate
   * ever created, so the portal printed "Pickup #—" on all of them.
   */
  it('never writes a null pickup number when the job has one', async () => {
    await reportService.prepareCertificate(
      { scope: 'job', accountId: 'acc1', from: '2026-09-02', to: '2026-09-02', jobId: 'job1' },
      OFFICE,
    );

    expect(created[0]?.jobNumber).not.toBeNull();
  });

  it('still prepares one where the run carries no docket', async () => {
    jobContext = {
      jobNumber: 10_482,
      siteName: 'Lot 214',
      siteAddress: '42 Wattle St, Riverstone',
      collectedOn: '2026-09-02',
      docketNumber: null,
      tippedOffAt: null,
    };

    await reportService.prepareCertificate(
      { scope: 'job', accountId: 'acc1', from: '2026-09-02', to: '2026-09-02', jobId: 'job1' },
      OFFICE,
    );

    // A missing docket costs the certificate one line, never the certificate.
    expect(created).toHaveLength(1);
    expect(created[0]?.docketNumber).toBeNull();
  });
});

/**
 * Issuing is what puts the document in front of the customer.
 *
 * The PDF is rendered for REAL in these tests — `pdf-lib` draws it and the
 * bytes are stored — so a layout change that throws on a null area or an
 * unusual figure fails here rather than on a builder's submission.
 */
describe('issuing delivers the document', () => {
  it('renders the PDF, stores it and emails the certificate address', async () => {
    storedPdfKey = null; // Nothing rendered yet — issuing is what produces it.
    storedCertificate = certificate({ issuedTo: 'sustainability@clarendon.com.au' });

    await reportService.issueCertificate('cert1', OFFICE);

    expect(storagePuts).toHaveLength(1);
    expect(recordedPdfs[0]).toMatchObject({ id: 'cert1' });
    expect(sentEmails[0]).toMatchObject({
      to: 'sustainability@clarendon.com.au',
      attachments: 1,
    });
  });

  /*
   * Matt, 31:04 — certificates go to a different team from invoices. With no
   * address on the account the document waits in the portal; it must never
   * fall back to accounts payable, which is where it goes to be ignored.
   */
  it('issues without emailing when the account has no certificate address', async () => {
    storedCertificate = certificate({ issuedTo: null });

    await reportService.issueCertificate('cert1', OFFICE);

    expect(issued).toHaveLength(1);
    expect(sentEmails).toHaveLength(0);
  });

  /*
   * ⚠️ The transition is already written and the office has been told about
   * it. Storage being unavailable cannot be allowed to undo that.
   */
  it('still issues and still writes when the render fails outright', async () => {
    storedPdfKey = null;
    storageFails = true;
    storedCertificate = certificate({ issuedTo: 'sustainability@clarendon.com.au' });

    await expect(reportService.issueCertificate('cert1', OFFICE)).resolves.toBeTruthy();

    expect(issued).toHaveLength(1);

    /*
     * The email still goes, carrying no attachment — the covering text adapts
     * and the portal link still works. Silence would leave the customer
     * knowing nothing about a certificate that has in fact been issued.
     */
    expect(sentEmails[0]).toMatchObject({ attachments: 0 });
  });

  /*
   * ⚠️ The fixed-price builder's case (Matt, 31:04): their purchase orders
   * carry no area at all. The document must still render — it prints "Not
   * supplied" rather than a zero, which would claim they installed no
   * plasterboard — and this is the input that would throw if it did not.
   */
  it('renders a certificate for a job with no recorded area', async () => {
    storedPdfKey = null;
    storedCertificate = certificate({
      areaM2: null,
      issuedTo: 'sustainability@clarendon.com.au',
    });

    await reportService.issueCertificate('cert1', OFFICE);

    expect(storagePuts).toHaveLength(1);
    expect(sentEmails[0]).toMatchObject({ attachments: 1 });
  });

  it('refuses to resend one that was never issued', async () => {
    storedCertificate = certificate({ state: 'draft' });

    await expect(reportService.resendCertificate('cert1', OFFICE)).rejects.toMatchObject({
      status: 409,
    });
  });

  /*
   * A resend must put the SAME file in front of the customer. Rendering a new
   * one would defeat the freeze the document itself claims.
   */
  it('resends the stored document rather than rendering a new one', async () => {
    storedCertificate = certificate({
      state: 'issued',
      issuedTo: 'sustainability@clarendon.com.au',
    });

    await reportService.resendCertificate('cert1', OFFICE);

    expect(storagePuts).toHaveLength(0);
    expect(sentEmails).toHaveLength(1);
  });
});

/** The download link, and who is allowed one. */
describe('downloading the PDF', () => {
  it('mints a short-lived link for an issued certificate', async () => {
    storedCertificate = certificate({ state: 'issued' });

    const result = await reportService.certificatePdfUrl('cert1', OFFICE);

    expect(result.url).toContain('signed');
  });

  /*
   * A draft's figures are still allowed to move. Handing somebody a document
   * drawn from them would produce a certificate that disagrees with the one
   * eventually issued.
   */
  it('refuses a draft', async () => {
    storedCertificate = certificate({ state: 'draft' });

    await expect(reportService.certificatePdfUrl('cert1', OFFICE)).rejects.toMatchObject({
      status: 409,
    });
  });

  /*
   * Issued while storage was down: the figures are frozen and valid, so the
   * first download renders the missing document rather than refusing it.
   */
  it('renders on demand when an issued certificate has no stored PDF', async () => {
    storedCertificate = certificate({ state: 'issued' });
    storedPdfKey = null;

    const result = await reportService.certificatePdfUrl('cert1', OFFICE);

    expect(storagePuts).toHaveLength(1);
    expect(result.url).toContain('signed');
  });

  it('404s a certificate belonging to another customer', async () => {
    storedCertificate = null;

    await expect(reportService.certificatePdfUrl('cert1', CUSTOMER)).rejects.toMatchObject({
      status: 404,
    });
  });
});

/**
 * The automatic path (M9.5), fired by a driver's tip-off.
 *
 * ⚠️ The rule it must never break: it cannot throw. It runs on the back of a
 * reconciliation that is already written, and a driver at a weighbridge must
 * not see a failure because a certificate could not be drafted.
 */
describe('automatic drafts from a tip-off', () => {
  it('prepares one draft per eligible job on the run', async () => {
    certifiableJobs = [
      { jobId: 'job1', accountId: 'acc1', completedOn: '2026-09-02' },
      { jobId: 'job2', accountId: 'acc1', completedOn: '2026-09-02' },
    ];

    const result = await reportService.autoPrepareForRun('run1');

    expect(result.prepared).toBe(2);
    expect(created).toHaveLength(2);
    // Job-scoped and bounded to the collection day, not to a month.
    expect(created[0]).toMatchObject({ scope: 'job', periodFrom: '2026-09-02' });
  });

  it('prepares nothing when no stop was crane-weighed', async () => {
    certifiableJobs = [];

    const result = await reportService.autoPrepareForRun('run1');

    expect(result.prepared).toBe(0);
    expect(created).toHaveLength(0);
  });

  /*
   * One bad stop must not cost the others theirs — the loop catches per job.
   */
  it('skips a job that cannot be certified and keeps going', async () => {
    certifiableJobs = [
      { jobId: 'job1', accountId: 'acc1', completedOn: '2026-09-02' },
      { jobId: 'job2', accountId: 'acc1', completedOn: '2026-09-02' },
    ];
    certificateExists = true; // Every one of them already has a certificate.

    const result = await reportService.autoPrepareForRun('run1');

    expect(result.prepared).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('never throws when the lookup itself fails', async () => {
    certifiableJobsThrows = true;

    await expect(reportService.autoPrepareForRun('run1')).resolves.toEqual({ prepared: 0 });
  });
});
