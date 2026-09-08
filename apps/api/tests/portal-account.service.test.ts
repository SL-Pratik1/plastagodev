import type { AccountOnboarding, PortalSupervisorInvite, Role } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The customer's own account (M5.10, M5.14, M5.15, Journey A.4).
 *
 * ── What is actually under test ───────────────────────────────────────────
 * The line between what a customer may change and what is a commercial
 * negotiation. A customer supplies their registered details and decides who from
 * their business may book; they do not touch the rate card, the payment terms or
 * the PO policy.
 *
 * Plus the legal record: the terms acceptance is what Matt chases as a signed
 * PDF today (7:49), and it must be written once, by a named person, and never
 * silently overwritten.
 */

let invited: Array<Record<string, unknown>> = [];
let stateChanges: Array<{ id: string; state: string }> = [];
let approvals: string[] = [];
let accountUpdates: Array<Record<string, unknown>> = [];
let contactUpdates: Array<ReadonlyArray<{ id: string }>> = [];
let onboardings: Array<Record<string, unknown>> = [];
let contactUpserts: Array<Record<string, unknown>> = [];
let termsWrites: Array<Record<string, unknown>> = [];
let pdfIdsSeen: readonly string[] = [];

/** What the repositories report back. Set per test. */
let existingLogin: { id: string; accountId: string | null } | null = null;
let stateChangeMatches = true;
let approveMatches = true;
let existingTerms: Record<string, unknown> | null = null;
let termsRecorded = true;
let ownedIds: string[] = ['inv1'];

const ACCOUNT_ID = 'acc0000000000000000000a1';

vi.mock('../src/domains/portal/portal.repository.js', () => ({
  listInvoices: () =>
    Promise.resolve({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } }),
  ownedInvoiceIds: (_accountId: string, ids: readonly string[]) => {
    pdfIdsSeen = ids;
    return Promise.resolve(ownedIds);
  },
}));

vi.mock('../src/domains/portal/supervisor.repository.js', () => ({
  supervisorRepository: {
    list: () =>
      Promise.resolve({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } }),
    findOne: (id: string) =>
      Promise.resolve({
        id,
        name: 'Dave Nguyen',
        email: null,
        mobile: '0466778899',
        state: 'invited',
        invitedAt: '2026-09-08T00:00:00.000Z',
        lastSignedInAt: null,
        awaitingApproval: false,
      }),
    findExisting: () => Promise.resolve(existingLogin),
    invite: (input: Record<string, unknown>) => {
      invited.push(input);
      return Promise.resolve('sup1');
    },
    setState: (id: string, _accountId: string, state: string) => {
      if (!stateChangeMatches) return Promise.resolve(false);
      stateChanges.push({ id, state });
      return Promise.resolve(true);
    },
    approve: (id: string) => {
      if (!approveMatches) return Promise.resolve(false);
      approvals.push(id);
      return Promise.resolve(true);
    },
  },
  portalAccountRepository: {
    find: () =>
      Promise.resolve({
        accountId: ACCOUNT_ID,
        customerCode: 'CLA001',
        name: 'Clarendon Homes',
        abn: '12345678901',
        paymentTermsDays: 7,
        poPolicy: 'required-before-invoice',
        captureMode: 'area-and-weight',
        primaryZone: 'sydney',
        contacts: [],
        preferredPickupWindow: null,
        approveNewSupervisors: false,
      }),
    update: (_id: string, input: Record<string, unknown>) => {
      accountUpdates.push(input);
      return Promise.resolve(true);
    },
    updateContactPreferences: (_id: string, contacts: ReadonlyArray<{ id: string }>) => {
      contactUpdates.push(contacts);
      return Promise.resolve();
    },
    completeOnboarding: (_id: string, input: Record<string, unknown>) => {
      onboardings.push(input);
      return Promise.resolve(true);
    },
    upsertAccountsContact: (input: Record<string, unknown>) => {
      contactUpserts.push(input);
      return Promise.resolve();
    },
  },
}));

