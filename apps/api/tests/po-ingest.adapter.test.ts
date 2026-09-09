import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * I6 · M2.12 — turning an extractor result into a review-queue row.
 *
 * ── Why these particular cases ────────────────────────────────────────────
 * Every one is taken from a real purchase order the client supplied, and each
 * asserts a failure that would have cost money silently:
 *
 *  • The Domaine order states 823.41 m². If that is dropped, the job prices at
 *    the call-out fee alone and its tonnage is handed to the rest of the run.
 *  • The Wisdom order states NO square metres, on purpose — it is a fixed-price
 *    account. Treating that absence as a failed read sends every one of their
 *    orders to the top of a queue for a human to confirm a number that is not
 *    on the page.
 *  • BOTH orders print "PLASTA GO" as the vendor. Matching on it would match
 *    every purchase order to us.
 *  • Both print a GST-inclusive total more prominently than the exclusive one.
 *  • Both use DD/MM/YYYY, which read month-first is a different date.
 */

/* ── Doubles ──────────────────────────────────────────────────────────────── */

interface AccountRow {
  id: string;
  name: string;
  code: string;
}

/** What `accountRepository.list` answers with. Set per test. */
let accounts: AccountRow[] = [];
let lastAccountQuery: string | undefined;

/** The suburbs the places table holds. Set per test. */
let places: Array<{ id: string; suburb: string; postcode: string; zone: string; label: string }> =
  [];

let stored: Array<{ key: string; contentType: string }> = [];
let downloadFails = false;

vi.mock('../src/domains/accounts/account.repository.js', () => ({
  accountRepository: {
    list: (query: { q?: string }) => {
      lastAccountQuery = query.q;
      return Promise.resolve({
        data: accounts,
        meta: { page: 1, pageSize: 5, total: accounts.length, totalPages: 1 },
      });
    },
  },
}));

vi.mock('../src/domains/places/place.repository.js', () => ({
  placeRepository: {
    /** Mirrors the real repository's behaviour: suburb contains, postcode prefix. */
    search: (term: string) => {
      const needle = term.trim().toLowerCase();
      return Promise.resolve(
        places.filter(
          (place) =>
            place.suburb.toLowerCase().includes(needle) || place.postcode.startsWith(needle),
        ),
      );
    },
  },
}));

vi.mock('../src/integrations/storage.js', () => ({
  buildKey: (input: { scope: string; ownerId: string; kind: string }) =>
    `${input.scope}/${input.ownerId}/${input.kind}/file.pdf`,
  getStorage: () => ({
    put: (key: string, _body: Buffer, contentType: string) => {
      stored.push({ key, contentType });
      return Promise.resolve();
    },
  }),
}));

