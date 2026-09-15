import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearOutbound,
  makeFakeNotificationRepository,
  recordingProviders,
  sentMessages,
} from './helpers/fake-outbound.js';
import type { JobDraft, Role } from '@plastago/shared';
import { createFakeJobRepository } from './helpers/fake-jobs.js';
import { createFakeSettingsRepository } from './helpers/fake-settings.js';

/**
 * Job rules (M2).
 *
 * These test the four things a repository cannot: who sees which jobs, how a
 * booking form becomes a priced job, which state changes are refused, and what
 * the office is told when a cancel races a completion.
 */

let repo: ReturnType<typeof createFakeJobRepository>;
let settings: ReturnType<typeof createFakeSettingsRepository>;

/** A stand-in for the accounts repository — jobs only ever reads one account. */
const account = {
  id: 'acc0000000000000000000a1',
  name: 'Clarendon Homes',
  brandId: 'plastago' as const,
  rateCardId: 'clarendon-domaine' as const,
  status: 'active' as 'active' | 'inactive',
  riskAssessmentRequired: true,
};

let accountScope: { accountId: string | null } | null = null;
let accountFound = true;

// GETTERS, not values: `vi.mock` factories hoist above every import, so the
// fakes do not exist yet when these run.
vi.mock('../src/domains/jobs/job.repository.js', () => ({
  get jobRepository() {
    return repo.repository;
  },
  writeQuotedCharges: (
    jobId: string,
    lines: ReadonlyArray<{ code: string; amount: string }>,
  ) => {
    quotedCharges.push({ jobId, lines });
    return Promise.resolve();
  },
}));

/** What the quote persisted as the job's own charge lines. See below. */
const quotedCharges: Array<{
  jobId: string;
  lines: ReadonlyArray<{ code: string; amount: string }>;
}> = [];

vi.mock('../src/domains/settings/settings.repository.js', () => ({
  get settingsRepository() {
    return settings.repository;
  },
}));

vi.mock('../src/domains/accounts/account.repository.js', () => ({
  accountRepository: {
    findById: (id: string, scope: { accountId: string | null }) => {
      accountScope = scope;
      return Promise.resolve(accountFound ? { ...account, id } : null);
    },
  },
}));

vi.mock('../src/domains/places/place.service.js', () => ({
  placeService: {
    require: (placeId: string) => {
      if (placeId === 'perth') {
        return Promise.reject(
          Object.assign(new Error('not serviced'), { status: 422, code: 'VALIDATION_FAILED' }),
        );
      }
      return Promise.resolve({
        id: placeId,
        suburb: 'Kellyville',
        postcode: '2155',
        state: 'NSW',
        zone: 'sydney' as const,
        latitude: -33.7118,
        longitude: 150.9542,
        label: 'Kellyville NSW 2155',
      });
    },
  },
}));

/*
 * M8.1 / M8.2 — booking a job, moving it and completing it now message the site
 * contact, and every send is logged. Faked like every other repository: the
 * real one would buffer a write against a MongoDB that is not there.
 */
vi.mock('../src/domains/notifications/notification.repository.js', () => ({
  notificationRepository: makeFakeNotificationRepository(),
}));

/**
 * Google, as a recording double (I3).
 *
 * ⚠️ Nothing in this file may reach the real geocoder. These tests run on every
 * commit and each lookup is BILLED, so a suite that quietly spends money is a
 * suite somebody eventually turns off. The default is `null` — no answer —
 * which is also the honest default in an environment with no key.
 */
const maps = {
  geocode: vi.fn().mockResolvedValue(null),
  optimiseStopOrder: vi.fn().mockResolvedValue(null),
};

vi.mock('../src/integrations/maps.js', async (importOriginal) => {
  // `isPrecise` is real policy, not a collaborator — faking it would leave the
  // rule that decides which pins are good enough untested.
  const actual = await importOriginal<typeof import('../src/integrations/maps.js')>();
  return { ...actual, getMapsProvider: () => ({ name: 'test', ...maps }) };
});

