import type { PoConfirmation, Role } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M2.12 — AI purchase-order review.
 *
 * ── What is actually under test ───────────────────────────────────────────
 * Risk 9's rule: **never silently guess.** These tests exist to make sure a
 * model can never write a purchase order — only a human confirming one can.
 *
 * A wrong PO number landing on an invoice is rejected by the builder's accounts
 * system weeks later and nobody knows why. The confirmation step IS the product,
 * so the tests are about what happens when the extractor is confident, when two
 * reviewers collide, and whether the correction rate is actually recorded.
 */

interface IngestCall {
  reason: string;
  overallConfidence: number;
  poNumber: string | null;
}

interface ConfirmCall {
  extractionId: string;
  correctedFields: string[];
  order: { poNumber: string; accountId: string; expectedAreaM2: number | null };
}

let ingested: IngestCall[] = [];
let confirmed: ConfirmCall[] = [];
let rejected: Array<{ id: string; note: string }> = [];

/** The stored extraction the service reads back. Set per test. */
let stored: Record<string, unknown> | null = null;
let duplicateExists = false;
let confirmMatches = true;
let rejectMatches = true;
let accountFound = true;

vi.mock('../src/domains/queues/po-extraction.repository.js', () => ({
  poExtractionRepository: {
    list: () =>
      Promise.resolve({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } }),
    findById: () => Promise.resolve(stored),
    findStorageKey: () => Promise.resolve('purchase-orders/x/doc.pdf'),
    ingest: (input: IngestCall) => {
      ingested.push(input);
      return Promise.resolve('ext1');
    },
    isDuplicate: () => Promise.resolve(duplicateExists),
    confirm: (input: ConfirmCall) => {
      if (!confirmMatches) return Promise.resolve(null);
      confirmed.push(input);
      return Promise.resolve({ purchaseOrderId: 'po1' });
    },
    reject: (input: { id: string; note: string }) => {
      if (!rejectMatches) return Promise.resolve(false);
      rejected.push(input);
      return Promise.resolve(true);
    },
    countNeedingReview: () => Promise.resolve(4),
  },
}));

vi.mock('../src/domains/accounts/account.repository.js', () => ({
  accountRepository: {
    findById: () =>
      Promise.resolve(accountFound ? { id: 'acc1', name: 'Domain Homes' } : null),
  },
}));

vi.mock('../src/integrations/storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/integrations/storage.js')>();
  return {
    ...actual,
    getStorage: () => ({
      name: 'test',
      presignDownload: (key: string) => Promise.resolve(`https://example.test/${key}`),
      presignUpload: () => Promise.reject(new Error('not used')),
      put: () => Promise.resolve(),
      get: () => Promise.reject(new Error('not used')),
      remove: () => Promise.resolve(),
      exists: () => Promise.resolve(true),
    }),
  };
});

const { poReviewService } = await import('../src/domains/queues/po-review.service.js');

const OFFICE = {
  userId: 'usr0000000000000000000f1',
  name: 'Priya Raman',
  roles: ['office-staff'] as Role[],
};

const DRIVER = {
  userId: 'usr0000000000000000000d1',
  name: 'Troy Holm',
  roles: ['driver'] as Role[],
};

const ID = 'a'.repeat(24);

/** What Matt read off the Domain purchase order at 28:12. */
function extraction(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    fromAddress: 'orders@domain.com.au',
    subject: 'Purchase Order 4500123456',
    receivedAt: '2026-06-01T02:00:00.000Z',
    attachmentName: 'PO-4500123456.pdf',
    pageCount: 1,
    poNumber: '4500123456',
    suggestedAccountId: 'acc1',
    suggestedAccountName: 'Domain Homes',
    suggestedJobId: null,
    suggestedJobNumber: null,
    amountExGst: '351.75',
    extractedAreaM2: 823.41,
    extractedBagAllowance: 2,
    extractedSiteAddress: '46 Allambie Circuit',
    extractedLotNumber: '214',
    extractedSupervisorName: 'Matthew French',
    extractedSupervisorMobile: '0412345678',
    overallConfidence: 0.97,
    reason: 'no-job-match',
    state: 'needs-review',
    documentText: '',
    fields: [],
    accountCandidates: [],
    jobCandidates: [],
    reviewedAt: null,
    reviewedBy: null,
    ...overrides,
  };
}

