import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDraft, LeadConversion, Role } from '@plastago/shared';
import {
  clearOutbound,
  makeFakeNotificationRepository,
  recordingProviders,
  sentMessages,
} from './helpers/fake-outbound.js';

/**
 * The two doors into the customer list must leave the room in the same state.
 *
 * ── What this file is for ─────────────────────────────────────────────────
 * An account is created in two places: typed in on the Customers tab, or
 * converted from a lead. They were separate implementations of the same idea,
 * and they drifted — invisibly, because nobody looks at both at once:
 *
 *  · the rate card was silently defaulted on one screen and forced on the other
 *  · a taken customer code suggested a free one here and did not there
 *  · the "an email needs a name attached" rule was enforced on one side only
 *  · the invitation checkbox sent nothing at all from the Customers tab
 *
 * Every one of those reaches the customer. Two accounts that were set up on the
 * same terms an hour apart should not be distinguishable by which screen the
 * office happened to use, and a builder ringing about their invoice should not
 * get a different answer depending on how they were signed up.
 *
 * ⚠️ These assert on the REPOSITORY INPUT — the row each path is about to
 * write — rather than on the response. That is the thing the customer
 * eventually experiences, and it is the layer where the two used to disagree.
 */

/** Every account row written during a test, in order, by either path. */
let accountsCreated: Array<Record<string, unknown>> = [];
let codeTaken = false;
let storedLead: Record<string, unknown> | null = null;

vi.mock('../src/domains/accounts/account.repository.js', () => ({
  accountRepository: {
    codeExists: () => Promise.resolve(codeTaken),
    nextFreeCode: (code: string) => Promise.resolve(`${code.slice(0, 3)}002`),
    create: (input: Record<string, unknown>) => {
      accountsCreated.push(input);
      /*
       * A DIFFERENT id each time. The welcome email is keyed
       * `account-welcome:<accountId>` and the outbound log refuses a second
       * claim on a subject that already went out — a fake handing back one id
       * would make the second account's email look like a duplicate of the
       * first, and the test would be measuring the fake.
       */
      return Promise.resolve({
        id: String(accountsCreated.length).padStart(24, '0'),
        code: input.code,
        name: input.name,
      });
    },
  },
}));

vi.mock('../src/domains/queues/lead.repository.js', () => ({
  leadRepository: {
    findById: () => Promise.resolve(storedLead),
    markConverted: () => Promise.resolve(true),
    addNote: () => Promise.resolve({ id: 'n1', at: '', author: '', body: '' }),
  },
}));

vi.mock('../src/domains/notifications/notification.repository.js', () => ({
  notificationRepository: makeFakeNotificationRepository(),
}));

vi.mock('../src/domains/settings/settings.repository.js', () => ({
  settingsRepository: {
    findRateCard: (id: string) =>
      Promise.resolve(
        id === 'tier-1' ? { id, label: 'Tier 1', effectiveFrom: '2026-04-01' } : null,
      ),
  },
}));

const { setMessagingProvidersForTests } = await import('../src/integrations/messaging.js');
const { accountService } = await import('../src/domains/accounts/account.service.js');
const { leadService } = await import('../src/domains/queues/lead.service.js');

const OPERATIONS = {
  roles: ['operations'] as Role[],
  name: 'Ops',
  userId: '000000000000000000000009',
};

const LEAD_ID = '000000000000000000000002';

/**
 * The same commercial terms, expressed as each path expects them.
 *
 * Held as one object so the two drafts below cannot drift apart in the test
 * either — a parity check whose inputs differ proves nothing.
 */
const TERMS = {
  customerCode: 'ACM001',
  legalName: 'Acme Plastering Pty Ltd',
  abn: '12345678901',
  accountType: 'contractor',
  brandId: 'plastago',
  rateCardId: 'tier-1',
  poPolicy: 'required-before-invoice',
  captureMode: 'area-and-weight',
  paymentTermsDays: 30,
  primaryZone: 'newcastle',
  accountsContactName: 'Jo Bloggs',
  accountsContactEmail: 'jo@acme.com.au',
} as const;

function directDraft(overrides: Partial<AccountDraft> = {}): AccountDraft {
  return { ...TERMS, notes: '', sendInvitation: false, ...overrides };
}

function conversion(overrides: Partial<LeadConversion> = {}): LeadConversion {
  return { ...TERMS, notes: '', sendInvitation: false, ...overrides };
}

beforeEach(() => {
  accountsCreated = [];
  codeTaken = false;
  storedLead = {
    id: LEAD_ID,
    companyName: 'Acme Plastering',
    contactName: 'Whoever Rang',
    email: 'reception@acme.com.au',
    convertedAccountId: null,
  };
  clearOutbound();
  setMessagingProvidersForTests(recordingProviders());
});

