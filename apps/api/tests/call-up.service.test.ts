import type { JobDraft, Role } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
let created: Array<{ draft: JobDraft; callerRoles: readonly Role[] }> = [];
let rescheduled: Array<{ jobId: string; readyDate: string }> = [];
let cancelled: Array<{ jobId: string; reason: string; note: string }> = [];
let nextJobNumber = 61500;

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

    findById: (id: string) => Promise.resolve(callUps.find((row) => row.id === id) ?? null),
    findMatches: (poNumber: string) =>
      Promise.resolve(orders.filter((order) => order.poNumber === poNumber.trim())),
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
    create: (draft: JobDraft, caller: { roles: readonly Role[] }) => {
      created.push({ draft, callerRoles: caller.roles });
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

  it('queues a booking with no readable date', async () => {
    const outcome = await callUpService.record(email({ readyDate: null }));

    expect(outcome.state).toBe('needs-review');
    expect(created).toHaveLength(0);
  });
});

/* ── The manual fallback (Matt, 29:03 and 30:40) ────────────────────────── */

describe('calling an order up by hand', () => {
  it('lets a site supervisor book their own account’s order', async () => {
    const outcome = await callUpService.callUpByHand(
      'po00000000000000000000w1',
      { readyDate: '2026-09-21', note: '' },
      SUPERVISOR,
    );

    expect(outcome.state).toBe('applied');
    expect(created).toHaveLength(1);
    expect(latest()?.source).toBe('portal');
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
        { readyDate: '2026-09-21', note: '' },
        SUPERVISOR,
      ),
    ).rejects.toMatchObject({ status: 404 });

    expect(created).toHaveLength(0);
  });

  it('lets the office call up any account’s order, as a phone booking', async () => {
    orders = [order({ accountId: 'acc-someone-else' })];

    const outcome = await callUpService.callUpByHand(
      'po00000000000000000000w1',
      { readyDate: '2026-09-21', note: 'Called in by the builder' },
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
      order({ jobId: 'job1', jobNumber: 61501, jobStatus: 'booked', jobReadyDate: '2026-09-21' }),
    ];

    await callUpService.callUpByHand(
      'po00000000000000000000w1',
      { readyDate: '2026-09-28', note: '' },
      SUPERVISOR,
    );

    expect(rescheduled).toEqual([{ jobId: 'job1', readyDate: '2026-09-28' }]);
    expect(created).toHaveLength(0);
  });

  it('404s an order that does not exist', async () => {
    await expect(
      callUpService.callUpByHand(
        'po0000000000000000000zzz',
        { readyDate: '2026-09-21', note: '' },
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
