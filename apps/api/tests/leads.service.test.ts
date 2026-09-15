import type { LeadConversion, LeadCreate, Role } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearOutbound,
  makeFakeNotificationRepository,
  recordingProviders,
  sentMessages,
} from './helpers/fake-outbound.js';

/**
 * Leads and onboarding (M5, Journey A).
 *
 * ── What is actually under test ───────────────────────────────────────────
 * The rules that keep the pipeline honest. A lead cannot be created already
 * `won` — that would bypass A.4 and so bypass the rate card, the terms and the
 * account. A lead cannot be converted twice, because that is two accounts for
 * one builder and only one of them gets invoiced.
 */

let created: Array<Record<string, unknown>> = [];
let notes: Array<{ leadId: string; body: string }> = [];
let updates: Array<{ id: string; status: string; ownerName: string | null }> = [];
let accountsCreated: Array<Record<string, unknown>> = [];
let markedConverted: string[] = [];

let stored: Record<string, unknown> | null = null;
let updateMatches = true;
let convertMatches = true;
let codeTaken = false;
/** What the account repository suggests in place of a taken code. */
let nextFreeCode: string | null | undefined;
/** Whether the stored object behind an attachment row actually exists. */
let objectExists = true;

vi.mock('../src/domains/queues/lead.repository.js', () => ({
  leadRepository: {
    list: () =>
      Promise.resolve({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } }),
    findById: () => Promise.resolve(stored),
    findByEmail: () => Promise.resolve([]),
    create: (input: Record<string, unknown>) => {
      created.push(input);
      return Promise.resolve('lead1');
    },
    update: (id: string, input: { status: string; ownerName: string | null }) => {
      if (!updateMatches) return Promise.resolve(false);
      updates.push({ id, ...input });
      return Promise.resolve(true);
    },
    addNote: (input: { leadId: string; body: string }) => {
      notes.push(input);
      return Promise.resolve({
        id: 'n1',
        at: new Date().toISOString(),
        author: 'x',
        body: input.body,
      });
    },
    addAttachment: () => Promise.resolve({ id: 'att1' }),
    findAttachment: () => Promise.resolve({ id: 'att1', storageKey: 'leads/x/f.pdf' }),
    attachmentKeys: () => Promise.resolve(new Map([['att1', 'leads/x/f.pdf']])),
    removeAttachment: () => Promise.resolve(true),
    markConverted: (id: string) => {
      if (!convertMatches) return Promise.resolve(false);
      markedConverted.push(id);
      return Promise.resolve(true);
    },
    countOpen: () => Promise.resolve(7),
  },
}));

vi.mock('../src/domains/accounts/account.repository.js', () => ({
  accountRepository: {
    codeExists: () => Promise.resolve(codeTaken),
    /*
     * The double has to answer this: `convert` asks for the next free code on
     * the same prefix so a taken one comes back with "TES002 is free — use
     * that" instead of asking the office to guess against a list only the
     * server can see. Without it the refusal path threw a TypeError rather
     * than the 422 it is supposed to produce.
     */
    nextFreeCode: (code: string) =>
      Promise.resolve(nextFreeCode === undefined ? `${code.slice(0, 3)}002` : nextFreeCode),
    create: (input: Record<string, unknown>) => {
      accountsCreated.push(input);
      return Promise.resolve({ id: 'acc-new', ...input });
    },
  },
}));

vi.mock('../src/integrations/storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/integrations/storage.js')>();
  return {
    ...actual,
    getStorage: () => ({
      name: 'test',
      presignUpload: (input: { key: string }) =>
        Promise.resolve({
          key: input.key,
          uploadUrl: `https://example.test/${input.key}`,
          headers: {},
          expiresAt: new Date().toISOString(),
        }),
      presignDownload: (key: string) => Promise.resolve(`https://example.test/${key}`),
      put: () => Promise.resolve(),
      get: () => Promise.reject(new Error('not used')),
      remove: () => Promise.resolve(),
      /*
       * Switchable, because "the row exists but the object does not" is a real
       * state: the row is written when the upload URL is handed out, before the
       * browser has PUT anything.
       */
      exists: () => Promise.resolve(objectExists),
    }),
  };
});