const { jobService } = await import('../src/domains/jobs/job.service.js');
const { setMessagingProvidersForTests } = await import('../src/integrations/messaging.js');

const OFFICE = {
  userId: 'usr0000000000000000000f1',
  name: 'Renee Boyle',
  roles: ['operations'] as Role[],
  accountId: null,
};

const CUSTOMER_ADMIN = {
  userId: 'usr0000000000000000000c1',
  name: 'Alex Tran',
  roles: ['customer-administrator'] as Role[],
  accountId: account.id,
};

const SUPERVISOR = {
  userId: 'usr0000000000000000000s1',
  name: 'Sam Doyle',
  roles: ['customer-site-supervisor'] as Role[],
  accountId: account.id,
};

function draft(overrides: Partial<JobDraft> = {}): JobDraft {
  return {
    accountId: account.id,
    siteName: 'Lot 214 (#46) Allambie Circuit',
    lotNumber: '214',
    addressLine: '46 Allambie Circuit',
    placeId: 'kellyville',
    builderName: 'GJ Gardner',
    // M2.12 — no purchase order behind these fixtures. Covered on its own in
    // `jobs.purchase-order.test.ts`.
    purchaseOrderId: null,
    accessNotes: 'Enter from the west side',
    gateHours: '7am-3pm',
    inductionRequired: false,
    craneAvailable: true,
    siteContactName: 'Dave',
    siteContactMobile: '0400111222',
    siteContactEmail: 'dave@builder.com.au',
    poNumber: 'PO-88213',
    // A Monday, so the business-day arithmetic below is easy to read.
    readyDate: '2026-03-02',
    serviceLevel: 'standard',
    freightItem: 'plasterboard-hand-load',
    expectedAreaM2: 823.41,
    bagCount: 0,
    notes: '',
    ...overrides,
  };
}

beforeEach(() => {
  clearOutbound();
  setMessagingProvidersForTests(recordingProviders());
  quotedCharges.length = 0;
  repo = createFakeJobRepository();
  settings = createFakeSettingsRepository();
  accountScope = null;
  accountFound = true;
  account.status = 'active';

  // Call counts are asserted on ("was Google reached at all?"), so they cannot
  // carry over between tests.
  maps.geocode.mockClear().mockResolvedValue(null);
  maps.optimiseStopOrder.mockClear().mockResolvedValue(null);
});

/*
 * ── Scoping ────────────────────────────────────────────────────────────────
 * Three boundaries, and the supervisor one is the important one: until sites
 * were removed a supervisor was scoped by their assigned sites (M1.5). With no
 * site records the boundary is "the jobs I raised" — Matt, 18:15.
 */
/**
 * M8.1 — the booking notice.
 *
 * ⚠️ What this suite can assert is the SAFE path: this repository double returns
 * a job with no site contact, so nothing can be sent. That is the case worth
 * pinning here — a job the office booked over the phone for a site whose
 * foreman is not on file must still book, and must not raise anything to send.
 * The message itself is covered against a job that HAS a contact in
 * `driver.service.test.ts` and `users.service.test.ts`.
 */
describe('booking notices (M8.1)', () => {
  it('books the job even when there is nobody to tell', async () => {
    const created = await jobService.create(draft(), OFFICE);

    expect(created.id).toBeTruthy();
    expect(sentMessages).toHaveLength(0);
  });
});

