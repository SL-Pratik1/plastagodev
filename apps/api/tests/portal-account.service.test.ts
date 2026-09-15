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
/** What actually reached the renderer, after the ownership filter. */
let renderedIds: readonly string[] = [];

/** What the repositories report back. Set per test. */
let existingLogin: { id: string; accountId: string | null } | null = null;
let stateChangeMatches = true;
let approveMatches = true;
let ownedIds: string[] = ['inv1'];
/** Builder or contractor — the supervisor endpoints are builders-only (M5.14). */
let accountType: 'builder' | 'contractor' | null = 'builder';

const ACCOUNT_ID = 'acc0000000000000000000a1';

vi.mock('../src/domains/portal/portal.repository.js', () => ({
  listInvoices: () =>
    Promise.resolve({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } }),
  ownedInvoiceIds: (_accountId: string, ids: readonly string[]) => {
    pdfIdsSeen = ids;
    return Promise.resolve(ownedIds);
  },
}));

/*
 * The renderer itself is another domain's, and it is exercised by the invoice
 * tests. What matters HERE is which ids the portal lets through to it — the
 * ownership filter is the portal's own rule, and mocking this is what makes the
 * assertion about that rule rather than about pdf-lib.
 */
vi.mock('../src/domains/invoices/invoice.service.js', () => ({
  invoiceService: {
    requestPdf: (ids: readonly string[]) => {
      renderedIds = ids;
      return Promise.resolve({
        requested: ids.length,
        downloads: ids.map((id, index) => ({
          id,
          invoiceNumber: 104_100 + index,
          fileName: `Invoice PGA-${String(104_100 + index)}.pdf`,
          url: `https://storage.test/${id}.pdf`,
        })),
      });
    },
  },
}));

/*
 * Inviting a supervisor now SENDS the invitation — the portal told the
 * administrator "We have texted them a link" while the service created the
 * user row and stopped. Stubbed so the unit tests do not reach the outbound
 * queue; that it is called at all is asserted below.
 */
vi.mock('../src/domains/portal/supervisor-provisioning.service.js', () => ({
  supervisorProvisioning: {
    notify: vi.fn(async () => undefined),
    ensureForAccount: vi.fn(async () => ({ status: 'skipped' })),
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
    accountTypeOf: () => Promise.resolve(accountType),
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
    /*
     * A whole account, not the four fields the old invite happened to read.
     *
     * The details screen opens on what is ALREADY on file — a form that arrived
     * blank on a second visit is how a complete record gets replaced with a
     * half-filled one — so the invite now reads the address, the ABN and the
     * accounts contact off this too.
     */
    findById: () =>
      Promise.resolve({
        id: ACCOUNT_ID,
        code: 'CLA001',
        name: 'Clarendon Homes',
        accountType: 'builder',
        abn: '12345678901',
        tradingName: 'Clarendon',
        addressLine: '1 Builder Street',
        suburb: 'Kellyville',
        postcode: '2155',
        certificateEmail: 'sustainability@clarendon.com.au',
        detailsCompletedAt: null,
        contacts: [
          {
            id: 'contact1',
            name: 'Marcus Webb',
            role: 'accounts',
            email: 'ap@clarendon.com.au',
            mobile: null,
            notifyBySms: false,
            notifyByEmail: true,
          },
        ],
      }),
  },
}));

import { supervisorProvisioning } from '../src/domains/portal/supervisor-provisioning.service.js';
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
  renderedIds = [];
  existingLogin = null;
  stateChangeMatches = true;
  approveMatches = true;
  ownedIds = ['inv1'];
  accountType = 'builder';
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
    await expect(portalAccountService.inviteSupervisor(invite(), SUPERVISOR)).rejects.toMatchObject(
      { status: 403 },
    );

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
    await expect(portalAccountService.account({ ...ADMIN, accountId: null })).rejects.toMatchObject(
      { status: 403 },
    );
  });
});