function confirmation(overrides: Partial<PoConfirmation> = {}): PoConfirmation {
  return {
    poNumber: '4500123456',
    accountId: 'acc1',
    jobId: null,
    expectedAreaM2: 823.41,
    bagAllowance: 2,
    lotNumber: '214',
    addressLine: '46 Allambie Circuit',
    suburb: 'Kellyville',
    siteSupervisorName: 'Matthew French',
    siteSupervisorMobile: '0412345678',
    amountExGst: '351.75',
    ...overrides,
  };
}

function ingestInput(overrides: Record<string, unknown> = {}) {
  return {
    fromAddress: 'orders@domain.com.au',
    subject: 'Purchase Order 4500123456',
    receivedAt: new Date('2026-06-01T02:00:00.000Z'),
    attachmentName: 'PO-4500123456.pdf',
    pageCount: 1,
    storageKey: 'purchase-orders/x/doc.pdf',
    documentText: '',
    poNumber: '4500123456',
    amountExGst: '351.75',
    extractedAreaM2: 823.41,
    extractedBagAllowance: 2,
    extractedSiteAddress: '46 Allambie Circuit',
    extractedLotNumber: '214',
    extractedSupervisorName: 'Matthew French',
    extractedSupervisorMobile: '0412345678',
    fields: [],
    suggestedAccountId: 'acc1',
    suggestedAccountName: 'Domain Homes',
    suggestedJobId: null,
    suggestedJobNumber: null,
    accountCandidates: [{ id: 'acc1', label: 'Domain Homes', detail: '', confidence: 0.98 }],
    jobCandidates: [],
    overallConfidence: 0.97,
    reason: 'below-threshold' as const,
    ...overrides,
  };
}

beforeEach(() => {
  ingested = [];
  confirmed = [];
  rejected = [];
  stored = extraction();
  duplicateExists = false;
  confirmMatches = true;
  rejectMatches = true;
  accountFound = true;
});

describe('an extraction is never trusted', () => {
  /*
   * ⚠️ The central rule. Even a 0.99-confidence extraction with a matched
   * account goes to a human, because the document authorises invoicing.
   */
  it('sends a high-confidence extraction to review anyway', async () => {
    await poReviewService.ingest(ingestInput({ overallConfidence: 0.99 }));

    expect(ingested).toHaveLength(1);
    // Nothing was written as a purchase order.
    expect(confirmed).toHaveLength(0);
  });

  /*
   * The extractor reports its own confidence. Letting it also declare the
   * review reason would put a vendor in charge of whether a human ever looks.
   */
  it('decides the review reason itself, ignoring what the caller sent', async () => {
    await poReviewService.ingest(
      ingestInput({ suggestedAccountId: null, reason: 'below-threshold' }),
    );

    expect(ingested[0]?.reason).toBe('no-account-match');
  });

  it('flags a low-confidence read as below threshold', async () => {
    await poReviewService.ingest(
      ingestInput({ overallConfidence: 0.6, suggestedJobId: 'job1' }),
    );

    expect(ingested[0]?.reason).toBe('below-threshold');
  });

  /* Two candidates within a whisker of each other is ambiguity, not a match. */
  it('flags two near-equal account matches as ambiguous', async () => {
    await poReviewService.ingest(
      ingestInput({
        accountCandidates: [
          { id: 'acc1', label: 'Domain Homes', detail: '', confidence: 0.9 },
          { id: 'acc2', label: 'Domaine Homes', detail: '', confidence: 0.87 },
        ],
      }),
    );

    expect(ingested[0]?.reason).toBe('ambiguous-account');
  });

  it('flags a PO number already on file as a duplicate', async () => {
    duplicateExists = true;

    await poReviewService.ingest(ingestInput());

    expect(ingested[0]?.reason).toBe('duplicate-po');
  });

  /*
   * A purchase order arrives three to four months before the work (Matt,
   * 28:40), so having no job to attach it to is the NORMAL case — reported
   * honestly rather than dressed up as low confidence.
   */
  it('reports no job match when the PO predates the work', async () => {
    await poReviewService.ingest(ingestInput({ overallConfidence: 0.99 }));

    expect(ingested[0]?.reason).toBe('no-job-match');
  });
});

