import { beforeEach, describe, expect, it, vi } from 'vitest';
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
}));

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

const { jobService } = await import('../src/domains/jobs/job.service.js');

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
  repo = createFakeJobRepository();
  settings = createFakeSettingsRepository();
  accountScope = null;
  accountFound = true;
  account.status = 'active';
});

/*
 * ── Scoping ────────────────────────────────────────────────────────────────
 * Three boundaries, and the supervisor one is the important one: until sites
 * were removed a supervisor was scoped by their assigned sites (M1.5). With no
 * site records the boundary is "the jobs I raised" — Matt, 18:15.
 */
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
