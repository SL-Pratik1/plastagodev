import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * I6 — the extractor's callback into the review queue.
 *
 * ── What is actually under test ───────────────────────────────────────────
 * Three properties, each of which costs money when it breaks:
 *
 *  1. **The callback body is not trusted.** The handler takes an id and
 *     re-fetches the document with our own credentials. If it ever read the
 *     payload instead, an unauthenticated HTTP request would decide what the
 *     office sees — and a purchase order authorises invoicing.
 *  2. **A repeated callback does not queue twice.** The vendor retries on a
 *     non-2xx and can fire more than once for one document. Two rows means two
 *     reviewers confirm the same order, and the unique index on
 *     `(accountId, poNumber)` then fails whichever was second with a database
 *     error rather than an explanation.
 *  3. **Only completed documents of OUR type are ingested.** Everything else is
 *     ignored quietly, so the vendor's retry loop is not put to work on
 *     something that will never change.
 */

let queued: Array<Record<string, unknown>> = [];
let existingExternalId: string | null = null;

/** What the vendor answers `getExtraction` with. Set per test. */
let vendorExtraction: Record<string, unknown> = {};
let fetchedIds: string[] = [];
let enabled = true;

vi.mock('../src/domains/queues/po-extraction.repository.js', () => ({
  poExtractionRepository: {
    findByExternalId: () => Promise.resolve(existingExternalId),
    ingest: (input: Record<string, unknown>) => {
      queued.push(input);
      return Promise.resolve('row1');
    },
    isDuplicate: () => Promise.resolve(false),
    findById: () => Promise.resolve(null),
    findStorageKey: () => Promise.resolve(null),
    countNeedingReview: () => Promise.resolve(0),
    list: () =>
      Promise.resolve({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } }),
  },
}));

vi.mock('../src/integrations/extractor.js', () => ({
  extractorClient: {
    get enabled() {
      return enabled;
    },
    getExtraction: (id: string) => {
      fetchedIds.push(id);
      return Promise.resolve(vendorExtraction);
    },
    downloadFile: () =>
      Promise.resolve({ body: Buffer.from('%PDF'), contentType: 'application/pdf' }),
  },
  TERMINAL_FAILURES: new Set(['failed', 'analysis failed', 'extraction failed']),
}));

/** The adapter is exercised on its own in `po-ingest.adapter.test.ts`. */
vi.mock('../src/domains/queues/po-ingest.adapter.js', () => ({
  adaptExtraction: (extraction: { id: string }) =>
    Promise.resolve({
      input: {
        fromAddress: 'orders@wisdomhomes.com.au',
        subject: 'PO',
        receivedAt: new Date('2026-07-22T00:00:00.000Z'),
        attachmentName: 'PO.pdf',
        pageCount: 1,
        storageKey: null,
        documentText: '',
        poNumber: '208918.321.01',
        amountExGst: '302.00',
        extractedAreaM2: null,
        extractedBagAllowance: null,
        extractedSiteAddress: 'Somervaille Dr',
        extractedLotNumber: '959',
        extractedSupervisorName: 'David Luc',
        extractedSupervisorMobile: '0411 601 227',
        fields: [],
        suggestedAccountId: '000000000000000000000001',
        suggestedAccountName: 'Wisdom Homes',
        suggestedJobId: null,
        suggestedJobNumber: null,
        accountCandidates: [],
        jobCandidates: [],
        overallConfidence: 0.95,
      },
      diagnostics: {
        matchedBy: 'email-domain' as const,
        suburbResolved: true,
        zone: 'sydney',
        storedOriginal: false,
        extractionId: extraction.id,
      },
    }),
}));

vi.mock('../src/domains/accounts/account.repository.js', () => ({
  accountRepository: { findById: () => Promise.resolve(null) },
}));

/**
 * Pins the template id the document-type gate compares against.
 *
 * ⚠️ Without this the test reads whatever is in the developer's own
 * `apps/api/.env` — `config/env.ts` calls `dotenv/config` at import, so a real
 * `EXTRACTOR_DOCUMENT_ID` reaches these assertions. Once the extractor was
 * actually configured on a machine, every fixture below stopped matching and
 * four tests failed for a reason that had nothing to do with the code.
 *
 * Only that one key is overridden; the rest of the environment stays real, so
 * this cannot quietly diverge from how the service is configured in production.
 */
vi.mock('../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/env.js')>();
  return { ...actual, env: { ...actual.env, EXTRACTOR_DOCUMENT_ID: 'tpl1' } };
});

