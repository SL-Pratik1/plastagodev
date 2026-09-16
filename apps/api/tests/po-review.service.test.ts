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

/* ── Supervisor provisioning (M5.14, Matt 33:25) ─────────────────────────── */

/** Builder or contractor. Only a builder has site supervisors at all. */
let accountType: 'builder' | 'contractor' = 'builder';
/** An existing login that matches the order's mobile, if there is one. */
let existingLogin: { id: string; accountId: string | null } | null = null;
/** Logins created by the run under test. */
let invited: Array<{ accountId: string; name: string; email: string | null; mobile: string | null }> =
  [];
/** Which order got linked to which login. */
let supervisorLinks: Array<{ purchaseOrderId: string; userId: string }> = [];
/** Invitations actually handed to the outbound service. */
let notified: Array<{ subjectKey: string; email: string | null; mobile: string | null }> = [];
/** Set to make the outbound service throw, standing in for ClickSend being down. */
let outboundFails = false;
/**
 * Whether a copy of the original was taken.
 *
 * `storeOriginal` swallows a failed download rather than dropping a real
 * purchase order, so "queued with no PDF" is a normal state the review screen
 * has to cope with — not an error path.
 */
let storedOriginalKey: string | null = 'purchase-orders/x/doc.pdf';
let confirmMatches = true;
let rejectMatches = true;
let accountFound = true;

vi.mock('../src/domains/queues/po-extraction.repository.js', () => ({
  poExtractionRepository: {
    list: () =>
      Promise.resolve({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } }),
    findById: () => Promise.resolve(stored),
    findStorageKey: () => Promise.resolve(storedOriginalKey),
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
      Promise.resolve(
        accountFound ? { id: 'acc1', name: 'Domain Homes', accountType } : null,
      ),
  },
}));

/*
 * ⚠️ The repository is faked and the provisioning SERVICE is real. The rules
 * worth testing all live in the service — who counts as reusable, whose login
 * is left alone, when nothing is sent — and mocking it would test the mock.
 */
vi.mock('../src/domains/portal/supervisor.repository.js', () => ({
  supervisorRepository: {
    findExisting: () => Promise.resolve(existingLogin),
    invite: (input: { accountId: string; name: string; email: string | null; mobile: string | null }) => {
      invited.push(input);
      return Promise.resolve('usr00000000000000000mf1');
    },
  },
  portalAccountRepository: {},
}));

vi.mock('../src/domains/queues/purchase-order.repository.js', () => ({
  purchaseOrderRepository: {
    setSupervisorUser: (purchaseOrderId: string, userId: string) => {
      supervisorLinks.push({ purchaseOrderId, userId });
      return Promise.resolve(true);
    },
  },
}));