/*
 * A.4 now acknowledges a website enquiry and welcomes a converted account, so
 * this suite reaches the outbound log. Faked for the usual reason: the real one
 * would buffer a write against a MongoDB that is not there.
 */
vi.mock('../src/domains/notifications/notification.repository.js', () => ({
  notificationRepository: makeFakeNotificationRepository(),
}));

/**
 * Which rate cards exist (M6.1).
 *
 * Conversion checks the chosen card is real before creating the account —
 * rate cards are records an administrator adds now, so an id naming nothing
 * would otherwise produce an account that cannot price its first booking.
 */
const knownRateCards = new Set<string>(['default', 'tier-1', 'tier-2', 'clarendon-domaine']);

vi.mock('../src/domains/settings/settings.repository.js', () => ({
  settingsRepository: {
    findRateCard: (id: string) =>
      Promise.resolve(
        knownRateCards.has(id) ? { id, label: `${id} rates`, effectiveFrom: '2026-04-01' } : null,
      ),
  },
}));

const { leadService } = await import('../src/domains/queues/lead.service.js');
const { setMessagingProvidersForTests } = await import('../src/integrations/messaging.js');

const OPERATIONS = {
  userId: 'usr0000000000000000000o1',
  name: 'Renee Alvarez',
  roles: ['operations'] as Role[],
};

const OFFICE = {
  userId: 'usr0000000000000000000f1',
  name: 'Priya Raman',
  roles: ['office-staff'] as Role[],
};

const DRIVER = {
  userId: 'usr0000000000000000000d1',
  name: 'Troy Holm',
  roles: ['driver'] as Role[],
};

const ID = 'a'.repeat(24);

function lead(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    companyName: 'Newlands Constructions',
    contactName: 'Sam Farrar',
    email: 'sam@newlands.com.au',
    mobile: '0400111222',
    status: 'quoted',
    source: 'phone',
    zone: 'sydney',
    suburbs: 'Oran Park, Catherine Field',
    typicalVolumeM2: 800,
    expectedFrequency: 'Weekly',
    heardAbout: 'Referral from Clarendon',
    ownerName: 'Renee Alvarez',
    createdAt: '2026-08-01T00:00:00.000Z',
    lastActivityAt: '2026-09-01T00:00:00.000Z',
    convertedAccountId: null,
    notes: [],
    attachments: [],
    ...overrides,
  };
}

function draft(overrides: Partial<LeadCreate> = {}): LeadCreate {
  return {
    companyName: 'Newlands Constructions',
    contactName: 'Sam Farrar',
    email: 'sam@newlands.com.au',
    mobile: '0400111222',
    source: 'phone',
    zone: 'sydney',
    suburbs: 'Oran Park',
    typicalVolumeM2: 800,
    expectedFrequency: 'Weekly',
    heardAbout: 'Referral',
    ownerName: '',
    note: 'Rang about a new estate',
    ...overrides,
  };
}

function conversion(overrides: Partial<LeadConversion> = {}): LeadConversion {
  return {
    customerCode: 'NEW001',
    legalName: 'Newlands Constructions Pty Ltd',
    abn: '12345678901',
    accountType: 'builder',
    brandId: 'plastago',
    rateCardId: 'default',
    poPolicy: 'required-before-invoice',
    captureMode: 'area-only',
    paymentTermsDays: 7,
    primaryZone: 'sydney',
    /*
     * Blank by default, so the default case is the one that exercises the
     * fallback to the lead's own contact. A test that always overrode it would
     * never notice the fallback breaking.
     */
    accountsContactName: '',
    accountsContactEmail: '',
    notes: '',
    sendInvitation: true,
    ...overrides,
  };
}