vi.mock('../src/domains/accounts/account.repository.js', () => ({
  accountRepository: {
    findById: () =>
      Promise.resolve({
        id: ACCOUNT_ID,
        code: 'CLA001',
        name: 'Clarendon Homes',
        accountType: 'builder',
      }),
    findTermsAcceptance: () => Promise.resolve(existingTerms),
    recordTermsAcceptance: (input: Record<string, unknown>) => {
      termsWrites.push(input);
      return Promise.resolve(termsRecorded);
    },
  },
}));

vi.mock('../src/domains/accounts/account.service.js', () => ({ TERMS_VERSION: '2026-02' }));

const { portalAccountService } = await import('../src/domains/portal/portal-account.service.js');

const ADMIN = {
  userId: 'usr0000000000000000000c1',
  name: 'Angela Fitzgerald',
  roles: ['customer-administrator'] as Role[],
  accountId: ACCOUNT_ID,
};

const SUPERVISOR = {
  userId: 'usr0000000000000000000s1',
  name: 'Dave Nguyen',
  roles: ['customer-site-supervisor'] as Role[],
  accountId: ACCOUNT_ID,
};

function invite(overrides: Partial<PortalSupervisorInvite> = {}): PortalSupervisorInvite {
  return { name: 'Sam Farrar', email: '', mobile: '0400111222', ...overrides };
}

function onboarding(overrides: Partial<AccountOnboarding> = {}): AccountOnboarding {
  return {
    legalName: 'Clarendon Homes Pty Ltd',
    tradingName: 'Clarendon',
    abn: '12345678901',
    addressLine: '1 Builder Street',
    suburb: 'Kellyville',
    postcode: '2155',
    accountsContactName: 'Marcus Webb',
    accountsContactEmail: 'ap@clarendon.com.au',
    certificateEmail: 'sustainability@clarendon.com.au',
    acceptedByName: 'Robert Clarendon',
    acceptedByRole: 'Director',
    termsAccepted: true,
    ...overrides,
  };
}

beforeEach(() => {
  invited = [];
  stateChanges = [];
  approvals = [];
  accountUpdates = [];
  contactUpdates = [];
  onboardings = [];
  contactUpserts = [];
  termsWrites = [];
  pdfIdsSeen = [];
  existingLogin = null;
  stateChangeMatches = true;
  approveMatches = true;
  existingTerms = null;
  termsRecorded = true;
  ownedIds = ['inv1'];
});

