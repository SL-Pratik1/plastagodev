import { AccountListItemSchema, AccountSchema } from '@plastago/shared';
import { SEED_ZONES, ZONE } from './helpers/fake-settings.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDraft, Role } from '@plastago/shared';
import { createFakeAccountRepository } from './helpers/fake-accounts.js';
import {
  clearOutbound,
  makeFakeNotificationRepository,
  recordingProviders,
  sentMessages,
} from './helpers/fake-outbound.js';

/**
 * Account rules (M2.8 · W8).
 *
 * These test the two things a repository cannot: who is allowed to see what,
 * and what the office is told when a create fails. Both are decisions, and both
 * are the kind that get quietly reimplemented in a controller if they are not
 * pinned here.
 */

let repo: ReturnType<typeof createFakeAccountRepository>;

/**
 * How many supervisors on the account can still sign in.
 *
 * Faked because it is a users query in the portal domain, and the rule under
 * test is about what the office may do with that number — not how it is counted.
 */
let liveSupervisors = 0;

// A GETTER, not a value: `vi.mock` factories hoist above every import, so the
// fake does not exist yet when this runs.
vi.mock('../src/domains/accounts/account.repository.js', () => ({
  get accountRepository() {
    return repo.repository;
  },
}));

vi.mock('../src/domains/portal/supervisor.repository.js', () => ({
  supervisorRepository: {
    countLive: () => Promise.resolve(liveSupervisors),
  },
}));

/**
 * Which rate cards exist (M6.1).
 *
 * `create` checks the card is real before writing, because rate cards stopped
 * being a compile-time enum — Mongo no longer refuses an unknown one, so the
 * service has to. Faked to a set rather than stubbed to `true`, so the refusal
 * itself is testable.
 */
let knownRateCards = new Set<string>(['default', 'tier-1', 'clarendon-domaine']);

vi.mock('../src/domains/settings/settings.repository.js', () => ({
  settingsRepository: {
    findRateCard: (id: string) =>
      Promise.resolve(
        knownRateCards.has(id) ? { id, label: `${id} rates`, effectiveFrom: '2026-04-01' } : null,
      ),
    /*
     * The zone register, as far as `assertZoneExists` needs it.
     *
     * ⚠️ Answers for the seeded ids and nothing else, so a test that invents a
     * zone gets the same 422 the real guard would give it.
     */
    findZone: (id: string) => {
      const zone = SEED_ZONES.find((candidate: { id: string }) => candidate.id === id);
      return Promise.resolve(
        zone
          ? {
              id: zone.id,
              slug: zone.slug,
              label: zone.label,
              displayOrder: 0,
              archived: false,
              placeCount: 0,
              accountCount: 0,
              jobCount: 0,
              archivable: true,
            }
          : null,
      );
    },
  },
}));

/*
 * The welcome email (M8.1).
 *
 * Creating an account sends one now — it always claimed to and never did — so
 * the outbound log has to be faked here for the same reason it is in the leads
 * suite: the real repository would buffer a write against a MongoDB that is not
 * there, and the test would hang rather than fail.
 */
vi.mock('../src/domains/notifications/notification.repository.js', () => ({
  notificationRepository: makeFakeNotificationRepository(),
}));

/*
 * The portal login the welcome email tells them to use — created alongside it,
 * because nothing used to create one and the sign-in code never arrived.
 */
const logins = {
  /** Addresses that already sign in to something. */
  taken: new Set<string>(),
  created: [] as Array<Record<string, unknown>>,
};

vi.mock('../src/domains/users/user.repository.js', () => ({
  userRepository: {
    identifierTaken: (input: { email: string | null }) =>
      Promise.resolve(input.email !== null && logins.taken.has(input.email)),
    create: (input: Record<string, unknown>) => {
      logins.created.push(input);
      return Promise.resolve(`usr${String(logins.created.length).padStart(21, '0')}`);
    },
  },
}));