describe('both doors into the customer list', () => {
  it('write the same account row for the same terms', async () => {
    await accountService.create(directDraft());
    await leadService.convert(LEAD_ID, conversion(), OPERATIONS);

    const [typedIn, converted] = accountsCreated;
    expect(typedIn).toBeDefined();
    expect(converted).toBeDefined();

    /*
     * `notes` is the ONLY exclusion, and it legitimately differs: a conversion
     * records which lead it came from, and there is no lead behind a direct
     * create. It is checked on its own further down.
     *
     * Everything else is compared, including the terms field that used to be
     * excluded as an open question — it no longer exists on either path.
     */
    const exclude = (row: Record<string, unknown>) => {
      const { notes: _notes, ...rest } = row;
      return rest;
    };

    expect(exclude(converted as Record<string, unknown>)).toEqual(
      exclude(typedIn as Record<string, unknown>),
    );
  });

  /*
   * ⚠️ THE DIVERGENCE IS GONE, and this is what closed it.
   *
   * A test stood here pinning the one field the two doors answered differently:
   * with the invitation unticked, the Customers tab recorded the terms as
   * "agreed off-system" and a conversion left them outstanding — which meant a
   * converted customer could be locked out of the portal with no email on its
   * way to unlock them.
   *
   * It was not settled by choosing a side. The client removed the terms feature
   * entirely, so `termsAgreedOffSystem` no longer exists on either path and the
   * equality check above now covers every field an account is created with.
   */

  it('both refuse a rate card that does not exist', async () => {
    await expect(
      accountService.create(directDraft({ rateCardId: 'retired' })),
    ).rejects.toMatchObject({ status: 422, issues: [{ path: 'rateCardId' }] });

    await expect(
      leadService.convert(LEAD_ID, conversion({ rateCardId: 'retired' }), OPERATIONS),
    ).rejects.toMatchObject({ status: 422, issues: [{ path: 'rateCardId' }] });

    expect(accountsCreated).toHaveLength(0);
  });

  /*
   * Both screens propose "first three letters + 001", so every builder whose
   * name starts the same way collides on the same code. Conversion has always
   * answered with a free one; the Customers tab used to say only that the code
   * was taken, which asks the office to guess against a list only the server
   * can see.
   */
  it('both name a free code when the one asked for is taken', async () => {
    codeTaken = true;

    await expect(accountService.create(directDraft())).rejects.toMatchObject({
      status: 409,
      issues: [{ path: 'customerCode', message: expect.stringContaining('ACM002') as string }],
    });

    await expect(leadService.convert(LEAD_ID, conversion(), OPERATIONS)).rejects.toMatchObject({
      status: 409,
      issues: [{ path: 'customerCode', message: expect.stringContaining('ACM002') as string }],
    });
  });

  /*
   * An email with nobody attached to it is a support call waiting to happen —
   * the office cannot tell later whose address it was.
   *
   * ⚠️ The two reach that guarantee differently, and both are right. A direct
   * create has nothing to fall back on, so it refuses. A conversion always has
   * the lead's own contact behind it, so the name is filled rather than
   * demanded. What must hold on both paths is the OUTCOME: no account is ever
   * written holding an address nobody is named against.
   */
  it('never write an email with nobody attached to it', async () => {
    const blankName = { accountsContactName: '', accountsContactEmail: 'nobody@acme.com.au' };

    await expect(accountService.create(directDraft(blankName))).rejects.toMatchObject({
      status: 422,
      issues: [{ path: 'accountsContactName' }],
    });
    expect(accountsCreated).toHaveLength(0);

    await leadService.convert(LEAD_ID, conversion(blankName), OPERATIONS);

    expect(accountsCreated[0]?.contact).toMatchObject({
      name: 'Whoever Rang',
      email: 'nobody@acme.com.au',
    });
  });

  /*
   * ⚠️ The bug this whole file exists because of. The Customers tab accepted
   * the invitation checkbox, announced "an onboarding link is on its way to
   * their accounts contact", and queued nothing — the only welcome email in the
   * platform was the one the lead conversion sent.
   */
  it('both actually send the welcome email when it is asked for', async () => {
    const sent = await accountService.create(directDraft({ sendInvitation: true }));
    expect(sent.welcome).toMatchObject({ outcome: 'sent', channel: 'email' });

    const convertedResult = await leadService.convert(
      LEAD_ID,
      conversion({ sendInvitation: true }),
      OPERATIONS,
    );
    expect(convertedResult.welcome).toMatchObject({ outcome: 'sent', channel: 'email' });

    // Both to the ACCOUNTS contact — not, on the conversion, to whoever rang.
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages.every((message) => message.channel === 'email')).toBe(true);
    expect(sentMessages.every((message) => message.body.includes('ACM001'))).toBe(true);
  });

  it('both refuse an invitation with nowhere to send it', async () => {
    const noContact = {
      accountsContactName: '',
      accountsContactEmail: '',
      sendInvitation: true,
    };

    await expect(accountService.create(directDraft(noContact))).rejects.toMatchObject({
      status: 422,
      issues: [{ path: 'accountsContactEmail' }],
    });

    expect(accountsCreated).toHaveLength(0);
    expect(sentMessages).toHaveLength(0);
  });
});

describe('what a conversion keeps that a direct create cannot', () => {
  it('records which lead the account came from, above the office’s own notes', async () => {
    await leadService.convert(
      LEAD_ID,
      conversion({ notes: 'Pays on time. Ring Jo first.' }),
      OPERATIONS,
    );

    const notes = accountsCreated[0]?.notes as string;
    expect(notes).toContain('Converted from lead — Acme Plastering');
    // ⚠️ The typed note SURVIVES. The provenance line used to be the entire
    // field, so conversion was the one door with nowhere to record what was
    // agreed on the phone.
    expect(notes).toContain('Pays on time. Ring Jo first.');
  });

  it('falls back to the lead’s own contact when the office did not correct it', async () => {
    await leadService.convert(
      LEAD_ID,
      conversion({ accountsContactName: '', accountsContactEmail: '' }),
      OPERATIONS,
    );

    expect(accountsCreated[0]?.contact).toMatchObject({
      name: 'Whoever Rang',
      email: 'reception@acme.com.au',
    });
  });
});