vi.mock('../src/domains/notifications/outbound.service.js', () => ({
  outboundService: {
    send: (input: {
      subjectKey: string;
      recipient: { email: string | null; mobile: string | null };
    }) => {
      if (outboundFails) return Promise.reject(new Error('ClickSend is down'));
      notified.push({
        subjectKey: input.subjectKey,
        email: input.recipient.email,
        mobile: input.recipient.mobile,
      });
      return Promise.resolve({ outcome: 'sent' });
    },
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
    accountCandidates: [{ id: 'acc1', label: 'Domain Homes', detail: '' }],
    jobCandidates: [],
    reason: 'awaiting-check' as const,
    ...overrides,
  };
}

beforeEach(() => {
  ingested = [];
  confirmed = [];
  rejected = [];
  stored = extraction();
  duplicateExists = false;
  storedOriginalKey = 'purchase-orders/x/doc.pdf';
  accountType = 'builder';
  existingLogin = null;
  invited = [];
  supervisorLinks = [];
  notified = [];
  outboundFails = false;
  confirmMatches = true;
  rejectMatches = true;
  accountFound = true;
});

describe('an extraction is never trusted', () => {
  /*
   * ⚠️ The central rule. A cleanly-read extraction with a matched account still
   * goes to a human, because the document authorises invoicing.
   *
   * This used to be phrased around a 0.99 confidence score. The scores are
   * gone — they described the model rather than the document, and a high one
   * invited confirming an order without opening the PDF it came from — but the
   * rule they were testing is unchanged and is now the only behaviour there is.
   */
  it('sends a cleanly-read extraction to review anyway', async () => {
    await poReviewService.ingest(ingestInput({ suggestedJobId: 'job1' }), OFFICE);

    expect(ingested).toHaveLength(1);
    // Nothing was written as a purchase order.
    expect(confirmed).toHaveLength(0);
  });

  /*
   * Being signed in is not the same as being allowed to fill this queue.
   *
   * The route once asked only for a session, so any account — a driver's phone,
   * or a CUSTOMER's portal login — could post a purchase order naming any
   * number and amount into the queue whose entire job is to stop a machine
   * billing somebody. Confirming one writes a real order against an account.
   */
  it('refuses an ingest from someone who is not office staff', async () => {
    await expect(poReviewService.ingest(ingestInput(), DRIVER)).rejects.toMatchObject({
      status: 403,
    });

    expect(ingested).toHaveLength(0);
  });

  /*
   * The reason says what a reviewer should look at first. Letting the vendor
   * declare it would put them in charge of the triage on their own output.
   */
  it('decides the review reason itself, ignoring what the caller sent', async () => {
    await poReviewService.ingest(
      ingestInput({ suggestedAccountId: null, reason: 'awaiting-check' }),
      OFFICE,
    );

    expect(ingested[0]?.reason).toBe('no-account-match');
  });

  /*
   * Nothing wrong with it, and it still waits for a person. `awaiting-check`
   * replaced `below-threshold`, which rendered as "Low OCR confidence" — the
   * one reason on the screen a reviewer could do nothing with.
   */
  it('marks an order with nothing wrong with it as simply not checked yet', async () => {
    await poReviewService.ingest(ingestInput({ suggestedJobId: 'job1' }), OFFICE);

    expect(ingested[0]?.reason).toBe('awaiting-check');
  });

  /* More than one plausible account is ambiguity, not a match. */
  it('flags two near-equal account matches as ambiguous', async () => {
    await poReviewService.ingest(
      ingestInput({
        accountCandidates: [
          { id: 'acc1', label: 'Domain Homes', detail: '' },
          { id: 'acc2', label: 'Domaine Homes', detail: '' },
        ],
      }),
      OFFICE,
    );

    expect(ingested[0]?.reason).toBe('ambiguous-account');
  });

  it('flags a PO number already on file as a duplicate', async () => {
    duplicateExists = true;

    await poReviewService.ingest(ingestInput(), OFFICE);

    expect(ingested[0]?.reason).toBe('duplicate-po');
  });

  /*
   * A purchase order arrives three to four months before the work (Matt,
   * 28:40), so having no job to attach it to is the NORMAL case — reported
   * honestly rather than dressed up as low confidence.
   */
  it('reports no job match when the PO predates the work', async () => {
    await poReviewService.ingest(ingestInput({ overallConfidence: 0.99 }), OFFICE);

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

/*
 * Matt, 33:25: *"on here you can see the site supervisor's name is already here
 * and their phone number, so it should automatically create that supervisor
 * underneath that builder."* And 33:43, on ceremony: *"I don't think they need
 * invite to the system per se, like if they're on a purchase order, they're
 * able to access it."*
 *
 * So confirming an order is the whole act. Nobody keys in a supervisor, and
 * nobody accepts an invitation.
 */
describe('the supervisor the order named (M5.14, Matt 33:25)', () => {
  it('creates a login under that builder', async () => {
    await poReviewService.confirm(ID, confirmation(), OFFICE);

    expect(invited).toHaveLength(1);
    expect(invited[0]?.accountId).toBe('acc1');
    expect(invited[0]?.name).toBe('Matthew French');
    expect(invited[0]?.mobile).toBe('0412345678');
  });

  /* Without the link the job booked against this order cannot be scoped. */
  it('records which login the order belongs to', async () => {
    await poReviewService.confirm(ID, confirmation(), OFFICE);

    expect(supervisorLinks).toEqual([
      { purchaseOrderId: 'po1', userId: 'usr00000000000000000mf1' },
    ]);
  });

  /* §9 and Matt, 34:16 — a supervisor is reached by SMS, not email. */
  it('texts them their access', async () => {
    await poReviewService.confirm(ID, confirmation(), OFFICE);

    expect(notified).toHaveLength(1);
    expect(notified[0]?.mobile).toBe('0412345678');
    // Keyed on the user, so a replay cannot text somebody twice.
    expect(notified[0]?.subjectKey).toBe('user-invite:usr00000000000000000mf1');
  });

  /*
   * The common case by a wide margin: the same supervisor is named on every
   * order they raise. A second login would collide, and a second text would
   * arrive months after they started using the first.
   */
  it('reuses the login of a supervisor already on this account', async () => {
    existingLogin = { id: 'usr00000000000000000mf1', accountId: 'acc1' };

    await poReviewService.confirm(ID, confirmation(), OFFICE);

    expect(invited).toHaveLength(0);
    expect(notified).toHaveLength(0);
    // Still linked, so the job is still scoped to them.
    expect(supervisorLinks).toHaveLength(1);
  });

  /*
   * ⚠️ A login belongs to a PERSON. This mobile is already somebody's — a
   * supervisor who moved builders, or an office user typed onto an order.
   * Attaching it would show this builder's work to another builder's contact.
   */
  it('leaves a login that belongs to another account alone', async () => {
    existingLogin = { id: 'usr00000000000000000ot1', accountId: 'acc-other' };

    await poReviewService.confirm(ID, confirmation(), OFFICE);

    expect(invited).toHaveLength(0);
    expect(notified).toHaveLength(0);
    expect(supervisorLinks).toHaveLength(0);
    // The order itself is still confirmed — this is the office's to sort out.
    expect(confirmed).toHaveLength(1);
  });

  /* A contractor books their own work and has no supervisors to provision. */
  it('provisions nobody on a contractor account', async () => {
    accountType = 'contractor';

    await poReviewService.confirm(ID, confirmation(), OFFICE);

    expect(invited).toHaveLength(0);
    expect(confirmed).toHaveLength(1);
  });

  /* Matt, 34:52: *"sometimes they're blank… there's nothing I can do about that."* */
  it('confirms an order that named nobody', async () => {
    await poReviewService.confirm(
      ID,
      confirmation({ siteSupervisorName: null, siteSupervisorMobile: null }),
      OFFICE,
    );

    expect(invited).toHaveLength(0);
    expect(confirmed).toHaveLength(1);
  });

  /*
   * A name with no mobile and no email cannot sign in at all: the code goes to
   * the identifier the login was created against. A login nobody can use is
   * worse than an unassigned order, which is at least visibly unassigned.
   */
  it('provisions nobody it has no way to reach', async () => {
    await poReviewService.confirm(ID, confirmation({ siteSupervisorMobile: null }), OFFICE);

    expect(invited).toHaveLength(0);
    expect(confirmed).toHaveLength(1);
  });

  /*
   * ⚠️ The one that protects the money. Confirming the order is the act that
   * matters commercially; a texting outage must not roll it back.
   */
  it('still confirms the order when the invitation cannot be sent', async () => {
    outboundFails = true;

    await expect(poReviewService.confirm(ID, confirmation(), OFFICE)).resolves.toBeUndefined();

    expect(confirmed).toHaveLength(1);
    // The login exists and is linked; only the message failed.
    expect(invited).toHaveLength(1);
    expect(supervisorLinks).toHaveLength(1);
  });
});

describe('reading the original', () => {
  /* The reviewer compares what was extracted against what the page says —
   * that is the whole point of review. */
  it('hands back a link to the source document', async () => {
    const result = await poReviewService.get(ID, OFFICE);

    expect(result.documentUrl).toContain('purchase-orders/x/doc.pdf');
  });

  /*
   * Matt, 28:30, asked to see the PDF on every review — but an order whose
   * download failed is still a real order worth reviewing. The screen falls
   * back to the extracted text, so this must be null rather than throwing.
   */
  it('hands back null when no copy of the original was taken', async () => {
    storedOriginalKey = null;

    const result = await poReviewService.get(ID, OFFICE);

    // Null, not a throw, and the row still comes back to be reviewed — the
    // screen falls back to the extracted text.
    expect(result.documentUrl).toBeNull();
    expect(result.attachmentName).toBe('PO-4500123456.pdf');
  });
});
