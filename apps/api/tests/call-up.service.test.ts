import type { JobDraft, Role } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/lib/app-error.js';
import { todayInSydney } from '../src/lib/business-day.js';

/**
 * M2.12b — the call-up, the message that actually schedules the work.
 *
 * ── What is actually under test ───────────────────────────────────────────
 * Two things, and both are about refusing to guess.
 *
 * A call-up carries a PO number and a date and nothing else reliable. Turning
 * that into a job means resolving an order, a place and a zone — and the zone
 * prices the work. So every test here asks: when it cannot resolve something,
 * does it queue for a human, or does it invent an answer and send a truck?
 *
 * The second theme is arrival. These come from builders' systems by email, via a
 * vendor that retries on any non-2xx. One notice arrives twice; a green
 * reschedule follows a blue booking days later; occasionally a red cancellation
 * lands for a job that has already been collected.
 */

interface StoredCallUp {
  id: string;
  purchaseOrderId: string | null;
  poNumber: string;
  kind: string;
  readyDate: string | null;
  previousReadyDate: string | null;
  state: string;
  reason: string | null;
  jobId: string | null;
  jobNumber: number | null;
  source: string;
  externalId: string | null;
  resolvedBy: string | null;
  refusal: string | null;
  note: string;
}

interface StoredOrder {
  id: string;
  poNumber: string;
  accountId: string;
  accountName: string;
  lotNumber: string | null;
  addressLine: string | null;
  suburb: string | null;
  siteSupervisorName: string | null;
  siteSupervisorMobile: string | null;
  siteSupervisorUserId: string | null;
  jobId: string | null;
  jobNumber: number | null;
  jobStatus: string | null;
  jobReadyDate: string | null;
}

let callUps: StoredCallUp[] = [];
let orders: StoredOrder[] = [];
/** Suburbs the places table knows. The zone comes from here, so this gates pricing. */
let knownSuburbs: string[] = [];
let created: Array<{ draft: JobDraft; callerRoles: readonly Role[]; callerName: string }> = [];
let rescheduled: Array<{ jobId: string; readyDate: string }> = [];
let cancelled: Array<{ jobId: string; reason: string; note: string }> = [];
let nextJobNumber = 61500;
/** Set to make the booking itself refuse — as pricing does for an unrated date. */
let createRefusal: Error | null = null;

/**
 * Dates relative to TODAY, because the portal now refuses a day that has
 * passed — the fixed dates these tests used went stale the day they passed.
 */