describe('a supervisor sees none of this (M1.5)', () => {
  /*
   * ⚠️ Refused outright, not filtered. What the business is billed is not a
   * supervisor's business, and a filtered list still leaks through a total.
   */
  it('refuses invoices', async () => {
    await expect(
      portalAccountService.invoices({ page: 1, pageSize: 20 }, SUPERVISOR),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses the supervisor list', async () => {
    await expect(
      portalAccountService.supervisors({ page: 1, pageSize: 20 }, SUPERVISOR),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses inviting anybody', async () => {
    await expect(
      portalAccountService.inviteSupervisor(invite(), SUPERVISOR),
    ).rejects.toMatchObject({ status: 403 });

    expect(invited).toHaveLength(0);
  });

  it('refuses the account screen', async () => {
    await expect(portalAccountService.account(SUPERVISOR)).rejects.toMatchObject({ status: 403 });
  });

  it('refuses accepting the terms', async () => {
    await expect(
      portalAccountService.completeOnboarding(onboarding(), SUPERVISOR),
    ).rejects.toMatchObject({ status: 403 });

    expect(termsWrites).toHaveLength(0);
  });

  it('refuses a session with no account at all', async () => {
    await expect(
      portalAccountService.account({ ...ADMIN, accountId: null }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('invoice PDFs', () => {
  it('renders only invoices the account owns', async () => {
    await portalAccountService.requestInvoicePdf(['inv1', 'inv-someone-else'], ADMIN);

    // Both ids reach the ownership filter; only the owned one comes back.
    expect(pdfIdsSeen).toHaveLength(2);
  });

  it('404s when none of the ids belong to this account', async () => {
    ownedIds = [];

    await expect(
      portalAccountService.requestInvoicePdf(['inv-someone-else'], ADMIN),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses an empty selection', async () => {
    await expect(portalAccountService.requestInvoicePdf([], ADMIN)).rejects.toMatchObject({
      status: 422,
    });
  });
});

describe('inviting a supervisor (M5.14)', () => {
  /*
   * The primary channel is SMS: many supervisors use a personal Gmail or have
   * no work email. Requiring one would exclude the population this serves.
   */
  it('accepts a mobile with no email', async () => {
    await portalAccountService.inviteSupervisor(invite({ email: '' }), ADMIN);

    expect(invited[0]).toMatchObject({ mobile: '0400111222', email: null });
  });

  it('accepts an email with no mobile', async () => {
    await portalAccountService.inviteSupervisor(
      invite({ mobile: '', email: 'sam@newlands.com.au' }),
      ADMIN,
    );

    expect(invited[0]).toMatchObject({ email: 'sam@newlands.com.au', mobile: null });
  });

  it('refuses neither', async () => {
    await expect(
      portalAccountService.inviteSupervisor(invite({ email: '', mobile: '' }), ADMIN),
    ).rejects.toMatchObject({ status: 422 });
  });

  /*
   * A login belongs to a person, not an account. Re-creating one would collide
   * on the unique index and surface as a database error rather than an
   * explanation.
   */
  it('refuses somebody who already has a login here', async () => {
    existingLogin = { id: 'usr9', accountId: ACCOUNT_ID };

    await expect(portalAccountService.inviteSupervisor(invite(), ADMIN)).rejects.toMatchObject({
      status: 409,
    });
    expect(invited).toHaveLength(0);
  });

  it('refuses somebody who has a login on another account, without naming it', async () => {
    existingLogin = { id: 'usr9', accountId: 'acc-other' };

    await expect(portalAccountService.inviteSupervisor(invite(), ADMIN)).rejects.toMatchObject({
      status: 409,
      // Deliberately does not say WHICH account — that would leak a customer
      // relationship to a competitor.
      message: expect.stringContaining('1300 395 438'),
    });
  });

  /* Inviting somebody IS the approval; `approveNewSupervisors` gates the
   * join-by-code door instead. */
  it('does not mark an invited supervisor as awaiting approval', async () => {
    await portalAccountService.inviteSupervisor(invite(), ADMIN);

    expect(invited[0]?.awaitingApproval).toBe(false);
  });
});

describe('suspending a supervisor', () => {
  it('suspends and reactivates', async () => {
    await portalAccountService.setSupervisorState('sup1', 'suspended', ADMIN);
    await portalAccountService.setSupervisorState('sup1', 'active', ADMIN);

    expect(stateChanges.map((change) => change.state)).toEqual(['suspended', 'active']);
  });

  /*
   * `invited` is derived from never having signed in. Setting it would push a
   * real login into a state its own history contradicts.
   */
  it('refuses to set the derived invited state', async () => {
    await expect(
      portalAccountService.setSupervisorState('sup1', 'invited', ADMIN),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses to suspend your own login', async () => {
    await expect(
      portalAccountService.setSupervisorState(ADMIN.userId, 'suspended', ADMIN),
    ).rejects.toMatchObject({ status: 409 });

    expect(stateChanges).toHaveLength(0);
  });

  it('404s a supervisor on another account', async () => {
    stateChangeMatches = false;

    await expect(
      portalAccountService.setSupervisorState('sup-other', 'suspended', ADMIN),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('conflicts approving somebody who is not waiting', async () => {
    approveMatches = false;

    await expect(portalAccountService.approveSupervisor('sup1', ADMIN)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('approves a join-by-code request', async () => {
    await portalAccountService.approveSupervisor('sup1', ADMIN);

    expect(approvals).toEqual(['sup1']);
  });
});

describe('account preferences (M5.15)', () => {
  it('saves the preferences a customer owns', async () => {
    await portalAccountService.updateAccount(
      {
        preferredPickupWindow: '7am to 11am',
        approveNewSupervisors: true,
        contacts: [{ id: 'c1', notifyBySms: true, notifyByEmail: false }],
      },
      ADMIN,
    );

    expect(accountUpdates[0]).toEqual({
      preferredPickupWindow: '7am to 11am',
      approveNewSupervisors: true,
    });
    expect(contactUpdates[0]).toHaveLength(1);
  });

  it('normalises an empty pickup window to null', async () => {
    await portalAccountService.updateAccount(
      { preferredPickupWindow: '   ', approveNewSupervisors: false, contacts: [] },
      ADMIN,
    );

    // Null, not an empty string — "no preference" is a value, not a blank.
    expect(accountUpdates[0]?.preferredPickupWindow).toBeNull();
  });
});

describe('onboarding — the legal record (Journey A.4)', () => {
  it('saves the details the customer is the authority on', async () => {
    await portalAccountService.completeOnboarding(onboarding(), ADMIN);

    expect(onboardings[0]).toMatchObject({
      legalName: 'Clarendon Homes Pty Ltd',
      abn: '12345678901',
      suburb: 'Kellyville',
      postcode: '2155',
    });
  });

  /*
   * ⚠️ Matt, 31:04 — certificates often go to a different team from invoices.
   * Asked here because the customer knows and the office does not.
   */
  it('records a separate certificate email', async () => {
    await portalAccountService.completeOnboarding(onboarding(), ADMIN);

    expect(onboardings[0]?.certificateEmail).toBe('sustainability@clarendon.com.au');
    expect(contactUpserts[0]).toMatchObject({ email: 'ap@clarendon.com.au' });
  });

  it('treats a blank certificate email as null, not an empty string', async () => {
    await portalAccountService.completeOnboarding(onboarding({ certificateEmail: '' }), ADMIN);

    expect(onboardings[0]?.certificateEmail).toBeNull();
  });

  /*
   * ⚠️ The acceptance names the person who ACCEPTED, typed by them — not the
   * session user. A director's guarantee is given by a named individual, and the
   * person logged in may be an accounts clerk acting on their behalf.
   */
  it('records the typed name, not the session user', async () => {
    await portalAccountService.completeOnboarding(onboarding(), ADMIN);

    expect(termsWrites[0]).toMatchObject({
      acceptedByName: 'Robert Clarendon',
      acceptedByRole: 'Director',
      termsVersion: '2026-02',
    });
    expect(termsWrites[0]?.acceptedByName).not.toBe(ADMIN.name);
  });

  /* The record Matt chases as a signed PDF. A second write would silently
   * replace who signed and when. */
  it('refuses when the terms were already accepted', async () => {
    existingTerms = { acceptedByName: 'Robert Clarendon', acceptedAt: '2026-09-01T00:00:00.000Z' };

    await expect(
      portalAccountService.completeOnboarding(onboarding(), ADMIN),
    ).rejects.toMatchObject({ status: 409 });

    expect(termsWrites).toHaveLength(0);
  });

  it('refuses when somebody accepted mid-flow', async () => {
    termsRecorded = false;

    await expect(
      portalAccountService.completeOnboarding(onboarding(), ADMIN),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('reports the terms as outstanding before acceptance', async () => {
    const invite = await portalAccountService.onboardingInvite(ADMIN);

    expect(invite.state).toBe('awaiting-terms');
    expect(invite.acceptance).toBeNull();
    expect(invite.termsVersion).toBe('2026-02');
  });

  it('reports complete once accepted', async () => {
    existingTerms = {
      acceptedAt: '2026-09-01T00:00:00.000Z',
      acceptedByName: 'Robert Clarendon',
      acceptedByRole: 'Director',
      termsVersion: '2026-02',
    };

    const invite = await portalAccountService.onboardingInvite(ADMIN);

    expect(invite.state).toBe('complete');
    expect(invite.acceptance).not.toBeNull();
  });
});