/*
 * M4.8b — the risk assessment rule reaches the account's OPEN jobs.
 *
 * Faked to a recorder: which statuses the service asks for, and what it writes
 * on each changed job's trail, are the rules under test here. How Mongo applies
 * the filter is covered against a real database in
 * `risk-assessment-and-messages.integration.test.ts`.
 */
const openJobSync = {
  calls: [] as Array<{ accountId: string; required: boolean; statuses: readonly string[] }>,
  changed: [] as Array<{ id: string; jobNumber: number }>,
  events: [] as Array<{ jobId: string; label: string; actor: string; detail?: string | null }>,
};

vi.mock('../src/domains/jobs/job.repository.js', () => ({
  jobRepository: {
    setRiskAssessmentOnOpenJobs: (
      accountId: string,
      required: boolean,
      statuses: readonly string[],
    ) => {
      openJobSync.calls.push({ accountId, required, statuses: [...statuses] });
      return Promise.resolve(openJobSync.changed);
    },
    appendEvent: (input: { jobId: string; label: string; actor: string; detail?: string | null }) => {
      openJobSync.events.push(input);
      return Promise.resolve();
    },
  },
}));

const { setMessagingProvidersForTests } = await import('../src/integrations/messaging.js');

const { accountService } = await import('../src/domains/accounts/account.service.js');

const OFFICE = { roles: ['operations'] as Role[], accountId: null };
const CUSTOMER = { roles: ['customer-administrator'] as Role[], accountId: 'a'.repeat(24) };

function draft(overrides: Partial<AccountDraft> = {}): AccountDraft {
  return {
    customerCode: 'NEW001',
    legalName: 'Acme Plastering Pty Ltd',
    abn: '12345678901',
    accountType: 'contractor',
    brandId: 'plastago',
    rateCardId: 'tier-1',
    poPolicy: 'not-required',
    captureMode: 'area-only',
    paymentTermsDays: 7,
    primaryZoneId: ZONE.sydney,
    accountsContactName: 'Jo Bloggs',
    accountsContactEmail: 'jo@acme.com.au',
    sendInvitation: false,
    notes: '',
    ...overrides,
  };
}

beforeEach(() => {
  repo = createFakeAccountRepository();
  liveSupervisors = 0;
  logins.taken.clear();
  logins.created.length = 0;
  clearOutbound();
  setMessagingProvidersForTests(recordingProviders());
});

describe('creating an account', () => {
  it('returns a row the contract accepts', async () => {
    const { account } = await accountService.create(draft());
    expect(() => AccountListItemSchema.parse(account)).not.toThrow();
  });

  it('upper-cases the customer code, so cla001 and CLA001 cannot both exist', async () => {
    await accountService.create(draft({ customerCode: 'new002' }));
    expect(repo.lastCreate?.code).toBe('NEW002');
  });

  it('refuses a duplicate code and names the field that is wrong', async () => {
    repo.seedCode('DUP001');

    const error = await accountService
      .create(draft({ customerCode: 'DUP001' }))
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 409, code: 'CONFLICT' });
    // The field path is what lets the form highlight the right input rather
    // than showing a banner the user has to map back to a box themselves.
    expect((error as { issues?: { path: string }[] }).issues?.[0]?.path).toBe('customerCode');
  });

  /*
   * Both screens propose "first three letters + 001", so every builder whose
   * name starts the same way collides on the same code. A bare "that code is
   * taken" asks the office to guess against a list only the server can see —
   * the conversion wizard has always offered a free one, and this screen did
   * not.
   */
  it('offers a free code when the one asked for is taken', async () => {
    repo.seedCode('DUP001');

    const error = await accountService
      .create(draft({ customerCode: 'DUP001' }))
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect((error as { issues?: { message: string }[] }).issues?.[0]?.message).toContain('DUP002');
  });

  it('rejects an email with nobody attached to it', async () => {
    const error = await accountService
      .create(draft({ accountsContactName: '', accountsContactEmail: 'nobody@acme.com.au' }))
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
  });

  it('accepts an account with no contact at all', async () => {
    await accountService.create(draft({ accountsContactName: '', accountsContactEmail: '' }));
    expect(repo.lastCreate?.contact).toBeNull();
  });

  /*
   * The two terms tests that stood here — "records terms as agreed off-system
   * when no invitation is sent" and its opposite — went with the terms feature.
   * They were also the LAST difference between this path and a lead conversion;
   * `account-creation.parity.test.ts` now asserts the two are identical.
   */
});