beforeEach(() => {
  created = [];
  notes = [];
  updates = [];
  accountsCreated = [];
  markedConverted = [];
  stored = lead();
  updateMatches = true;
  convertMatches = true;
  codeTaken = false;
  nextFreeCode = undefined;
  objectExists = true;
  clearOutbound();
  setMessagingProvidersForTests(recordingProviders());
});

/**
 * The messages A.4 promises (M5 · M8.2).
 *
 * The wizard's own toast used to say a welcome email was "on its way to the
 * contact" while nothing had attempted to send one. These are about the two
 * messages actually leaving.
 */
describe('what the customer is told', () => {
  it('acknowledges a website enquiry', async () => {
    await leadService.create(draft({ source: 'enquiry-form' }), OFFICE);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.channel).toBe('email');
    expect(sentMessages[0]?.subject).toContain('enquiry');
  });

  /*
   * ⚠️ NOT for a phone lead. They have just spoken to somebody; an email
   * afterwards saying we will be in touch reads as if nobody noticed the call.
   */
  it('stays quiet on a lead taken over the phone', async () => {
    await leadService.create(draft({ source: 'phone' }), OFFICE);

    expect(sentMessages).toHaveLength(0);
  });

  it('welcomes a converted account, with its customer code', async () => {
    const result = await leadService.convert(ID, conversion({ sendInvitation: true }), OPERATIONS);

    expect(result.welcome).toMatchObject({ outcome: 'sent', channel: 'email' });
    // The code is the handle every later conversation uses — see the note in
    // `notice-messages.ts`.
    expect(sentMessages.at(-1)?.body).toContain('NEW001');
  });

  it('sends nothing when the wizard says not to', async () => {
    const result = await leadService.convert(ID, conversion({ sendInvitation: false }), OPERATIONS);

    expect(result.welcome).toBeNull();
    expect(sentMessages).toHaveLength(0);
  });

  /** An account that exists must survive a mail outage — it cannot be undone. */
  it('still converts when the welcome email fails', async () => {
    const { providerFailure } = await import('./helpers/fake-outbound.js');
    providerFailure.message = 'mailbox unavailable';

    const result = await leadService.convert(ID, conversion({ sendInvitation: true }), OPERATIONS);

    expect(result.accountId).toBe('acc-new');
    expect(result.welcome).toMatchObject({ outcome: 'failed' });
  });
});

describe('taking a lead by hand (A.1)', () => {
  /*
   * ⚠️ Every lead starts `new`. Letting intake choose would allow one created
   * already `won`, bypassing A.4 — and so bypassing the rate card, the terms
   * and the account that "won" is supposed to mean.
   */
  it('never lets intake choose a status', async () => {
    await leadService.create(draft(), OFFICE);

    // The service passes no status at all — the repository hard-codes `new`.
    // A status that could travel from here is one that could arrive as `won`.
    expect(created[0]).not.toHaveProperty('status');
    expect(Object.keys(created[0] ?? {})).not.toContain('status');
  });

  /* What was said on the call is lost the moment the person hangs up. */
  it('files the call itself as the first note', async () => {
    await leadService.create(draft({ note: 'Rang about Oran Park, 40 lots' }), OFFICE);

    expect(notes[0]?.body).toBe('Rang about Oran Park, 40 lots');
  });

  it('does not file an empty note', async () => {
    await leadService.create(draft({ note: '   ' }), OFFICE);

    expect(notes).toHaveLength(0);
  });

  it('defaults the owner to whoever took the call', async () => {
    await leadService.create(draft({ ownerName: '' }), OFFICE);

    expect(created[0]?.ownerName).toBe('Priya Raman');
  });

  /*
   * A phone call cannot insist. A thin lead in the queue beats a perfect one in
   * a notebook — so an unknown volume is null, not zero.
   */
  it('accepts a lead with almost nothing filled in', async () => {
    await expect(
      leadService.create(
        draft({
          mobile: '',
          zone: null,
          suburbs: '',
          typicalVolumeM2: null,
          expectedFrequency: '',
          heardAbout: '',
          note: '',
        }),
        OFFICE,
      ),
    ).resolves.toBeDefined();

    expect(created[0]?.typicalVolumeM2).toBeNull();
    expect(created[0]?.mobile).toBeNull();
  });

  it('keeps drivers out of the pipeline', async () => {
    await expect(leadService.create(draft(), DRIVER)).rejects.toMatchObject({ status: 403 });
  });
});

