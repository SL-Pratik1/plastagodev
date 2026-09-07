import { AccountListItemSchema, AccountSchema } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDraft, Role } from '@plastago/shared';
import { createFakeAccountRepository } from './helpers/fake-accounts.js';

/**
 * Account rules (M2.8 · W8).
 *
 * These test the two things a repository cannot: who is allowed to see what,
 * and what the office is told when a create fails. Both are decisions, and both
 * are the kind that get quietly reimplemented in a controller if they are not
 * pinned here.
 */

let repo: ReturnType<typeof createFakeAccountRepository>;

// A GETTER, not a value: `vi.mock` factories hoist above every import, so the
// fake does not exist yet when this runs.
vi.mock('../src/domains/accounts/account.repository.js', () => ({
  get accountRepository() {
    return repo.repository;
  },
}));

const { accountService, TERMS_VERSION } = await import(
  '../src/domains/accounts/account.service.js'
);

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
    primaryZone: 'sydney',
    accountsContactName: 'Jo Bloggs',
    accountsContactEmail: 'jo@acme.com.au',
    sendInvitation: false,
    notes: '',
    ...overrides,
  };
}

beforeEach(() => {
  repo = createFakeAccountRepository();
});

describe('creating an account', () => {
  it('returns a row the contract accepts', async () => {
    const created = await accountService.create(draft());
    expect(() => AccountListItemSchema.parse(created)).not.toThrow();
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
   * Matt, 6:36 — the large builders never see the self-serve flow, and their
   * terms live in a contract signed long before this screen existed. Leaving
   * those accounts "awaiting terms" forever would make the flag meaningless for
   * the accounts where it does matter.
   */
  it('records terms as agreed off-system when no invitation is sent', async () => {
    await accountService.create(draft({ sendInvitation: false }));
    expect(repo.lastCreate?.termsAgreedOffSystem).toEqual({ termsVersion: TERMS_VERSION });
  });

  it('leaves terms outstanding when an invitation IS sent', async () => {
    await accountService.create(draft({ sendInvitation: true }));
    expect(repo.lastCreate?.termsAgreedOffSystem).toBeNull();
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
   * ── Regression ────────────────────────────────────────────────────────
   * The `onboarding` facet was accepted by the schema, passed through, and
   * never applied — "show me who has not signed" silently returned everybody.
   * Caught by QA against a real database, not by a unit test, because the
   * service hands facets to the repository untouched.
   *
   * Pinned here so the facet cannot be dropped again on its way down: the
   * repository's own handling is verified against Mongo, but this proves the
   * service still passes it along.
   */
  it('passes the onboarding facet through to the repository', async () => {
    await accountService.list(
      { page: 1, pageSize: 20, onboarding: 'awaiting-terms' },
      OFFICE,
    );
    expect(repo.lastQuery?.onboarding).toBe('awaiting-terms');
  });
});

describe('the risk assessment rule', () => {
  it('lets the office turn it on', async () => {
    const id = repo.seedAccount({ code: 'CLA001' });
    const account = await accountService.setRiskAssessmentRequired(id, true, OFFICE);
    expect(account.riskAssessmentRequired).toBe(true);
  });

  // It changes what a DRIVER is made to do at a fence. Not a customer's call.
  it('refuses a customer', async () => {
    const id = repo.seedAccount({ code: 'OWN001', id: CUSTOMER.accountId });
    await expect(
      accountService.setRiskAssessmentRequired(id, true, CUSTOMER),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('404s an account that does not exist', async () => {
    await expect(
      accountService.setRiskAssessmentRequired('c'.repeat(24), true, OFFICE),
    ).rejects.toMatchObject({ status: 404 });
  });
});