/*
 * ── The invitation ───────────────────────────────────────────────────────
 *
 * This screen accepted `sendInvitation`, showed a toast reading "an onboarding
 * link is on its way to their accounts contact", and sent nothing: the only
 * welcome email in the platform was the one the lead conversion sent. The
 * customer waited for a message that was never queued, and nobody in the office
 * had any reason to look.
 */
describe('the welcome email', () => {
  it('emails the accounts contact when an invitation is asked for', async () => {
    const { welcome } = await accountService.create(draft({ sendInvitation: true }));

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.channel).toBe('email');
    expect(welcome).toMatchObject({ outcome: 'sent', channel: 'email' });
  });

  it('carries the customer code, which is what they quote back to us', async () => {
    await accountService.create(draft({ customerCode: 'ACM001', sendInvitation: true }));
    expect(sentMessages[0]?.body).toContain('ACM001');
  });

  it('sends nothing when no invitation was asked for', async () => {
    const { welcome } = await accountService.create(draft({ sendInvitation: false }));

    expect(sentMessages).toHaveLength(0);
    expect(welcome).toBeNull();
  });

  /*
   * ⚠️ Refused BEFORE the account exists, rather than reported afterwards as a
   * skipped send. "Email them the onboarding link" with no address to email is
   * a promise the screen cannot keep, and this is the last moment it is still
   * cheap to fix.
   */
  it('refuses an invitation with nowhere to send it', async () => {
    const error = await accountService
      .create(draft({ accountsContactName: '', accountsContactEmail: '', sendInvitation: true }))
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    expect((error as { issues?: { path: string }[] }).issues?.[0]?.path).toBe(
      'accountsContactEmail',
    );
    expect(repo.lastCreate).toBeNull();
  });

  /*
   * ⚠️ The email says "sign in here with this address" — and nothing created a
   * login for it, so the code never came. The login is made with the email now.
   */
  it('creates the portal login the email tells them to sign in with', async () => {
    const { account } = await accountService.create(
      draft({ accountsContactEmail: 'Jo@Acme.com.au', sendInvitation: true }),
      { name: 'Renee Alvarez' },
    );

    expect(logins.created).toEqual([
      expect.objectContaining({
        email: 'jo@acme.com.au',
        name: 'Jo Bloggs',
        role: 'customer-administrator',
        roles: ['customer-administrator'],
        accountId: account.id,
        invitedBy: 'Renee Alvarez',
      }),
    ]);
    expect(sentMessages[0]?.to).toBe('jo@acme.com.au');
  });

  it('creates no login when no invitation was asked for', async () => {
    await accountService.create(draft({ sendInvitation: false }));
    expect(logins.created).toHaveLength(0);
  });

  /*
   * A login belongs to one person. An address that already signs in — staff,
   * or another customer — would have the welcome open THEIR login, so it is
   * refused while the form can still be corrected.
   */
  it('refuses an invitation to an email that already signs in', async () => {
    logins.taken.add('jo@acme.com.au');

    const error = await accountService
      .create(draft({ sendInvitation: true }))
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    expect((error as { issues?: { path: string }[] }).issues?.[0]?.path).toBe(
      'accountsContactEmail',
    );
    expect(repo.lastCreate).toBeNull();
    expect(sentMessages).toHaveLength(0);
  });
});