describe('a contractor has no supervisors (Matt, 21:55)', () => {
  /*
   * ── Why these four tests exist ────────────────────────────────────────────
   * The portal hides the "Site supervisors" item for a contractor. Hiding a
   * menu is a courtesy to the user, not a boundary: the route was reachable by
   * typing it, and every endpoint behind it worked, so a contractor could mint
   * supervisor logins on a journey that has no supervisors in it.
   *
   * The refusal is 403 on all four, and the WRITES must not happen — a check
   * that only hides the list would still let an invite through.
   */
  beforeEach(() => {
    accountType = 'contractor';
  });

  it('refuses the supervisor list', async () => {
    await expect(
      portalAccountService.supervisors({ page: 1, pageSize: 20 }, ADMIN),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses inviting a supervisor, and creates nobody', async () => {
    await expect(portalAccountService.inviteSupervisor(invite(), ADMIN)).rejects.toMatchObject({
      status: 403,
    });

    expect(invited).toHaveLength(0);
  });

  it('refuses suspending a supervisor', async () => {
    await expect(
      portalAccountService.setSupervisorState('sup1', 'suspended', ADMIN),
    ).rejects.toMatchObject({ status: 403 });

    expect(stateChanges).toHaveLength(0);
  });

  it('refuses approving a supervisor', async () => {
    await expect(portalAccountService.approveSupervisor('sup1', ADMIN)).rejects.toMatchObject({
      status: 403,
    });

    expect(approvals).toHaveLength(0);
  });

  // The commercial screens are the contractor administrator's as much as the
  // builder's — this gate is about supervisors, and must not widen.
  it('still allows the invoices they are entitled to', async () => {
    await expect(
      portalAccountService.invoices({ page: 1, pageSize: 20 }, ADMIN),
    ).resolves.toMatchObject({ data: [] });
  });
});

describe('an account that has vanished', () => {
  // Unknown type is a refusal, not a pass. Failing open here would mean a
  // broken session got MORE than a working one.
  it('refuses the supervisor list rather than assuming a builder', async () => {
    accountType = null;

    await expect(
      portalAccountService.supervisors({ page: 1, pageSize: 20 }, ADMIN),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('invoice PDFs', () => {
  it('renders only invoices the account owns', async () => {
    const result = await portalAccountService.requestInvoicePdf(
      ['inv1', 'inv-someone-else'],
      ADMIN,
    );

    // Both ids reach the ownership filter; only the owned one comes back.
    expect(pdfIdsSeen).toHaveLength(2);

    /*
     * ⚠️ The one that matters. Another customer's id must not reach the
     * renderer at all — not be rendered and then filtered out of the response,
     * which would still have produced their document.
     */
    expect(renderedIds).toEqual(['inv1']);
    expect(result.downloads).toHaveLength(1);
  });

  it('hands back a link, not a promise that one is coming', async () => {
    /*
     * This endpoint used to log a line and answer `{ queued: 1 }` while
     * rendering nothing, so the portal's download button did nothing at all.
     * A URL in the response is what makes the button real.
     */
    const result = await portalAccountService.requestInvoicePdf(['inv1'], ADMIN);

    expect(result.downloads[0]).toMatchObject({
      id: 'inv1',
      fileName: 'Invoice PGA-104100.pdf',
      url: 'https://storage.test/inv1.pdf',
    });
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

describe('an invitation that could never arrive', () => {
  /*
   * ⚠️ The contract used to check only the LENGTH of these.
   *
   * The invite dialog checked the shape of both and the schema checked neither,
   * so the rule was drawn rather than enforced: posted directly, a landline or
   * `mobile: "hello"` returned 201 and created a real login. It can never be
   * used — a supervisor signs in by their `phoneNumber`, so the one-time code
   * goes nowhere — while the administrator is told it was texted.
   */
  it('refuses a landline where a mobile belongs', async () => {
    await expect(
      portalAccountService.inviteSupervisor(invite({ email: '', mobile: '0298765432' }), ADMIN),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses something that is not a number at all', async () => {
    await expect(
      portalAccountService.inviteSupervisor(invite({ email: '', mobile: 'hello' }), ADMIN),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses an email with no @', async () => {
    await expect(
      portalAccountService.inviteSupervisor(invite({ mobile: '', email: 'not-an-email' }), ADMIN),
    ).rejects.toMatchObject({ status: 422 });
  });

  /* Spaces and +61 are how people actually type a number. */
  it('accepts an Australian mobile however it was typed', async () => {
    await expect(
      portalAccountService.inviteSupervisor(invite({ email: '', mobile: '+61 412 345 678' }), ADMIN),
    ).resolves.toBeDefined();
  });
});

describe('the invitation is actually sent', () => {
  /*
   * The office path (a purchase order naming a supervisor) has provisioned AND
   * notified from the beginning. The portal path created the row and sent
   * nothing, so the person was never contacted and the builder had no way to
   * tell — the row read "invited" either way.
   */
  it('tells the person they have access', async () => {
    await portalAccountService.inviteSupervisor(invite({ email: '' }), ADMIN);

    /*
     * Notified from the STORED record, not the input: the repository is what
     * normalised the number and settled which of email or mobile survived, and
     * the message has to match what was actually saved against the login.
     */
    expect(supervisorProvisioning.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'sup1',
        provisionedBy: ADMIN.name,
        sourceLabel: 'portal invite',
      }),
    );
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

describe('the customer completing their own details', () => {
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
   * ⚠️ RE-SUBMITTABLE, and that is a deliberate reversal.
   *
   * This used to refuse a second submission with a 409, because the same call
   * also recorded a terms acceptance and a guarantee that can be silently
   * replaced is not evidence of anything. The terms are gone, and what is left
   * is ordinary correctable data — refusing a customer who has moved office
   * would be refusing the one person who knows their new address.
   */
  it('lets a customer correct details they have already given', async () => {
    await portalAccountService.completeOnboarding(onboarding(), ADMIN);
    await portalAccountService.completeOnboarding(
      onboarding({ addressLine: '9 New Road', suburb: 'Penrith', postcode: '2750' }),
      ADMIN,
    );

    expect(onboardings).toHaveLength(2);
    expect(onboardings[1]).toMatchObject({ suburb: 'Penrith', postcode: '2750' });
  });

  it('opens on what is already on file, so one correction does not blank the rest', async () => {
    const invite = await portalAccountService.onboardingInvite(ADMIN);

    /*
     * The form is re-openable now that nothing gates it. A screen that arrived
     * blank on the second visit is how a complete record gets replaced with a
     * half-filled one — so the invite carries the stored details, not just a
     * suggested name.
     */
    expect(invite.details).not.toBeNull();
    expect(invite.suggestedLegalName).toBeTruthy();
  });

  it('reports whether the customer has ever confirmed their details', async () => {
    const invite = await portalAccountService.onboardingInvite(ADMIN);

    // A date, not a state: "have they filled this in?" and "is it still
    // current?" are the same question a year later.
    expect(invite).toHaveProperty('completedAt');
  });
});