vi.mock('../src/integrations/storage.js', () => ({
  getStorage: () => ({ presignDownload: () => Promise.resolve('https://x') }),
}));

const { poReviewService } = await import('../src/domains/queues/po-review.service.js');

const COMPLETED = {
  id: '6aa1296322fa384a1165608d',
  fileName: 'PO.pdf',
  status: 'completed',
  extractedData: { po_number: '208918.321.01' },
  error: null,
  documentId: 'tpl1',
  documentName: 'PlastaGo Purchase Order',
  fileUrl: 'https://vendor.example/f.pdf',
  email: 'orders@wisdomhomes.com.au',
  createdAt: '2026-07-22T01:00:00.000Z',
};

beforeEach(() => {
  queued = [];
  fetchedIds = [];
  existingExternalId = null;
  vendorExtraction = { ...COMPLETED };
  enabled = true;
});

describe('the callback is a ping, not a payload', () => {
  it('re-fetches the document from the vendor with our own credentials', async () => {
    await poReviewService.ingestFromExtractor('6aa1296322fa384a1165608d');

    expect(fetchedIds).toEqual(['6aa1296322fa384a1165608d']);
    expect(queued).toHaveLength(1);
  });

  /*
   * The worst a forged callback can achieve: making us re-read a document that
   * genuinely exists in our own tenant. It cannot inject one.
   */
  it('surfaces the vendor saying an id does not exist', async () => {
    const notFound = new Error('nope');
    const { extractorClient } = await import('../src/integrations/extractor.js');
    vi.spyOn(extractorClient, 'getExtraction').mockRejectedValueOnce(notFound);

    await expect(poReviewService.ingestFromExtractor('deadbeef')).rejects.toThrow();
    expect(queued).toHaveLength(0);
  });

  it('records the vendor id on the row, so a retry can be recognised', async () => {
    await poReviewService.ingestFromExtractor('6aa1296322fa384a1165608d');

    expect(queued[0]?.externalId).toBe('6aa1296322fa384a1165608d');
  });
});

describe('a repeated callback', () => {
  it('does not queue the same document twice', async () => {
    existingExternalId = 'row1';

    const result = await poReviewService.ingestFromExtractor('6aa1296322fa384a1165608d');

    expect(queued).toHaveLength(0);
    // Reports the row it was already queued as, rather than failing: the vendor
    // asked a reasonable question and got a truthful answer.
    expect(result).toEqual({ id: 'row1' });
  });

  it('does not even call the vendor when the row already exists', async () => {
    existingExternalId = 'row1';

    await poReviewService.ingestFromExtractor('6aa1296322fa384a1165608d');

    expect(fetchedIds).toEqual([]);
  });
});

describe('what is ignored rather than queued', () => {
  it('ignores a document still being processed', async () => {
    vendorExtraction = { ...COMPLETED, status: 'extracting', extractedData: null };

    const result = await poReviewService.ingestFromExtractor('6aa1296322fa384a1165608d');

    expect(result).toBeNull();
    expect(queued).toHaveLength(0);
  });

  it('ignores a document the extractor could not read', async () => {
    vendorExtraction = { ...COMPLETED, status: 'extraction failed', error: 'unreadable scan' };

    const result = await poReviewService.ingestFromExtractor('6aa1296322fa384a1165608d');

    expect(result).toBeNull();
    expect(queued).toHaveLength(0);
  });

  it('refuses when the pipeline is switched off', async () => {
    enabled = false;

    await expect(poReviewService.ingestFromExtractor('6aa1296322fa384a1165608d')).rejects.toThrow(
      /not configured/i,
    );
  });
});

describe('what the extractor still may not decide', () => {
  /*
   * Risk 9. The vendor has no `state` or `reason` field to send, and the row it
   * produces must always land in the queue — a model being confident is not a
   * human confirming.
   */
  it('always queues for review, however confident the extraction', async () => {
    await poReviewService.ingestFromExtractor('6aa1296322fa384a1165608d');

    expect(queued[0]?.overallConfidence).toBe(0.95);
    // The reason is computed by the service, never supplied by the vendor.
    expect(queued[0]?.reason).toBeTypeOf('string');
    expect(queued[0]).not.toHaveProperty('state');
  });

  /*
   * A purchase order arrives three to four months before the work (Matt, 28:40),
   * so `no-job-match` is the honest reason even when every field scored well.
   */
  it('records why a human has to look, even on a clean read', async () => {
    await poReviewService.ingestFromExtractor('6aa1296322fa384a1165608d');

    expect(queued[0]?.reason).toBe('no-job-match');
  });
});