function sydneyDay(offsetDays: number): string {
  const today = todayInSydney();
  const date = new Date(`${today}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}
const SOON = sydneyDay(7);
const LATER = sydneyDay(14);
const YESTERDAY = sydneyDay(-1);

let idCounter = 0;
const nextId = (): string => {
  idCounter += 1;
  return idCounter.toString(16).padStart(24, '0');
};

vi.mock('../src/domains/queues/call-up.repository.js', () => ({
  callUpRepository: {
    record: (input: Record<string, unknown>) => {
      const externalId = input.externalId as string | null;
      if (externalId) {
        const seen = callUps.find((row) => row.externalId === externalId);
        if (seen) return Promise.resolve({ id: seen.id, alreadySeen: true });
      }

      const row: StoredCallUp = {
        id: nextId(),
        purchaseOrderId: (input.purchaseOrderId as string | null) ?? null,
        poNumber: input.poNumber as string,
        kind: input.kind as string,
        readyDate: (input.readyDate as string | null) ?? null,
        previousReadyDate: null,
        state: input.state as string,
        reason: (input.reason as string | null) ?? null,
        jobId: null,
        jobNumber: null,
        source: input.source as string,
        externalId,
        resolvedBy: null,
        refusal: null,
        note: (input.note as string) ?? '',
      };
      callUps.push(row);
      return Promise.resolve({ id: row.id, alreadySeen: false });
    },

    setOutcome: (id: string, outcome: Record<string, unknown>) => {
      const row = callUps.find((entry) => entry.id === id);
      if (!row) return Promise.resolve(false);
      row.state = outcome.state as string;
      row.reason = (outcome.reason as string | null) ?? null;
      row.jobId = (outcome.jobId as string | null) ?? null;
      row.jobNumber = (outcome.jobNumber as number | null) ?? null;
      row.resolvedBy = (outcome.resolvedBy as string | null) ?? null;
      row.refusal = (outcome.refusal as string | null) ?? null;
      if (outcome.previousReadyDate !== undefined) {
        row.previousReadyDate = outcome.previousReadyDate as string | null;
      }
      return Promise.resolve(true);
    },

    appendNote: (id: string, note: string) => {
      const row = callUps.find((entry) => entry.id === id);
      if (!row || note === '') return Promise.resolve(false);
      row.note = row.note === '' ? note : `${row.note} · ${note}`;
      return Promise.resolve(true);
    },

    remove: (id: string) => {
      callUps = callUps.filter((row) => !(row.id === id && row.source !== 'email'));
      return Promise.resolve();
    },

    findById: (id: string) => Promise.resolve(callUps.find((row) => row.id === id) ?? null),
    findMatches: (poNumber: string) =>
      Promise.resolve(orders.filter((order) => order.poNumber === poNumber.trim())),
    // Mirrors the real anchoring: "<job>/" at the start, and never for a number with a slash.
    findMatchesByJobNumber: (jobNumber: string) =>
      Promise.resolve(
        jobNumber.includes('/')
          ? []
          : orders.filter((order) => order.poNumber.startsWith(`${jobNumber.trim()}/`)),
      ),
    findOrder: (id: string) => Promise.resolve(orders.find((order) => order.id === id) ?? null),
    list: () =>
      Promise.resolve({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } }),
    countNeedingReview: () =>
      Promise.resolve(callUps.filter((row) => row.state === 'needs-review').length),
    listAwaiting: () =>
      Promise.resolve({
        data: orders
          .filter((order) => order.jobId === null)
          .map((order) => ({
            purchaseOrderId: order.id,
            poNumber: order.poNumber,
            accountId: order.accountId,
            accountName: order.accountName,
            receivedAt: '2026-09-01T00:00:00.000Z',
            lotNumber: order.lotNumber,
            addressLine: order.addressLine,
            suburb: order.suburb,
            expectedAreaM2: 823.41,
            bagAllowance: 2,
            siteSupervisorName: order.siteSupervisorName,
          })),
        meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
      }),
  },
}));

vi.mock('../src/domains/places/place.repository.js', () => ({
  placeRepository: {
    /*
     * Mirrors the real search's fuzziness on purpose: it matches mid-word, which
     * is right for a picker and is exactly why the service demands an EXACT
     * suburb match before it will price a job.
     */
    search: (query: string) =>
      Promise.resolve(
        knownSuburbs
          .filter((suburb) => suburb.toLowerCase().includes(query.trim().toLowerCase()))
          .map((suburb) => ({
            id: suburb.toLowerCase().replace(/\s+/g, '-'),
            suburb,
            postcode: '2155',
            state: 'NSW',
            zone: 'sydney' as const,
            latitude: -33.7,
            longitude: 150.9,
            label: `${suburb} NSW 2155`,
          })),
      ),
  },
}));

vi.mock('../src/domains/jobs/job.service.js', () => ({
  jobService: {
    create: (draft: JobDraft, caller: { roles: readonly Role[]; name: string }) => {
      if (createRefusal) return Promise.reject(createRefusal);
      created.push({ draft, callerRoles: caller.roles, callerName: caller.name });
      nextJobNumber += 1;
      return Promise.resolve({ id: nextId(), jobNumber: nextJobNumber });
    },
    reschedule: (jobId: string, readyDate: string) => {
      rescheduled.push({ jobId, readyDate });
      return Promise.resolve();
    },
    cancel: (jobId: string, reason: string, note: string) => {
      cancelled.push({ jobId, reason, note });
      return Promise.resolve();
    },
  },
}));

const { callUpService } = await import('../src/domains/queues/call-up.service.js');

const OFFICE = {
  userId: 'usr0000000000000000000f1',
  name: 'Renee Boyle',
  roles: ['operations'] as Role[],
  accountId: null,
};

const SUPERVISOR = {
  userId: 'usr00000000000000000sv1',
  name: 'Dane Whitfield',
  roles: ['customer-site-supervisor'] as Role[],
  accountId: 'acc0000000000000000000a1',
};

const DRIVER = {
  userId: 'usr0000000000000000000d1',
  name: 'Troy Holm',
  roles: ['driver'] as Role[],
  accountId: null,
};

/** The Wisdom order, waiting for a date. */
function order(overrides: Partial<StoredOrder> = {}): StoredOrder {
  return {
    id: 'po00000000000000000000w1',
    poNumber: '4500123456',
    accountId: 'acc0000000000000000000a1',
    accountName: 'Wisdom Homes',
    lotNumber: '214',
    addressLine: '46 Allambie Circuit',
    suburb: 'Kellyville',
    siteSupervisorName: 'Matthew French',
    siteSupervisorMobile: '0412 345 678',
    siteSupervisorUserId: 'usr00000000000000000mf1',
    jobId: null,
    jobNumber: null,
    jobStatus: null,
    jobReadyDate: null,
    ...overrides,
  };
}

function email(overrides: Record<string, unknown> = {}) {
  return {
    poNumber: '4500123456',
    kind: 'new' as const,
    readyDate: '2026-09-21',
    receivedAt: new Date('2026-09-14T02:00:00.000Z'),
    source: 'email' as const,
    note: '',
    externalId: 'ext-1',
    ...overrides,
  };
}

const latest = (): StoredCallUp | undefined => callUps[callUps.length - 1];

beforeEach(() => {
  callUps = [];
  orders = [order()];
  knownSuburbs = ['Kellyville', 'Kellyville Ridge'];
  created = [];
  rescheduled = [];
  cancelled = [];
  nextJobNumber = 61500;
  createRefusal = null;
});

/* ── The happy path, which is most of the traffic ─────────────────────────── */

describe('a new booking (Matt’s blue notice)', () => {
  it('turns a waiting order into a job on the date the email named', async () => {
    const outcome = await callUpService.record(email());

    expect(outcome.state).toBe('applied');
    expect(created).toHaveLength(1);
    expect(created[0]?.draft.readyDate).toBe('2026-09-21');
    // The order supplies the figures; the draft only points at it.
    expect(created[0]?.draft.purchaseOrderId).toBe('po00000000000000000000w1');
  });

  /*
   * ⚠️ The job must be booked as the OFFICE, not as a customer. `jobService`
   * scopes a job to a customer caller, so a system booking claiming a customer
   * role would scope every emailed job to a synthetic user — invisible to the
   * supervisor who needs it. As office, the scoping falls to the order's own
   * supervisor instead (Matt, 33:57).
   */
  it('books as the office so the order’s supervisor keeps the scoping', async () => {
    await callUpService.record(email());

    expect(created[0]?.callerRoles).toContain('operations');
    expect(created[0]?.callerRoles).not.toContain('customer-site-supervisor');
  });

  /* Drivers navigate by the lot — a house on a new estate has no letterbox. */
  it('names the site by its lot number', async () => {
    await callUpService.record(email());

    expect(created[0]?.draft.siteName).toBe('Lot 214');
  });

  it('records the job it produced against the call-up', async () => {
    await callUpService.record(email());

    expect(latest()?.state).toBe('applied');
    expect(latest()?.jobNumber).toBe(61501);
  });
});

describe('what the driver is given', () => {
  /*
   * ⚠️ The mobile used to be dropped.
   *
   * `book()` hard-coded an empty `siteContactMobile` while carrying the
   * supervisor’s NAME through — so every job booked from a call-up reached the
   * driver with somebody to ask for and no way to ring them, and the app fell
   * back to "No site contact on this job — ring the office". The number was on
   * the order the whole time; `MatchedOrder` simply never carried it.
   */
  it('carries the supervisor’s mobile onto the job', async () => {
    await callUpService.record(email());

    expect(created[0]?.draft.siteContactName).toBe('Matthew French');
    expect(created[0]?.draft.siteContactMobile).toBe('0412 345 678');
  });

  it('leaves the mobile empty when the order has none, rather than failing', async () => {
    orders = [order({ siteSupervisorMobile: null })];

    const outcome = await callUpService.record(email());

    expect(outcome.state).toBe('applied');
    expect(created[0]?.draft.siteContactMobile).toBe('');
  });
});

describe('an order whose job was cancelled', () => {
  /*
   * A builder may re-book work they called off, and `book`, `listAwaiting` and
   * `jobsForPurchaseOrders` all agree that a cancelled job does not hold its
   * order. The product enforces it by nulling `purchaseOrderId` on cancel; this
   * pins the call-up half.
   */
  it('books it again rather than calling it already-booked', async () => {
    orders = [
      order({
        jobId: 'job1',
        jobNumber: 61501,
        jobStatus: 'cancelled',
        jobReadyDate: '2026-09-21',
      }),
    ];

    const outcome = await callUpService.record(email());

    expect(outcome.state).toBe('applied');
    expect(created).toHaveLength(1);
  });
});

/* ── Arrival: the same notice, more than once ───────────────────────────── */

describe('the same email arriving twice', () => {
  /*
   * ⚠️ The regression that would double-book every job. The vendor retries a
   * webhook on any non-2xx, and builders' systems resend. Two jobs means two
   * trucks to one house.
   */
  it('books once, however many times the webhook fires', async () => {
    await callUpService.record(email());
    await callUpService.record(email());
    await callUpService.record(email());

    expect(created).toHaveLength(1);
    expect(callUps).toHaveLength(1);
  });

  it('answers the retry with the outcome of the first attempt', async () => {
    const first = await callUpService.record(email());
    const second = await callUpService.record(email());

    expect(second.id).toBe(first.id);
    expect(second.state).toBe('applied');
    expect(second.jobNumber).toBe(first.jobNumber);
  });

  /* A different notice about the same order is a different event. */
  it('still accepts a genuinely different email for the same order', async () => {
    await callUpService.record(email());
    orders = [order({ jobId: 'job1', jobNumber: 61501, jobStatus: 'booked', jobReadyDate: '2026-09-21' })];

    await callUpService.record(
      email({ externalId: 'ext-2', kind: 'reschedule', readyDate: '2026-09-24' }),
    );

    expect(callUps).toHaveLength(2);
    expect(rescheduled).toEqual([{ jobId: 'job1', readyDate: '2026-09-24' }]);
  });
});

/* ── Reschedules and cancellations ──────────────────────────────────────── */

describe('a reschedule (Matt’s green notice)', () => {
  beforeEach(() => {
    orders = [
      order({ jobId: 'job1', jobNumber: 61501, jobStatus: 'booked', jobReadyDate: '2026-09-21' }),
    ];
  });

  it('moves the existing job rather than booking a second one', async () => {
    await callUpService.record(email({ kind: 'reschedule', readyDate: '2026-09-24' }));

    expect(rescheduled).toEqual([{ jobId: 'job1', readyDate: '2026-09-24' }]);
    expect(created).toHaveLength(0);
  });

  /* So the office can see the change, not infer it from an audit trail. */
  it('records the date it moved from', async () => {
    await callUpService.record(email({ kind: 'reschedule', readyDate: '2026-09-24' }));

    expect(latest()?.previousReadyDate).toBe('2026-09-21');
    expect(latest()?.readyDate).toBe('2026-09-24');
  });

  /*
   * Matt, 24:07, gets greens for jobs he never saw a blue for — the builder's
   * first notice sometimes goes missing. A reschedule carries a date but says
   * nothing about whether the work was ever ordered, so it is not a booking.
   */
  it('queues a reschedule for an order with no job yet', async () => {
    orders = [order()];

    const outcome = await callUpService.record(email({ kind: 'reschedule' }));

    expect(outcome.state).toBe('needs-review');
    expect(outcome.reason).toBe('no-job-to-change');
    expect(created).toHaveLength(0);
    expect(rescheduled).toHaveLength(0);
  });

  it('refuses to move a job that has already been collected', async () => {
    orders = [
      order({ jobId: 'job1', jobNumber: 61501, jobStatus: 'completed', jobReadyDate: '2026-09-21' }),
    ];

    const outcome = await callUpService.record(email({ kind: 'reschedule' }));

    expect(outcome.reason).toBe('job-finished');
    expect(rescheduled).toHaveLength(0);
  });
});

describe('a cancellation (Matt’s red notice)', () => {
  /*
   * Ten in four years (Matt, 24:24) — and each one ignored is a truck that
   * drives to a site with nothing on it. Rarity is not a reason to skip it.
   */
  it('cancels the job', async () => {
    orders = [
      order({ jobId: 'job1', jobNumber: 61501, jobStatus: 'booked', jobReadyDate: '2026-09-21' }),
    ];

    const outcome = await callUpService.record(
      email({ kind: 'cancel', readyDate: null, note: 'Slab delayed' }),
    );

    expect(outcome.state).toBe('applied');
    expect(cancelled).toEqual([
      { jobId: 'job1', reason: 'customer-request', note: 'Slab delayed' },
    ]);
  });

  it('does not need a date', async () => {
    orders = [
      order({ jobId: 'job1', jobNumber: 61501, jobStatus: 'booked', jobReadyDate: '2026-09-21' }),
    ];

    await callUpService.record(email({ kind: 'cancel', readyDate: null }));

    expect(latest()?.state).toBe('applied');
    expect(latest()?.readyDate).toBeNull();
  });
});

/* ── Everything it refuses to guess at ──────────────────────────────────── */

describe('what it will not guess', () => {
  /*
   * ⚠️ The one that would put a truck on a road for work nobody ordered. A
   * call-up naming an order we do not have is not a booking — it is an email to
   * look at.
   */
  it('queues a call-up for a PO number nobody has on file', async () => {
    orders = [];

    const outcome = await callUpService.record(email());

    expect(outcome.state).toBe('needs-review');
    expect(outcome.reason).toBe('no-matching-po');
    expect(created).toHaveLength(0);
  });

  /* And still stores it, so the work is not silently lost. */
  it('stores an unmatched call-up rather than dropping the email', async () => {
    orders = [];

    await callUpService.record(email());

    expect(callUps).toHaveLength(1);
    expect(latest()?.poNumber).toBe('4500123456');
    expect(latest()?.purchaseOrderId).toBeNull();
  });

  /*
   * A PO number is unique per ACCOUNT, not globally. Picking one of two would
   * schedule the wrong builder's work.
   */
  it('queues a number that matches two accounts', async () => {
    orders = [order(), order({ id: 'po00000000000000000000d1', accountId: 'acc-other', accountName: 'Domaine' })];

    const outcome = await callUpService.record(email());

    expect(outcome.reason).toBe('ambiguous-po');
    expect(created).toHaveLength(0);
  });

  /*
   * ⚠️ The zone prices the job and comes from the place, never from the order's
   * free text. "We do not go there" is a real answer, so an unmatched suburb
   * queues instead of defaulting to a zone and pricing the work wrong.
   */
  it('queues an order whose suburb is not one we service', async () => {
    knownSuburbs = ['Kellyville'];
    orders = [order({ suburb: 'Bendigo' })];

    const outcome = await callUpService.record(email());

    expect(outcome.reason).toBe('unknown-suburb');
    expect(created).toHaveLength(0);
  });

  /*
   * The picker's search matches mid-word so a human typing "park" finds "Oran
   * Park". There is nobody to choose here, so an ambiguous suburb is refused
   * rather than resolved to whichever came back first.
   */
  it('queues a suburb that names more than one place', async () => {
    knownSuburbs = ['Kellyville', 'Kellyville Ridge'];
    orders = [order({ suburb: 'Kellyvil' })];

    const outcome = await callUpService.record(email());

    expect(outcome.reason).toBe('unknown-suburb');
  });

  it('takes an exact suburb even when a longer one also contains it', async () => {
    knownSuburbs = ['Kellyville', 'Kellyville Ridge'];
    orders = [order({ suburb: 'Kellyville' })];

    const outcome = await callUpService.record(email());

    expect(outcome.state).toBe('applied');
    expect(created[0]?.draft.placeId).toBe('kellyville');
  });

  /* A resent blue notice for work already on the board is not a second job. */
  it('queues a new booking for an order that already has a job', async () => {
    orders = [
      order({ jobId: 'job1', jobNumber: 61501, jobStatus: 'booked', jobReadyDate: '2026-09-21' }),
    ];

    const outcome = await callUpService.record(email({ externalId: 'ext-9' }));

    expect(outcome.reason).toBe('already-booked');
    expect(created).toHaveLength(0);
  });

  /* Work that was called off can be called up again. */
  it('books an order whose previous job was cancelled', async () => {
    orders = [
      order({ jobId: 'job1', jobNumber: 61501, jobStatus: 'cancelled', jobReadyDate: '2026-09-21' }),
    ];

    const outcome = await callUpService.record(email());

    expect(outcome.state).toBe('applied');
    expect(created).toHaveLength(1);
  });

  it('queues a booking with no readable date, and says so', async () => {
    const outcome = await callUpService.record(email({ readyDate: null }));

    expect(outcome.state).toBe('needs-review');
    // Was "no-job-to-change", which sent the office looking for a missing job.
    expect(outcome.reason).toBe('no-date');
    expect(created).toHaveLength(0);
  });

  /*
   * An email has nobody to show a refusal to, so it is KEPT — with a reason,
   * and the refusal itself on the note so the office knows what to fix.
   */
  it('keeps an emailed call-up that could not be booked, with the refusal beside it', async () => {
    createRefusal = AppError.validation('No rate covers Kellyville on that day');

    const outcome = await callUpService.record(email());

    expect(outcome.state).toBe('needs-review');
    expect(outcome.reason).toBe('cannot-book');
    expect(latest()?.refusal).toBe('No rate covers Kellyville on that day');
    // Not on the note — the note becomes the job's notes when it books.
    expect(latest()?.note).not.toContain('No rate covers');
  });

  /*
   * Seen live: job #61311 was booked by Try again and its notes still ended
   * "No rate covers Wollongong on 2026-09-17" — long after the rate was fixed.
   */
  it('books the job without the old refusal, and clears it', async () => {
    createRefusal = AppError.validation('No rate covers Kellyville on that day');
    const first = await callUpService.record(email({ note: 'Please attend site' }));
    createRefusal = null;

    const retried = await callUpService.retry(first.id, OFFICE);

    expect(retried.state).toBe('applied');
    expect(created[0]?.draft.notes).toBe('Please attend site');
    expect(latest()?.refusal).toBeNull();
  });
});

/* ── A notice that names the builder's JOB, not the order ──────────────── */

/*
 * The client's real Domaine "Construction Notification" prints "Job Details
 * 79903057" and no PO number; their orders are numbered "79903057/080".
 */
describe('a call-up that gives the builder’s job number', () => {
  const DOMAINE_PO = 'po00000000000000000000d1';

  it('matches the job number to the order under it', async () => {
    orders = [order({ id: DOMAINE_PO, poNumber: '79903057/080' })];

    const outcome = await callUpService.record(email({ poNumber: '79903057' }));

    expect(outcome.state).toBe('applied');
    expect(created[0]?.draft.purchaseOrderId).toBe(DOMAINE_PO);
  });

  it('still prefers an order whose number matches exactly', async () => {
    orders = [
      order({ id: 'po00000000000000000000e1', poNumber: '79903057' }),
      order({ id: DOMAINE_PO, poNumber: '79903057/080' }),
    ];

    await callUpService.record(email({ poNumber: '79903057' }));

    expect(created[0]?.draft.purchaseOrderId).toBe('po00000000000000000000e1');
  });

  it('queues two orders under one job rather than choosing', async () => {
    orders = [
      order({ id: DOMAINE_PO, poNumber: '79903057/080' }),
      order({ id: 'po00000000000000000000d2', poNumber: '79903057/081' }),
    ];

    const outcome = await callUpService.record(email({ poNumber: '79903057' }));

    expect(outcome.reason).toBe('ambiguous-po');
    expect(created).toHaveLength(0);
  });

  it('does not stretch a shorter number into a longer job', async () => {
    orders = [order({ id: DOMAINE_PO, poNumber: '79903057/080' })];

    const outcome = await callUpService.record(email({ poNumber: '7990305' }));

    expect(outcome.reason).toBe('no-matching-po');
  });
});

/* ── The manual fallback (Matt, 29:03 and 30:40) ────────────────────────── */

describe('calling an order up by hand', () => {
  it('lets a site supervisor book their own account’s order', async () => {
    const outcome = await callUpService.callUpByHand(
      'po00000000000000000000w1',
      { readyDate: SOON, note: '' },
      SUPERVISOR,
    );

    expect(outcome.state).toBe('applied');
    expect(created).toHaveLength(1);
    expect(latest()?.source).toBe('portal');
  });

  /*
   * A supervisor giving a date is telling us when to come; a day that has
   * passed is a slip of the calendar. Refused on the date field, and nothing is
   * left behind in the office queue.
   */
  it('refuses a day that has passed from the portal, on the date field', async () => {
    await expect(
      callUpService.callUpByHand(
        'po00000000000000000000w1',
        { readyDate: YESTERDAY, note: '' },
        SUPERVISOR,
      ),
    ).rejects.toMatchObject({
      status: 422,
      issues: [expect.objectContaining({ path: 'readyDate' })],
    });

    expect(created).toHaveLength(0);
    expect(callUps).toHaveLength(0);
  });

  /* The office is relaying "the site has been ready since Monday". */
  it('lets the office relay a ready date that has passed', async () => {
    const outcome = await callUpService.callUpByHand(
      'po00000000000000000000w1',
      { readyDate: YESTERDAY, note: '' },
      OFFICE,
    );

    expect(outcome.state).toBe('applied');
  });

  /*
   * ⚠️ These used to stay in "Call-ups to check" as needs-review with no reason
   * — and "Try again" could only fail the same way. The person who asked sees
   * the refusal on the dialog instead, and the queue stays clean.
   */
  it('leaves nothing in the queue when the booking is refused on the spot', async () => {
    createRefusal = AppError.validation('No rate covers Newcastle on that day', [
      { path: 'readyDate', message: 'Rates start later' },
    ]);

    await expect(
      callUpService.callUpByHand(
        'po00000000000000000000w1',
        { readyDate: SOON, note: '' },
        OFFICE,
      ),
    ).rejects.toMatchObject({ status: 422 });

    expect(callUps).toHaveLength(0);
  });

  /* The same line the portal draws around a supervisor's jobs. */
  it('limits a supervisor-only login to orders that name them', async () => {
    await expect(
      callUpService.callUpByHand(
        'po00000000000000000000w1',
        { readyDate: SOON, note: '' },
        SUPERVISOR,
        { siteSupervisorUserId: 'usr-somebody-else' },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(created).toHaveLength(0);

    const own = await callUpService.callUpByHand(
      'po00000000000000000000w1',
      { readyDate: SOON, note: '' },
      SUPERVISOR,
      { siteSupervisorUserId: 'usr00000000000000000mf1' },
    );
    expect(own.state).toBe('applied');
  });

  /*
   * The job's history printed "Call-up email" for a job the office phoned in
   * or a supervisor booked in the portal. The ROLES stay the system's — only
   * the name, which is what the history shows, is the person's.
   */
  it('names the person, and how they asked, in the job’s history', async () => {
    await callUpService.callUpByHand(
      'po00000000000000000000w1',
      { readyDate: SOON, note: '' },
      SUPERVISOR,
    );
    expect(created[0]?.callerName).toBe('Dane Whitfield · portal');
    expect(created[0]?.callerRoles).toEqual(['operations']);

    orders = [order({ id: 'po00000000000000000000w2', poNumber: '4500999999' })];
    await callUpService.callUpByHand(
      'po00000000000000000000w2',
      { readyDate: SOON, note: '' },
      OFFICE,
    );
    expect(created[1]?.callerName).toBe('Renee Boyle · phoned in');
  });

  /*
   * ⚠️ Not a hidden screen — a data boundary. Without this one builder can book
   * a truck against another builder's purchase order, which is billable work on
   * somebody else's money. 404 rather than 403: a 403 confirms the order exists.
   */
  it('refuses an order belonging to another account', async () => {
    orders = [order({ accountId: 'acc-someone-else' })];

    await expect(
      callUpService.callUpByHand(
        'po00000000000000000000w1',
        { readyDate: SOON, note: '' },
        SUPERVISOR,
      ),
    ).rejects.toMatchObject({ status: 404 });

    expect(created).toHaveLength(0);
  });

  it('lets the office call up any account’s order, as a phone booking', async () => {
    orders = [order({ accountId: 'acc-someone-else' })];

    const outcome = await callUpService.callUpByHand(
      'po00000000000000000000w1',
      { readyDate: SOON, note: 'Called in by the builder' },
      OFFICE,
    );

    expect(outcome.state).toBe('applied');
    expect(latest()?.source).toBe('phone');
  });

  /*
   * Nobody calling up an order thinks "new" versus "reschedule" — they are
   * picking a date. Which of the two it is is a fact about the order.
   */
  it('moves the date when the order already has a job', async () => {
    orders = [
      order({ jobId: 'job1', jobNumber: 61501, jobStatus: 'booked', jobReadyDate: SOON }),
    ];

    await callUpService.callUpByHand(
      'po00000000000000000000w1',
      { readyDate: LATER, note: '' },
      SUPERVISOR,
    );

    expect(rescheduled).toEqual([{ jobId: 'job1', readyDate: LATER }]);
    expect(created).toHaveLength(0);
  });

  it('404s an order that does not exist', async () => {
    await expect(
      callUpService.callUpByHand(
        'po0000000000000000000zzz',
        { readyDate: SOON, note: '' },
        OFFICE,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

/*
 * Every reason a call-up queues is a fixable data problem OUTSIDE the message —
 * an unconfirmed order, a suburb nobody had added, two accounts sharing a PO
 * number. Once that is sorted the email is perfectly good, so the office fixes
 * the data and presses Try again rather than re-keying the date into a form.
 */
describe('working the queue', () => {
  /** Queues a call-up by making sure nothing matches it. */
  const queueOne = async () => {
    orders = [];
    const outcome = await callUpService.record(email());
    expect(outcome.reason).toBe('no-matching-po');
    return outcome.id;
  };

  it('books a queued call-up once the order exists', async () => {
    const id = await queueOne();

    // The office confirms the purchase order that was missing.
    orders = [order()];

    const retried = await callUpService.retry(id, OFFICE);

    expect(retried.state).toBe('applied');
    expect(retried.jobNumber).toBe(61501);
    expect(created).toHaveLength(1);
  });

  /*
   * ⚠️ Re-resolves from scratch. The stored row's `purchaseOrderId` is null on
   * this path, so a retry that trusted the earlier match would find nothing
   * forever.
   */
  it('re-matches from the PO number rather than the earlier result', async () => {
    const id = await queueOne();
    expect(latest()?.purchaseOrderId).toBeNull();

    orders = [order()];
    await callUpService.retry(id, OFFICE);

    expect(latest()?.jobId).not.toBeNull();
  });

  /* A retry can fail for a NEW reason, and saying which is the whole value. */
  it('reports the next reason when the retry still cannot be applied', async () => {
    const id = await queueOne();

    // The order now exists, but its suburb is not one we service.
    knownSuburbs = ['Kellyville'];
    orders = [order({ suburb: 'Bendigo' })];

    const retried = await callUpService.retry(id, OFFICE);

    expect(retried.state).toBe('needs-review');
    expect(retried.reason).toBe('unknown-suburb');
    expect(created).toHaveLength(0);
  });

  /*
   * ⚠️ The one that would double-book. An applied call-up has already produced
   * or moved a job; running it again would create a second one, and the second
   * would look like the authoritative record.
   */
  it('refuses to retry a call-up that already produced a job', async () => {
    await callUpService.record(email());
    const id = latest()?.id ?? '';
    expect(latest()?.state).toBe('applied');

    await expect(callUpService.retry(id, OFFICE)).rejects.toMatchObject({ status: 409 });
    expect(created).toHaveLength(1);
  });

  it('sets one aside with the reason a person gave', async () => {
    const id = await queueOne();

    await callUpService.reject(id, 'Builder cancelled this months ago', OFFICE);

    expect(latest()?.state).toBe('rejected');
    expect(latest()?.resolvedBy).toBe(OFFICE.name);
    // What the email said is kept alongside what the reviewer said.
    expect(latest()?.note).toContain('Builder cancelled this months ago');
  });

  /* Cancelling the job is a different act from setting the message aside. */
  it('refuses to set aside one that already produced a job', async () => {
    await callUpService.record(email());
    const id = latest()?.id ?? '';

    await expect(callUpService.reject(id, 'not needed', OFFICE)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses a driver on both actions', async () => {
    const id = await queueOne();

    await expect(callUpService.retry(id, DRIVER)).rejects.toMatchObject({ status: 403 });
    await expect(callUpService.reject(id, 'no', DRIVER)).rejects.toMatchObject({ status: 403 });
  });

  it('404s a call-up that does not exist', async () => {
    await expect(
      callUpService.retry('ffffffffffffffffffffffff', OFFICE),
    ).rejects.toMatchObject({ status: 404 });
  });

  /*
   * ⚠️ One that already names an order stays on it. Re-resolving by number
   * turned an item raised against ONE order into "More than one order has that
   * number" the moment another builder used the same string.
   */
  it('retries against the order it was raised on, not every order sharing the number', async () => {
    knownSuburbs = ['Kellyville'];
    orders = [order({ suburb: 'Bendigo' })];

    const queued = await callUpService.callUpByHand(
      'po00000000000000000000w1',
      { readyDate: SOON, note: '' },
      OFFICE,
    );
    expect(queued.reason).toBe('unknown-suburb');

    // Another builder happens to use the same number; the suburb is then added.
    orders = [
      order({ suburb: 'Bendigo' }),
      order({ id: 'po00000000000000000000x9', accountId: 'acc-other', accountName: 'Other' }),
    ];
    knownSuburbs = ['Kellyville', 'Bendigo'];

    const retried = await callUpService.retry(queued.id, OFFICE);

    expect(retried.state).toBe('applied');
    expect(created[0]?.draft.purchaseOrderId).toBe('po00000000000000000000w1');
  });

  /* A retry the booking still refuses says why on the item, not as an error. */
  it('parks a retry the booking refuses, with the refusal beside it', async () => {
    const id = await queueOne();
    orders = [order()];
    createRefusal = AppError.validation('No rate covers Kellyville on that day');

    const retried = await callUpService.retry(id, OFFICE);

    expect(retried.state).toBe('needs-review');
    expect(retried.reason).toBe('cannot-book');
    expect(latest()?.refusal).toBe('No rate covers Kellyville on that day');
  });
});

/* ── The schema, because a mocked repository cannot see it ───────────────── */

describe('the call-up record itself', () => {
  /*
   * ⚠️ Regression for 15 Sept. `externalId` was deleted from the schema and
   * `resolvedAt`/`resolvedBy` were commented out by a dangling `/**`. With
   * `strictQuery` on, `findOne({ externalId })` then matched the FIRST row, so
   * every call-up email after the first was "already seen" and dropped.
   */
  it('declares every field the repository filters or writes on', async () => {
    const { CallUpModel } = await import('../src/domains/queues/call-up.model.js');

    for (const path of ['externalId', 'resolvedAt', 'resolvedBy', 'raisedBy', 'note']) {
      expect(CallUpModel.schema.path(path), path).toBeDefined();
    }
  });
});

/* ── Who may work the queue ─────────────────────────────────────────────── */

describe('who may see call-ups', () => {
  it('refuses a driver', async () => {
    await expect(callUpService.list({ page: 1, pageSize: 20 }, DRIVER)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('allows the office', async () => {
    await expect(
      callUpService.list({ page: 1, pageSize: 20 }, OFFICE),
    ).resolves.toMatchObject({ data: [] });
  });

  /*
   * The office needs to know an order cannot be booked BEFORE the email lands,
   * not from a queue item afterwards — so serviceability is answered on the
   * waiting list itself.
   */
  it('flags a waiting order whose suburb we do not service', async () => {
    orders = [order({ suburb: 'Bendigo' })];

    const page = await callUpService.listAwaiting({ page: 1, pageSize: 20 }, OFFICE);

    expect(page.data[0]?.serviceable).toBe(false);
  });

  it('marks a serviceable waiting order as bookable', async () => {
    const page = await callUpService.listAwaiting({ page: 1, pageSize: 20 }, OFFICE);

    expect(page.data[0]?.serviceable).toBe(true);
  });
});