describe('reading an account', () => {
  it('returns a document the contract accepts', async () => {
    const id = repo.seedAccount({ code: 'CLA001' });
    const account = await accountService.get(id, OFFICE);
    expect(() => AccountSchema.parse(account)).not.toThrow();
  });

  it('404s an account that does not exist', async () => {
    await expect(accountService.get('b'.repeat(24), OFFICE)).rejects.toMatchObject({
      status: 404,
    });
  });

  /*
   * ⚠️ NOT FOUND, not FORBIDDEN.
   *
   * A 403 confirms the account exists, which tells one customer something about
   * another. "No such account" is both safer and true from where they stand.
   */
  it('hides another customer’s account behind a 404, not a 403', async () => {
    const other = repo.seedAccount({ code: 'OTH001' });

    const error = await accountService
      .get(other, CUSTOMER)
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 404 });
  });

  it('lets a customer read their own account', async () => {
    const own = repo.seedAccount({ code: 'OWN001', id: CUSTOMER.accountId });
    await expect(accountService.get(own, CUSTOMER)).resolves.toMatchObject({ code: 'OWN001' });
  });
});

describe('scoping the list', () => {
  it('leaves the office unscoped', async () => {
    await accountService.list({ page: 1, pageSize: 20 }, OFFICE);
    expect(repo.lastScope).toEqual({ accountId: null });
  });

  it('narrows a customer to their own account', async () => {
    await accountService.list({ page: 1, pageSize: 20 }, CUSTOMER);
    expect(repo.lastScope).toEqual({ accountId: CUSTOMER.accountId });
  });

  /*
   * Fail closed. A customer role with no account is a misconfigured user, and
   * scoping them to `null` would mean "see everything" to the repository.
   */
  it('shows a customer with no account nothing, rather than everything', async () => {
    await accountService.list({ page: 1, pageSize: 20 }, { ...CUSTOMER, accountId: null });
    expect(repo.lastScope?.accountId).not.toBeNull();
    expect(repo.lastScope?.accountId).toBe('000000000000000000000000');
  });

  /*
   * The `onboarding` facet regression test stood here. The facet filtered on
   * whether an account had accepted the terms, which is no longer a state an
   * account can be in.
   */
});