describe('working a lead', () => {
  it('records the status change and the note together', async () => {
    await leadService.update(
      ID,
      { status: 'quoted', ownerName: 'Renee Alvarez', note: 'Sent the proposal' },
      OFFICE,
    );

    expect(updates[0]).toMatchObject({ status: 'quoted' });
    expect(notes[0]?.body).toBe('Sent the proposal');
  });

  /* A converted lead is history — re-opening one would leave an account with a
   * lead still claiming to be chasing it. */
  it('404s a lead that has already been converted', async () => {
    updateMatches = false;

    await expect(
      leadService.update(ID, { status: 'contacted', ownerName: '', note: '' }, OFFICE),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('proposals (Matt, 5:53)', () => {
  it('hands back somewhere to put the PDF', async () => {
    const result = await leadService.attach(
      ID,
      { fileName: 'Proposal.pdf', contentType: 'application/pdf', sizeBytes: 240_000 },
      OFFICE,
    );

    expect(result.attachmentId).toBe('att1');
    expect(result.upload.uploadUrl).toContain('leads/');
  });

  it('refuses a file type nobody sends a proposal as', async () => {
    await expect(
      leadService.attach(
        ID,
        { fileName: 'x.exe', contentType: 'application/x-msdownload', sizeBytes: 100 },
        OFFICE,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses a file over the cap', async () => {
    await expect(
      leadService.attach(
        ID,
        { fileName: 'huge.pdf', contentType: 'application/pdf', sizeBytes: 40 * 1024 * 1024 },
        OFFICE,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('mints an expiring link when reading the lead back', async () => {
    stored = lead({
      attachments: [
        {
          id: 'att1',
          fileName: 'Proposal.pdf',
          sizeBytes: 1000,
          contentType: 'application/pdf',
          uploadedAt: '2026-09-01T00:00:00.000Z',
          uploadedBy: 'Priya Raman',
          url: null,
        },
      ],
    });

    const result = await leadService.get(ID, OFFICE);

    // A proposal link that lived forever would outlive the reason anybody had
    // for seeing it.
    expect(result.attachments[0]?.url).toContain('leads/x/f.pdf');
  });

  /**
   * ⚠️ The row is written when the upload URL is issued, BEFORE the browser has
   * PUT anything — so a row whose object was never stored is a state the screen
   * has to survive: an abandoned dialog, a dropped connection, a signature the
   * client got wrong.
   *
   * `url: null` is what the shared schema already means by "still in flight",
   * and the screen renders it as plain text. Handing out a link instead would
   * render something that 404s on click, which reads as a broken feature rather
   * than an unfinished upload.
   */
  it('offers no link for a row whose file never arrived', async () => {
    objectExists = false;
    stored = lead({
      attachments: [
        {
          id: 'att1',
          fileName: 'Proposal.pdf',
          sizeBytes: 1000,
          contentType: 'application/pdf',
          uploadedAt: '2026-09-01T00:00:00.000Z',
          uploadedBy: 'Priya Raman',
          url: null,
        },
      ],
    });

    const result = await leadService.get(ID, OFFICE);

    // Still listed — the office needs to see that something was started, and
    // needs the Remove button to clear it.
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.url).toBeNull();
  });

  it('accepts the Word documents a proposal actually gets written in', async () => {
    const result = await leadService.attach(
      ID,
      {
        fileName: 'Proposal.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sizeBytes: 90_000,
      },
      OFFICE,
    );

    /*
     * ⚠️ `.docx`, not `.bin`. The type is in the lead's allow-list, so it must
     * also be in storage's extension map — a missing entry builds a `.bin` key,
     * and a key with no recognised extension reads back with no content type at
     * all, which makes the browser download a nameless file.
     */
    expect(result.upload.key).toMatch(/\.docx$/);
  });
});

describe('converting a lead (A.4)', () => {
  it('creates the account with everything the wizard chose', async () => {
    const result = await leadService.convert(ID, conversion(), OPERATIONS);

    expect(result).toMatchObject({ accountId: 'acc-new', customerCode: 'NEW001' });
    expect(accountsCreated[0]).toMatchObject({
      code: 'NEW001',
      name: 'Newlands Constructions Pty Ltd',
      abn: '12345678901',
      rateCardId: 'default',
      poPolicy: 'required-before-invoice',
      paymentTermsDays: 7,
    });
  });

  /*
   * ── Why the account type gets its own test ────────────────────────────────
   * It used to be hardcoded to `builder` here, so a contractor converted
   * through this queue landed on the wrong journey: site supervisors they never
   * use, and a short booking form that omits the area and bag count — the only
   * figures a contractor can actually supply. The value must come from the
   * form, both ways, or the bug returns silently.
   */
  it('creates a contractor as a contractor, not a builder', async () => {
    await leadService.convert(ID, conversion({ accountType: 'contractor' }), OPERATIONS);

    expect(accountsCreated[0]?.accountType).toBe('contractor');
  });

  it('creates a builder as a builder', async () => {
    await leadService.convert(ID, conversion({ accountType: 'builder' }), OPERATIONS);

    expect(accountsCreated[0]?.accountType).toBe('builder');
  });

  /* Otherwise the first thing the office does with a new account is retype
   * what the lead already had. */
  it('carries the lead’s contact onto the account', async () => {
    await leadService.convert(ID, conversion(), OPERATIONS);

    expect(accountsCreated[0]?.contact).toMatchObject({
      name: 'Sam Farrar',
      email: 'sam@newlands.com.au',
    });
  });

  it('marks the lead converted and notes it in the thread', async () => {
    await leadService.convert(ID, conversion(), OPERATIONS);

    expect(markedConverted).toEqual([ID]);
    expect(notes[0]?.body).toContain('NEW001');
  });

  it('refuses a lead that is already converted', async () => {
    stored = lead({ convertedAccountId: 'acc-existing' });

    await expect(leadService.convert(ID, conversion(), OPERATIONS)).rejects.toMatchObject({
      status: 409,
    });
    expect(accountsCreated).toHaveLength(0);
  });

  it('refuses a customer code somebody else has, and offers a free one', async () => {
    codeTaken = true;
    nextFreeCode = 'NEW002';

    /*
     * The suggestion is the point of the refusal. "Choose a code that is not
     * already taken" asks the office to guess against a list only the server
     * can see; naming the next free code answers it.
     */
    await expect(leadService.convert(ID, conversion(), OPERATIONS)).rejects.toMatchObject({
      status: 409,
      issues: [
        { path: 'customerCode', message: 'NEW002 is free — use that, or type another code.' },
      ],
    });
    expect(accountsCreated).toHaveLength(0);
  });

  /*
   * ⚠️ Two people finishing the wizard together. The loser is told, loudly —
   * the account already exists by then, so a silent success would leave two
   * accounts for one builder with only one of them invoiced.
   */
  it('conflicts when another user converted it mid-flow', async () => {
    convertMatches = false;

    await expect(leadService.convert(ID, conversion(), OPERATIONS)).rejects.toMatchObject({
      status: 409,
    });
  });

  /* Converting sets the rate card and the terms — a commercial decision. */
  it('refuses office staff without operations', async () => {
    await expect(leadService.convert(ID, conversion(), OFFICE)).rejects.toMatchObject({
      status: 403,
    });
    expect(accountsCreated).toHaveLength(0);
  });
});