vi.mock('../src/integrations/extractor.js', () => ({
  extractorClient: {
    enabled: true,
    downloadFile: () => {
      if (downloadFails) return Promise.reject(new Error('vendor timeout'));
      return Promise.resolve({ body: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' });
    },
  },
  TERMINAL_FAILURES: new Set(['failed']),
}));

const { adaptExtraction } = await import('../src/domains/queues/po-ingest.adapter.js');

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

/** A 24-character hex id, which is what `buildKey` demands of an owner. */
const EXTRACTION_ID = '6aa1296322fa384a1165608d';

function extraction(
  data: Record<string, unknown>,
  overrides: Partial<{ email: string | null; fileUrl: string | null }> = {},
) {
  return {
    id: EXTRACTION_ID,
    fileName: 'PO.pdf',
    fileType: 'application/pdf',
    status: 'completed',
    extractedData: data,
    error: null,
    documentId: 'tpl1',
    documentName: 'PlastaGo Purchase Order',
    fileUrl: 'https://vendor.example/file.pdf',
    email: 'orders@domainehomes.com.au',
    createdAt: '2026-07-28T06:20:00.000Z',
    ...overrides,
  };
}

/** The Domaine order, as the template reads it. Real figures. */
const DOMAINE = {
  po_number: '79904106/082',
  builder_name: 'Domaine Homes (NSW) Pty Ltd',
  order_date: '28/07/2026',
  lot_number: '914',
  site_address: '(#10) Broadmeadow way',
  suburb: 'EDGEWORTH',
  postcode: '2285',
  area_m2: '823.41',
  bag_allowance: '2.00',
  supervisor_name: 'Mathew French',
  supervisor_mobile: '0427 821 430',
  amount_ex_gst: '474.68',
};

/** The Wisdom order. Fixed price — no square metres, and that is correct. */
const WISDOM = {
  po_number: '208918.321.01',
  builder_name: 'Wisdom Homes',
  order_date: '22/07/2026',
  lot_number: '959',
  site_address: 'Somervaille Dr',
  suburb: 'CATHERINE FIELD',
  postcode: '2557',
  area_m2: null,
  bag_allowance: null,
  supervisor_name: 'David Luc',
  supervisor_mobile: '0411 601 227',
  amount_ex_gst: '302.00',
};

const context = { receivedAt: new Date('2026-07-28T06:20:00.000Z'), subject: 'Purchase Order' };

const CATHERINE_FIELD = {
  id: 'catherine-field',
  suburb: 'Catherine Field',
  postcode: '2557',
  zone: 'sydney',
  label: 'Catherine Field NSW 2557',
};

beforeEach(() => {
  accounts = [];
  places = [CATHERINE_FIELD];
  stored = [];
  downloadFails = false;
  lastAccountQuery = undefined;
});

/* ── The figures that decide the price ────────────────────────────────────── */

describe('reading the values that price a job', () => {
  it('keeps the stated area to the cent-equivalent — 823.41 m², not 823', async () => {
    const { input } = await adaptExtraction(extraction(DOMAINE), context);
    expect(input.extractedAreaM2).toBe(823.41);
  });

  it('strips units the model leaves on a number', async () => {
    const { input } = await adaptExtraction(
      extraction({ ...DOMAINE, area_m2: '823.41 m2' }),
      context,
    );
    expect(input.extractedAreaM2).toBe(823.41);
  });

  /*
   * ⚠️ Regression. Stripping every non-digit rather than removing the unit first
   * kept the "2" out of "m2": a round "1000 m2" became 10002.
   *
   * A tenfold error on the figure that prices the job AND weights the tip-off
   * apportionment, which ends up on an EPA diversion certificate with the
   * customer's name on it. Nothing about it would have looked wrong.
   */
  it('never glues the unit’s own digit onto the quantity', async () => {
    const cases: Array<[string, number]> = [
      ['1000 m2', 1000],
      ['1000m2', 1000],
      ['500 M2', 500],
      ['823.41 sqm', 823.41],
      ['1,120 m2', 1120],
    ];

    for (const [raw, expected] of cases) {
      const { input } = await adaptExtraction(
        extraction({ ...DOMAINE, area_m2: raw }),
        context,
      );
      expect(input.extractedAreaM2, `"${raw}"`).toBe(expected);
    }
  });

  it('reads "2.00 Each" without taking a digit from the unit', async () => {
    const { input } = await adaptExtraction(
      extraction({ ...DOMAINE, bag_allowance: '2.00 Each' }),
      context,
    );
    expect(input.extractedBagAllowance).toBe(2);
  });

  it('reads a bag allowance of "2.00 Each" as two bags', async () => {
    const { input } = await adaptExtraction(extraction(DOMAINE), context);
    expect(input.extractedBagAllowance).toBe(2);
  });

  /*
   * ⚠️ The single most valuable assertion in this file.
   *
   * Matt, 31:04: *"we're on a fixed price with them. So they don't actually give
   * us square metres."* Null is the correct reading; zero would price the job at
   * the call-out fee AND drop the stop out of the m²-weighted tip-off split,
   * handing its share of recovered tonnage to everyone else on the run.
   */
  it('leaves the area NULL on a fixed-price order rather than zero', async () => {
    const { input } = await adaptExtraction(extraction(WISDOM), context);
    expect(input.extractedAreaM2).toBeNull();
  });

  it('does not treat a missing area as a low-confidence read', async () => {
    const { input } = await adaptExtraction(extraction(WISDOM), context);
    const area = input.fields.find((field) => field.key === 'areaM2');

    // Absent-and-correct, so it must not outrank a genuinely broken field.
    expect(area?.confidence).toBeGreaterThan(0.5);
  });

  it('strips a currency symbol and thousands separator from money', async () => {
    const { input } = await adaptExtraction(
      extraction({ ...DOMAINE, amount_ex_gst: '$1,474.68' }),
      context,
    );
    expect(input.amountExGst).toBe('1474.68');
  });

  it('refuses money it cannot parse rather than storing nonsense', async () => {
    const { input } = await adaptExtraction(
      extraction({ ...DOMAINE, amount_ex_gst: 'see attached' }),
      context,
    );
    expect(input.amountExGst).toBeNull();
  });

  it('reads "N/A" as absent, so the office never sees a supervisor called N/A', async () => {
    const { input } = await adaptExtraction(
      extraction({ ...DOMAINE, supervisor_name: 'N/A' }),
      context,
    );
    expect(input.extractedSupervisorName).toBeNull();
  });
});

/* ── Account matching ─────────────────────────────────────────────────────── */

describe('deciding which customer an order belongs to', () => {
  it('matches on the sender domain when exactly one account fits', async () => {
    accounts = [{ id: 'acc1', name: 'Domaine Homes', code: 'DOM001' }];

    const { input, diagnostics } = await adaptExtraction(extraction(DOMAINE), context);

    expect(diagnostics.matchedBy).toBe('email-domain');
    expect(input.suggestedAccountId).toBe('acc1');
  });

  it('splits a run-together domain into words the name index can match', async () => {
    accounts = [{ id: 'acc1', name: 'Domaine Homes', code: 'DOM001' }];
    await adaptExtraction(extraction(DOMAINE), context);

    // `domainehomes.com.au` has to become "domaine homes" or it matches nothing.
    expect(lastAccountQuery).toBe('domaine homes');
  });

  /*
   * ⚠️ Both sample orders print "PLASTA GO" as the vendor, in a labelled field
   * near the top. An account match that trusted the document without excluding
   * our own domains would match every purchase order to whichever account looks
   * most like PlastaGo.
   */
  it('never matches on our own domain, even with an account that would fit', async () => {
    accounts = [{ id: 'us', name: 'PlastaGo', code: 'PGO001' }];

    const { input, diagnostics } = await adaptExtraction(
      extraction({ ...DOMAINE, builder_name: 'Plasta-Go Pty Ltd' }, {
        email: 'accounts@plastago.com.au',
      }),
      context,
    );

    expect(diagnostics.matchedBy).not.toBe('email-domain');
    expect(input.suggestedAccountId).toBe('us');
    // It fell through to the document name, which is the weaker signal — and it
    // is scored below the auto-accept line so a human still confirms.
    expect(input.accountCandidates[0]?.confidence).toBeLessThan(0.95);
  });

  it('ignores a public mailbox domain and falls back to the document', async () => {
    accounts = [{ id: 'acc1', name: 'Wisdom Homes', code: 'WIS001' }];

    const { diagnostics } = await adaptExtraction(
      extraction(WISDOM, { email: 'bob@gmail.com' }),
      context,
    );

    expect(diagnostics.matchedBy).toBe('document-name');
  });

  it('strips legal noise so "Domaine Homes (NSW) Pty Ltd" matches "Domaine Homes"', async () => {
    accounts = [{ id: 'acc1', name: 'Domaine Homes', code: 'DOM001' }];

    await adaptExtraction(extraction(DOMAINE, { email: 'bob@gmail.com' }), context);

    expect(lastAccountQuery).toBe('domaine homes');
  });

  /*
   * Two candidates is not an answer. `resolveReason` turns this into
   * `ambiguous-account`, which is a more useful thing to tell a reviewer than
   * "low confidence" — "Domain" and "Domaine" are different builders.
   */
  it('suggests nothing when several accounts fit, but carries the candidates', async () => {
    accounts = [
      { id: 'acc1', name: 'Domaine Homes', code: 'DOM001' },
      { id: 'acc2', name: 'Domain Homes', code: 'DMN001' },
    ];

    const { input } = await adaptExtraction(extraction(DOMAINE), context);

    expect(input.suggestedAccountId).toBeNull();
    expect(input.accountCandidates).toHaveLength(2);
  });

  it('scores the builder field as malformed when a name was read but nothing matched', async () => {
    accounts = [];

    const { input } = await adaptExtraction(extraction(DOMAINE), context);
    const builder = input.fields.find((field) => field.key === 'accountName');

    expect(builder?.value).toBe('Domaine Homes (NSW) Pty Ltd');
    expect(builder?.confidence).toBeLessThan(0.5);
  });
});

/* ── Suburb and zone ──────────────────────────────────────────────────────── */

describe('resolving the site to a serviceable suburb', () => {
  it('resolves a known suburb by its postcode', async () => {
    const { diagnostics } = await adaptExtraction(extraction(WISDOM), context);

    expect(diagnostics.suburbResolved).toBe(true);
    expect(diagnostics.zone).toBe('sydney');
  });

  /*
   * ⚠️ The Domaine order is for EDGEWORTH 2285, which is not in the seeded
   * places table — Newcastle holds only Fletcher, Thornton and Medowie. A suburb
   * absent from that table means "we do not go there" (`place.model.ts`), so
   * this order can be confirmed and then never booked. The reviewer has to be
   * warned, which is why it drives the address field's score.
   */
  it('refuses to resolve a suburb PlastaGo does not service', async () => {
    const { input, diagnostics } = await adaptExtraction(extraction(DOMAINE), context);

    expect(diagnostics.suburbResolved).toBe(false);
    expect(diagnostics.zone).toBeNull();

    const address = input.fields.find((field) => field.key === 'siteAddress');
    expect(address?.confidence).toBeLessThan(0.5);
  });

  it('never falls back to a nearby suburb when the name does not match exactly', async () => {
    places = [
      { id: 'oran-park', suburb: 'Oran Park', postcode: '2570', zone: 'sydney', label: 'Oran Park NSW 2570' },
      { id: 'marsden-park', suburb: 'Marsden Park', postcode: '2765', zone: 'sydney', label: 'Marsden Park NSW 2765' },
    ];

    const { diagnostics } = await adaptExtraction(
      extraction({ ...WISDOM, suburb: 'Park', postcode: '9999' }),
      context,
    );

    // "Park" matches both by contains. Picking either would be a coin toss on a
    // value that decides the price.
    expect(diagnostics.suburbResolved).toBe(false);
  });

  it('uses the suburb name to break a tie when a postcode covers several', async () => {
    places = [
      CATHERINE_FIELD,
      { id: 'gregory-hills', suburb: 'Gregory Hills', postcode: '2557', zone: 'sydney', label: 'Gregory Hills NSW 2557' },
    ];

    const { diagnostics } = await adaptExtraction(extraction(WISDOM), context);

    expect(diagnostics.suburbResolved).toBe(true);
    expect(diagnostics.zone).toBe('sydney');
  });
});

/* ── Dates and phone numbers ──────────────────────────────────────────────── */

describe('reading Australian formats', () => {
  it('reads 22/07/2026 as 22 July, not 7 February', async () => {
    const { input } = await adaptExtraction(extraction(WISDOM), context);
    const date = input.fields.find((field) => field.key === 'issuedOn');

    expect(date?.value).toBe('2026-07-22');
  });

  it('accepts the ISO form the template asks for', async () => {
    const { input } = await adaptExtraction(
      extraction({ ...WISDOM, order_date: '2026-07-22' }),
      context,
    );

    expect(input.fields.find((field) => field.key === 'issuedOn')?.value).toBe('2026-07-22');
  });

  it('normalises a supervisor mobile to 04xx xxx xxx', async () => {
    const { input } = await adaptExtraction(
      extraction({ ...DOMAINE, supervisor_mobile: '+61427821430' }),
      context,
    );

    expect(input.extractedSupervisorMobile).toBe('0427 821 430');
  });

  /*
   * Kept rather than discarded: a blank field hides that the model read
   * something, and the reviewer is looking at the document. The confidence
   * score is what says the shape is wrong.
   */
  it('keeps a malformed number but scores it down', async () => {
    const { input } = await adaptExtraction(
      extraction({ ...DOMAINE, supervisor_mobile: '1300 855 775' }),
      context,
    );

    expect(input.extractedSupervisorMobile).toBe('1300 855 775');
    expect(input.fields.find((field) => field.key === 'siteSupervisorMobile')?.confidence).toBe(
      0.95,
    );
  });
});

/* ── Scoring ──────────────────────────────────────────────────────────────── */

describe('the confidence the queue sorts by', () => {
  it('takes the WORST critical field, so nine good ones cannot hide a bad one', async () => {
    accounts = [{ id: 'acc1', name: 'Wisdom Homes', code: 'WIS001' }];

    const good = await adaptExtraction(extraction(WISDOM), context);
    const noNumber = await adaptExtraction(extraction({ ...WISDOM, po_number: null }), context);

    expect(good.input.overallConfidence).toBeGreaterThan(0.9);
    // The purchase-order number is the field an invoice is rejected for.
    expect(noNumber.input.overallConfidence).toBe(0);
  });

  it('scores an unserviceable suburb down even when everything else is perfect', async () => {
    accounts = [{ id: 'acc1', name: 'Domaine Homes', code: 'DOM001' }];

    const { input } = await adaptExtraction(extraction(DOMAINE), context);

    // Edgeworth is not serviceable, so this must not reach the 0.95 line.
    expect(input.overallConfidence).toBeLessThan(0.95);
  });
});

/* ── The original document ───────────────────────────────────────────────── */

describe('the stored original', () => {
  it('copies the PDF into our own storage rather than linking the vendor', async () => {
    const { input, diagnostics } = await adaptExtraction(extraction(DOMAINE), context);

    expect(diagnostics.storedOriginal).toBe(true);
    expect(stored).toHaveLength(1);
    expect(input.storageKey).toContain('purchase-orders/');
  });

  /*
   * An extraction with no attached PDF is still worth reviewing — every field is
   * there and the reviewer can open the original email. Dropping the row would
   * lose a real purchase order because a download timed out.
   */
  it('still queues the row when the download fails', async () => {
    downloadFails = true;

    const { input, diagnostics } = await adaptExtraction(extraction(DOMAINE), context);

    expect(diagnostics.storedOriginal).toBe(false);
    expect(input.storageKey).toBeNull();
    expect(input.poNumber).toBe('79904106/082');
  });
});

/* ── What the adapter must never decide ───────────────────────────────────── */

describe('the boundaries this file does not cross', () => {
  /*
   * A purchase order arrives three to four months before the work (Matt,
   * 28:40), so there is no job to attach it to. Suggesting one would mean
   * guessing which future pickup a builder had in mind.
   */
  it('never suggests a job', async () => {
    const { input } = await adaptExtraction(extraction(DOMAINE), context);

    expect(input.suggestedJobId).toBeNull();
    expect(input.jobCandidates).toEqual([]);
  });

  it('keeps the purchase-order number exactly as printed, dots and slashes intact', async () => {
    const domaine = await adaptExtraction(extraction(DOMAINE), context);
    const wisdom = await adaptExtraction(extraction(WISDOM), context);

    expect(domaine.input.poNumber).toBe('79904106/082');
    expect(wisdom.input.poNumber).toBe('208918.321.01');
  });
});