describe('changing the account type (builder ↔ contractor)', () => {
  it('moves a contractor onto the builder journey', async () => {
    const id = repo.seedAccount({ code: 'CON001', accountType: 'contractor' });

    const account = await accountService.setAccountType(id, 'builder', OFFICE);

    expect(account.accountType).toBe('builder');
  });

  /*
   * ⚠️ The rule this whole endpoint turns on.
   *
   * A contractor account has no supervisor screen, so their logins would keep
   * working with nobody able to see, suspend or replace them — an account whose
   * own administrator cannot answer "who can book on my account". Suspending
   * them first is the customer administrator's act, and it is deliberate.
   */
  it('refuses builder → contractor while supervisors can still sign in', async () => {
    const id = repo.seedAccount({ code: 'BLD001', accountType: 'builder' });
    liveSupervisors = 3;

    const error = await accountService
      .setAccountType(id, 'contractor', OFFICE)
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 409, code: 'CONFLICT' });
    // The message has to say how many, or the office cannot tell whether this is
    // one forgotten login or a working site team.
    expect((error as { message: string }).message).toContain('3 site supervisors');

    // And nothing moved.
    const unchanged = await accountService.get(id, OFFICE);
    expect(unchanged.accountType).toBe('builder');
  });

  it('allows builder → contractor once none of them can sign in', async () => {
    const id = repo.seedAccount({ code: 'BLD002', accountType: 'builder' });
    liveSupervisors = 0;

    const account = await accountService.setAccountType(id, 'contractor', OFFICE);

    expect(account.accountType).toBe('contractor');
  });

  /*
   * A retried request must not fail on a check for a change it is not making —
   * the supervisor count is irrelevant when the type is already what was asked
   * for.
   */
  it('is idempotent, and does not consult the supervisor count', async () => {
    const id = repo.seedAccount({ code: 'CON002', accountType: 'contractor' });
    liveSupervisors = 5;

    const account = await accountService.setAccountType(id, 'contractor', OFFICE);

    expect(account.accountType).toBe('contractor');
  });

  // It decides what a CUSTOMER's own portal shows them. Not their call.
  it('refuses a customer', async () => {
    const id = repo.seedAccount({ code: 'OWN002', id: CUSTOMER.accountId });

    await expect(accountService.setAccountType(id, 'builder', CUSTOMER)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('404s an account that does not exist', async () => {
    await expect(
      accountService.setAccountType('d'.repeat(24), 'builder', OFFICE),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('the risk assessment rule', () => {
  beforeEach(() => {
    openJobSync.calls.length = 0;
    openJobSync.events.length = 0;
    openJobSync.changed = [];
  });

  it('lets the office turn it on', async () => {
    const id = repo.seedAccount({ code: 'CLA001' });
    const account = await accountService.setRiskAssessmentRequired(id, true, OFFICE);
    expect(account.riskAssessmentRequired).toBe(true);
  });

  /*
   * The bug this fixes: a job copied the rule when it was booked, so switching
   * it on left every job already booked on "optional" — including the one the
   * driver was standing on.
   */
  it('carries the rule onto open jobs, including one a driver is on now', async () => {
    const id = repo.seedAccount({ code: 'WBH001' });

    await accountService.setRiskAssessmentRequired(id, true, OFFICE);

    expect(openJobSync.calls).toHaveLength(1);
    expect(openJobSync.calls[0]).toMatchObject({ accountId: id, required: true });
    expect(openJobSync.calls[0]?.statuses).toContain('arrived');
  });

  // An audit next year must see the rule the job was actually done under.
  it('leaves finished jobs on the rule they were done under', async () => {
    const id = repo.seedAccount({ code: 'WBH002' });

    await accountService.setRiskAssessmentRequired(id, true, OFFICE);

    for (const finished of ['completed', 'admin-complete', 'futile', 'cancelled']) {
      expect(openJobSync.calls[0]?.statuses).not.toContain(finished);
    }
  });

  it('notes the change on each job it changed, naming who changed it', async () => {
    const id = repo.seedAccount({ code: 'WBH003' });
    openJobSync.changed = [
      { id: 'job0000000000000000000001', jobNumber: 61_304 },
      { id: 'job0000000000000000000002', jobNumber: 61_306 },
    ];

    await accountService.setRiskAssessmentRequired(id, true, { ...OFFICE, name: 'Renee Alvarez' });

    expect(openJobSync.events.map((event) => event.jobId)).toEqual([
      'job0000000000000000000001',
      'job0000000000000000000002',
    ]);
    expect(openJobSync.events[0]).toMatchObject({
      label: 'Site risk assessment now required',
      actor: 'Renee Alvarez',
    });
  });

  it('says so on the trail when it is switched off', async () => {
    const id = repo.seedAccount({ code: 'WBH004' });
    openJobSync.changed = [{ id: 'job0000000000000000000003', jobNumber: 61_300 }];

    await accountService.setRiskAssessmentRequired(id, false, OFFICE);

    expect(openJobSync.calls[0]).toMatchObject({ required: false });
    expect(openJobSync.events[0]?.label).toBe('Site risk assessment no longer required');
  });

  // It changes what a DRIVER is made to do at a fence. Not a customer's call.
  it('refuses a customer', async () => {
    const id = repo.seedAccount({ code: 'OWN001', id: CUSTOMER.accountId });
    await expect(
      accountService.setRiskAssessmentRequired(id, true, CUSTOMER),
    ).rejects.toMatchObject({ status: 403 });

    // Refused before anything was written — no job was touched either.
    expect(openJobSync.calls).toHaveLength(0);
  });

  it('404s an account that does not exist', async () => {
    await expect(
      accountService.setRiskAssessmentRequired('c'.repeat(24), true, OFFICE),
    ).rejects.toMatchObject({ status: 404 });

    expect(openJobSync.calls).toHaveLength(0);
  });
});