describe('confirming', () => {
  it('writes the purchase order a human confirmed', async () => {
    await poReviewService.confirm(ID, confirmation(), OFFICE);

    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]?.order).toMatchObject({
      poNumber: '4500123456',
      accountId: 'acc1',
      expectedAreaM2: 823.41,
    });
  });

  /*
   * ⚠️ M2.12: *"log confidence and correction rate from day one, so accuracy is
   * a measured number."* Without this the extractor's accuracy is an opinion.
   */
  it('records nothing as corrected when the human changed nothing', async () => {
    await poReviewService.confirm(ID, confirmation(), OFFICE);

    expect(confirmed[0]?.correctedFields).toEqual([]);
  });

  it('records exactly which fields the human corrected', async () => {
    await poReviewService.confirm(
      ID,
      confirmation({ expectedAreaM2: 900, siteSupervisorName: 'Matt French' }),
      OFFICE,
    );

    expect(confirmed[0]?.correctedFields).toEqual(['expectedAreaM2', 'siteSupervisorName']);
  });

  /* A blank the reviewer left alone is not a correction — counting it would
   * inflate the error rate and make the threshold decision worse. */
  it('does not count an empty string against a null as a correction', async () => {
    stored = extraction({ extractedLotNumber: null });

    await poReviewService.confirm(ID, confirmation({ lotNumber: '' }), OFFICE);

    expect(confirmed[0]?.correctedFields).not.toContain('lotNumber');
  });

  it('refuses when the same PO is already on file for that account', async () => {
    duplicateExists = true;

    await expect(poReviewService.confirm(ID, confirmation(), OFFICE)).rejects.toMatchObject({
      status: 409,
    });
    expect(confirmed).toHaveLength(0);
  });

  it('refuses an account that does not exist', async () => {
    accountFound = false;

    await expect(poReviewService.confirm(ID, confirmation(), OFFICE)).rejects.toMatchObject({
      status: 422,
    });
  });

  it('refuses an extraction somebody already reviewed', async () => {
    stored = extraction({ state: 'confirmed', reviewedBy: 'Renee Alvarez' });

    await expect(poReviewService.confirm(ID, confirmation(), OFFICE)).rejects.toMatchObject({
      status: 409,
    });
  });

  /*
   * Two reviewers opening the same document. The claim is conditional, so the
   * loser gets an explanation rather than a duplicate purchase order.
   */
  it('refuses when another reviewer claims it first', async () => {
    confirmMatches = false;

    await expect(poReviewService.confirm(ID, confirmation(), OFFICE)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('404s an extraction that does not exist', async () => {
    stored = null;

    await expect(poReviewService.confirm(ID, confirmation(), OFFICE)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('rejecting', () => {
  /*
   * The rejections ARE the training data. "Not a PO, it was a remittance" and
   * "wrong account, Domain not Domaine" are different failures.
   */
  it('requires a reason', async () => {
    await expect(poReviewService.reject(ID, '   ', OFFICE)).rejects.toMatchObject({
      status: 422,
    });
  });

  it('records the reason', async () => {
    await poReviewService.reject(ID, 'Remittance advice, not a purchase order', OFFICE);

    expect(rejected[0]?.note).toBe('Remittance advice, not a purchase order');
  });

  it('refuses one that is no longer awaiting review', async () => {
    rejectMatches = false;

    await expect(poReviewService.reject(ID, 'Wrong document', OFFICE)).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('who may review', () => {
  it('keeps drivers out', async () => {
    await expect(
      poReviewService.list({ page: 1, pageSize: 20 }, DRIVER),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a driver confirming a purchase order', async () => {
    await expect(poReviewService.confirm(ID, confirmation(), DRIVER)).rejects.toMatchObject({
      status: 403,
    });
    expect(confirmed).toHaveLength(0);
  });
});

describe('reading the original', () => {
  /* The reviewer compares what was extracted against what the page says —
   * that is the whole point of review. */
  it('hands back a link to the source document', async () => {
    const result = await poReviewService.get(ID, OFFICE);

    expect(result.documentUrl).toContain('purchase-orders/x/doc.pdf');
  });
});