describe('who sees which jobs', () => {
  it('does not scope the office at all', async () => {
    await jobService.list({ page: 1, pageSize: 20 }, OFFICE);

    expect(repo.calls.lastScope).toEqual({
      accountId: null,
      bookedByUserId: null,
      driverId: null,
    });
  });

  it('scopes a customer administrator to their account', async () => {
    await jobService.list({ page: 1, pageSize: 20 }, CUSTOMER_ADMIN);

    expect(repo.calls.lastScope).toEqual({
      accountId: account.id,
      bookedByUserId: null,
      driverId: null,
    });
  });

  it('scopes a site supervisor to the jobs they raised', async () => {
    await jobService.list({ page: 1, pageSize: 20 }, SUPERVISOR);

    expect(repo.calls.lastScope).toEqual({
      accountId: account.id,
      bookedByUserId: SUPERVISOR.userId,
      driverId: null,
    });
  });

  it('gives a supervisor who is also an administrator the wider scope', async () => {
    await jobService.list(
      { page: 1, pageSize: 20 },
      { ...SUPERVISOR, roles: ['customer-site-supervisor', 'customer-administrator'] },
    );

    expect(repo.calls.lastScope?.bookedByUserId).toBeNull();
  });

  it('fails closed when a customer session carries no account', async () => {
    // A broken session must read as "none of them", never "all of them".
    await jobService.list({ page: 1, pageSize: 20 }, { ...CUSTOMER_ADMIN, accountId: null });

    expect(repo.calls.lastScope?.accountId).toBe('000000000000000000000000');
  });

  it('404s an out-of-scope job rather than 403', async () => {
    // A 403 confirms the job exists, which is what a caller probing for another
    // account's work wants to know.
    await expect(jobService.get('a'.repeat(24), CUSTOMER_ADMIN)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('previewing a price', () => {
  it('prices Matt’s Domain job to the cent', async () => {
    const preview = await jobService.preview(draft(), OFFICE);

    // 823.41 m² × $0.16 = $131.75, plus the $220 Sydney service fee.
    expect(preview.subtotalExGst).toBe('351.75');
    expect(preview.totalIncGst).toBe('386.93');
  });

  it('treats a zero area as "nobody has told us yet", not as nothing', async () => {
    // The fixed-price builder's normal case — Matt, 31:04.
    const preview = await jobService.preview(draft({ expectedAreaM2: 0 }), OFFICE);

    expect(preview.lines).toHaveLength(1);
    expect(preview.subtotalExGst).toBe('220.00');
    expect(preview.caveat).toContain('purchase order');
  });

  it('resolves the account through the caller’s own scope', async () => {
    await jobService.preview(draft(), CUSTOMER_ADMIN);

    // A customer pasting another account's id must not price against it.
    expect(accountScope).toEqual({ accountId: account.id });
  });

  it('refuses a suburb PlastaGo does not service', async () => {
    await expect(jobService.preview(draft({ placeId: 'perth' }), OFFICE)).rejects.toMatchObject({
      status: 422,
    });
  });

  it('refuses an account it cannot find', async () => {
    accountFound = false;

    await expect(jobService.preview(draft(), OFFICE)).rejects.toMatchObject({
      status: 422,
      issues: [{ path: 'accountId' }],
    });
  });
});

describe('booking a job', () => {
  it('takes the next number from the sequence', async () => {
    const created = await jobService.create(draft(), OFFICE);

    // M1.4 — continues from TransVirtual, never restarts at 1.
    expect(created.jobNumber).toBe(61_300);
    expect(repo.calls.lastCreate?.jobNumber).toBe(61_300);
  });

  it('stores the price the preview would have shown', async () => {
    const preview = await jobService.preview(draft(), OFFICE);
    await jobService.create(draft(), OFFICE);

    // If these could disagree, the number quoted down the phone would not be
    // the number on the invoice.
    expect(repo.calls.lastCreate?.totalExGst).toBe(preview.subtotalExGst);
    expect(repo.calls.lastCreate?.gst).toBe(preview.gst);
  });

  /* M2.4a — five BUSINESS days, so a Monday lands on the following Monday. */
  it('sets the target date five business days out, skipping the weekend', async () => {
    await jobService.create(draft({ readyDate: '2026-03-02' }), OFFICE);
    expect(repo.calls.lastCreate?.targetDate).toBe('2026-03-09');
  });

  it('counts business days from a Thursday across two weekends', async () => {
    // Thu 5 Mar + 5 business days → Thu 12 Mar.
    await jobService.create(draft({ readyDate: '2026-03-05' }), OFFICE);
    expect(repo.calls.lastCreate?.targetDate).toBe('2026-03-12');
  });

  it('takes the address from the PICKED suburb, not from typed text', async () => {
    // The zone prices the job (M6.3) and the pin plots it. A caller that could
    // send either would be nominating its own rate.
    await jobService.create(draft(), OFFICE);

    expect(repo.calls.lastCreate?.suburb).toBe('Kellyville');
    expect(repo.calls.lastCreate?.postcode).toBe('2155');
    expect(repo.calls.lastCreate?.zone).toBe('sydney');
    expect(repo.calls.lastCreate?.latitude).toBe(-33.7118);
  });

  it('freezes the account’s risk-assessment rule onto the job', async () => {
    await jobService.create(draft(), OFFICE);

    // M4.8b — a job audited next year must show the rule that applied when it
    // was booked, not today's.
    expect(repo.calls.lastCreate?.riskAssessmentRequired).toBe(true);
  });

  it('stores a zero area as null, because null is not zero', async () => {
    await jobService.create(draft({ expectedAreaM2: 0 }), OFFICE);
    expect(repo.calls.lastCreate?.expectedAreaM2).toBeNull();
  });

  it('writes the opening timeline event', async () => {
    await jobService.create(draft(), OFFICE);

    expect(repo.calls.events).toHaveLength(1);
    expect(repo.calls.events[0]).toMatchObject({ label: 'Job created', status: 'booked' });
  });

  it('records an office booking with no scoping user', async () => {
    await jobService.create(draft(), OFFICE);

    // A null is invisible to every site supervisor — the safe direction.
    expect(repo.calls.lastCreate?.bookedByUserId).toBeNull();
    expect(repo.calls.lastCreate?.bookedBySource).toBe('office');
    expect(repo.calls.lastCreate?.bookedByName).toBe('Renee Boyle');
  });

  it('records a portal booking against the supervisor who raised it', async () => {
    await jobService.create(draft(), SUPERVISOR);

    // This is what they will be scoped by when they come back to look at it.
    expect(repo.calls.lastCreate?.bookedByUserId).toBe(SUPERVISOR.userId);
    expect(repo.calls.lastCreate?.bookedBySource).toBe('portal');
  });

  it('refuses to book against an inactive account', async () => {
    account.status = 'inactive';

    await expect(jobService.create(draft(), OFFICE)).rejects.toMatchObject({ status: 409 });
  });

  it('trims what the form sent', async () => {
    await jobService.create(draft({ siteName: '  Lot 9  ', poNumber: '  ' }), OFFICE);

    expect(repo.calls.lastCreate?.siteName).toBe('Lot 9');
    // An empty PO is null, not "", so "has no PO" is one thing to test for.
    expect(repo.calls.lastCreate?.poNumber).toBeNull();
  });
});

describe('cancelling', () => {
  it('cancels an open job with a structured reason', async () => {
    const id = repo.seed({ status: 'booked' });
    await jobService.cancel(id, 'access-blocked', 'Gate locked', OFFICE);

    expect(repo.statusOf(id)).toBe('cancelled');
    expect(repo.calls.cancels[0]).toMatchObject({ reason: 'access-blocked', note: 'Gate locked' });
  });

  it('writes a timeline event carrying the note', async () => {
    const id = repo.seed({ status: 'booked' });
    await jobService.cancel(id, 'customer-request', 'Called to postpone', OFFICE);

    expect(repo.calls.events[0]).toMatchObject({
      label: 'Job cancelled',
      status: 'cancelled',
      detail: 'Called to postpone',
    });
  });

  /*
   * Completed work is a historical record: the truck went, the customer was
   * served, and the tonnage is on a diversion certificate. Cancelling that does
   * not undo any of it — it just makes the record wrong.
   */
  it('refuses to cancel a completed job', async () => {
    const id = repo.seed({ status: 'completed' });

    await expect(jobService.cancel(id, 'customer-request', '', OFFICE)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses to cancel an admin-complete job', async () => {
    const id = repo.seed({ status: 'admin-complete' });

    await expect(jobService.cancel(id, 'customer-request', '', OFFICE)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses a second cancel rather than overwriting the first reason', async () => {
    const id = repo.seed({ status: 'cancelled' });

    await expect(jobService.cancel(id, 'access-blocked', '', OFFICE)).rejects.toMatchObject({
      status: 409,
    });
  });

  /*
   * Between the read and the write a driver could have completed the job on
   * their phone. The guarded update matches nothing, and we say so rather than
   * silently cancelling finished work.
   */
  it('reports a conflict when the job moves underneath the cancel', async () => {
    const id = repo.seed({ status: 'booked' });
    repo.failNextCancel();

    await expect(jobService.cancel(id, 'access-blocked', '', OFFICE)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('lets a customer administrator cancel their own booking', async () => {
    const id = repo.seed({ status: 'booked' });
    await expect(
      jobService.cancel(id, 'customer-request', '', CUSTOMER_ADMIN),
    ).resolves.toBeUndefined();
  });

  it('refuses a site supervisor', async () => {
    // They raise pickups; cancelling one the site is waiting on is a decision
    // for whoever runs the account.
    const id = repo.seed({ status: 'booked' });

    await expect(
      jobService.cancel(id, 'customer-request', '', SUPERVISOR),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('404s a job that is out of scope', async () => {
    await expect(
      jobService.cancel('f'.repeat(24), 'customer-request', '', CUSTOMER_ADMIN),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('rescheduling', () => {
  it('restarts the SLA clock from the new ready date', async () => {
    const id = repo.seed({ status: 'booked' });
    await jobService.reschedule(id, '2026-03-02', OFFICE);

    expect(repo.calls.reschedules[0]).toMatchObject({
      readyDate: '2026-03-02',
      targetDate: '2026-03-09',
    });
  });

  it('refuses to reschedule finished work', async () => {
    const id = repo.seed({ status: 'completed' });

    await expect(jobService.reschedule(id, '2026-03-02', OFFICE)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses a site supervisor', async () => {
    const id = repo.seed({ status: 'booked' });

    await expect(jobService.reschedule(id, '2026-03-02', SUPERVISOR)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('commenting', () => {
  it('posts an internal comment with no delivery state', async () => {
    const id = repo.seed({ status: 'booked' });
    const comment = await jobService.addComment(id, { body: 'Chased the PO', visibility: 'internal' }, OFFICE);

    // Internal comments are not pushed, so null rather than a timestamp that
    // would imply one.
    expect(comment.deliveredAt).toBeNull();
  });

  it('marks a driver comment as delivered', async () => {
    const id = repo.seed({ status: 'assigned', driverId: 'drv0000000000000000000d1' });
    const comment = await jobService.addComment(id, { body: 'Gate code 4821', visibility: 'driver' }, OFFICE);

    // M8.6 — "did they get it" is the first question anyone asks about a
    // message to somebody on the road.
    expect(comment.deliveredAt).not.toBeNull();
  });

  /*
   * M8.6's shape is "between the office and the driver", singular. On an
   * unallocated job there is nobody for the message to reach, and accepting it
   * would put a message in a thread that never gets delivered.
   */
  it('refuses a driver comment on an unallocated job', async () => {
    const id = repo.seed({ status: 'booked', driverId: null });

    await expect(
      jobService.addComment(id, { body: 'On your way?', visibility: 'driver' }, OFFICE),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('confines a customer to the thread they can read', async () => {
    const id = repo.seed({ status: 'booked' });

    // The internal thread is the one place the office talks about the customer.
    await expect(
      jobService.addComment(id, { body: 'Internal note', visibility: 'internal' }, CUSTOMER_ADMIN),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('lets a customer post to their own thread', async () => {
    const id = repo.seed({ status: 'booked' });

    await expect(
      jobService.addComment(id, { body: 'Any update?', visibility: 'customer' }, CUSTOMER_ADMIN),
    ).resolves.toMatchObject({ visibility: 'customer' });
  });

  it('signs the comment with the session’s name, not the request’s', async () => {
    const id = repo.seed({ status: 'booked' });
    const comment = await jobService.addComment(
      id,
      { body: 'Noted', visibility: 'internal' },
      OFFICE,
    );

    expect(comment.author).toBe('Renee Boyle');
    expect(repo.calls.comments[0]?.authorId).toBe(OFFICE.userId);
  });

  it('404s a job that is out of scope', async () => {
    await expect(
      jobService.addComment('f'.repeat(24), { body: 'Hi', visibility: 'customer' }, CUSTOMER_ADMIN),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('the quote is persisted as the job’s own charge lines', () => {
  /*
   * ⚠️ Why this matters: the invoice is a straight COPY of these lines. Rates
   * are effective-dated (M6.2), so re-running the quote at invoice time would
   * silently re-price history the first time somebody edits a rate card — and
   * the invoice has to reproduce what the customer was quoted, to the cent
   * (Risk 1).
   */
  it('writes the quoted lines against the job it created', async () => {
    const created = await jobService.create(draft(), OFFICE);

    expect(quotedCharges).toHaveLength(1);
    expect(quotedCharges[0]?.jobId).toBe(created.id);
    expect(quotedCharges[0]?.lines.length).toBeGreaterThan(0);
  });

  it('persists lines that add up to the price the job was saved at', async () => {
    // The invoice adds these up. If they disagreed with `totalExGst`, the
    // customer would be quoted one figure and billed another.
    await jobService.create(draft(), OFFICE);

    const summed = quotedCharges[0]?.lines.reduce(
      (total, line) => total + Math.round(Number(line.amount) * 100),
      0,
    );

    // Against what the service asked to STORE on the job, which is the figure
    // the customer was quoted.
    expect(summed).toBe(Math.round(Number(repo.calls.lastCreate?.totalExGst) * 100));
  });
});

/*
 * ── Where a job's pin comes from (I3) ──────────────────────────────────────
 * A latitude is a latitude: nothing about the number says whether it is the
 * house or the middle of the suburb, and the two are kilometres apart. These
 * pin the rule that a pin is only kept when it is BETTER than the suburb
 * centre the job would otherwise carry — and that a booking survives every way
 * that lookup can go wrong, because an office user is on the phone to a builder
 * while it happens.
 */
describe('resolving the pin on a booking', () => {
  const KELLYVILLE = { latitude: -33.7118, longitude: 150.9542 };

  it('keeps the suburb pin when the geocoder has no answer', async () => {
    await jobService.create(draft(), OFFICE);

    expect(repo.calls.lastCreate?.latitude).toBe(KELLYVILLE.latitude);
    expect(repo.calls.lastCreate?.longitude).toBe(KELLYVILLE.longitude);
    expect(repo.calls.lastCreate?.locationSource).toBe('suburb');
  });

  it('stores a rooftop match as the job pin', async () => {
    maps.geocode.mockResolvedValueOnce({
      latitude: -33.7035,
      longitude: 150.9431,
      precision: 'rooftop',
      formattedAddress: '46 Allambie Circuit, Kellyville NSW 2155',
    });

    await jobService.create(draft(), OFFICE);

    expect(repo.calls.lastCreate?.latitude).toBe(-33.7035);
    expect(repo.calls.lastCreate?.locationSource).toBe('geocoded');
  });

  /*
   * The common good case in a greenfield estate: the street exists in Google's
   * data but the individual house does not, so the pin is interpolated along
   * the block. Metres out, not kilometres — a driver can work with it.
   */
  it('accepts an interpolated match', async () => {
    maps.geocode.mockResolvedValueOnce({
      latitude: -33.7035,
      longitude: 150.9431,
      precision: 'interpolated',
      formattedAddress: 'Allambie Circuit, Kellyville NSW 2155',
    });

    await jobService.create(draft(), OFFICE);

    expect(repo.calls.lastCreate?.locationSource).toBe('geocoded');
  });

  /*
   * `block` is a street's midpoint and `approximate` is usually the locality's
   * — the same class of answer the job already holds. Storing one would swap a
   * pin we can explain for one we cannot, while marking the job as precisely
   * located, which is what the run optimiser reads.
   */
  it.each(['block', 'approximate'] as const)(
    'rejects a %s match as no better than the suburb',
    async (precision) => {
      maps.geocode.mockResolvedValueOnce({
        latitude: -33.7035,
        longitude: 150.9431,
        precision,
        formattedAddress: 'Kellyville NSW 2155',
      });

      await jobService.create(draft(), OFFICE);

      expect(repo.calls.lastCreate?.latitude).toBe(KELLYVILLE.latitude);
      expect(repo.calls.lastCreate?.locationSource).toBe('suburb');
    },
  );

  /*
   * ⚠️ The failure this exists for. Google answers a half-built estate's
   * address with a real street of the same name in another state, at full
   * ROOFTOP confidence, because as far as it knows that IS the address. The
   * suburb is the one part a human definitely chose from a list, so it wins.
   */
  it('rejects a confident match that landed in another state', async () => {
    maps.geocode.mockResolvedValueOnce({
      // Allambie Circuit, somewhere in Victoria — 700km from Kellyville.
      latitude: -37.8136,
      longitude: 144.9631,
      precision: 'rooftop',
      formattedAddress: '46 Allambie Circuit, Melbourne VIC 3000',
    });

    await jobService.create(draft(), OFFICE);

    expect(repo.calls.lastCreate?.latitude).toBe(KELLYVILLE.latitude);
    expect(repo.calls.lastCreate?.locationSource).toBe('suburb');
  });

  it('accepts a match just inside the drift allowance', async () => {
    // ~11km north of Kellyville — a different suburb, but the right city.
    maps.geocode.mockResolvedValueOnce({
      latitude: -33.6118,
      longitude: 150.9542,
      precision: 'rooftop',
      formattedAddress: '46 Allambie Circuit, Box Hill NSW 2765',
    });

    await jobService.create(draft(), OFFICE);

    expect(repo.calls.lastCreate?.locationSource).toBe('geocoded');
  });

  /*
   * The whole feature is an improvement on a pin the job already has, so there
   * is no failure here worth showing a builder on the phone.
   */
  it('books the job anyway when the geocoder throws', async () => {
    maps.geocode.mockRejectedValueOnce(new Error('ETIMEDOUT'));

    const job = await jobService.create(draft(), OFFICE);

    expect(job.jobNumber).toBeGreaterThan(0);
    expect(repo.calls.lastCreate?.locationSource).toBe('suburb');
  });

  it('does not spend a lookup on a booking with no street address', async () => {
    await jobService.create(draft({ addressLine: '   ' }), OFFICE);

    expect(maps.geocode).not.toHaveBeenCalled();
    expect(repo.calls.lastCreate?.locationSource).toBe('suburb');
  });

  it('sends the picked suburb, not just the typed line', async () => {
    await jobService.create(draft(), OFFICE);

    // The suburb and postcode are what stop Google wandering interstate — they
    // are the parts of the address a human chose from a list.
    expect(maps.geocode).toHaveBeenCalledWith({
      addressLine: '46 Allambie Circuit',
      suburb: 'Kellyville',
      postcode: '2155',
      state: 'NSW',
    });
  });

  it('does not geocode a price preview', async () => {
    // A preview is keystrokes-fast and repeated as the form is filled in.
    // Geocoding each one would bill for answers nothing keeps.
    await jobService.preview(draft(), OFFICE);

    expect(maps.geocode).not.toHaveBeenCalled();
  });
});
