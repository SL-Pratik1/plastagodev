import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who a customer notice actually reaches.
 *
 * ⚠️ `recipientFor` used to return the job's own site contact and nothing else,
 * so a job booked without one sent NOTHING — recorded as
 * `skipped: no email or mobile on file`, in a log nobody reads. It was not an
 * edge case: no booking form could set a site contact, so in practice every
 * pickup booked through the product told the customer nothing while the account
 * sat there with contacts on file.
 */

interface SendRequest {
  event: string;
  recipient: {
    email: string | null;
    mobile: string | null;
    notifyByEmail?: boolean;
    notifyBySms?: boolean;
  };
}

let sent: SendRequest[] = [];
let contacts: Array<{
  role: string;
  email: string | null;
  mobile: string | null;
  notifyByEmail?: boolean;
  notifyBySms?: boolean;
}> = [];

vi.mock('../src/domains/notifications/outbound.service.js', () => ({
  outboundService: {
    send: (request: SendRequest) => {
      sent.push(request);
      return Promise.resolve({ outcome: 'sent', channel: 'email', toMasked: null, detail: null });
    },
  },
}));

/** Who each portal notice was raised for. Asserted in the last describe. */
let audiences: Array<{ accountId: string; bookedByUserId: string | null; title: string }> = [];

vi.mock('../src/domains/notifications/notification.service.js', () => ({
  notificationService: {
    notifyJobAudience: (input: { accountId: string; bookedByUserId: string | null; title: string }) => {
      audiences.push(input);
      return Promise.resolve([]);
    },
  },
}));

/** Set to make the account read fail, as a database hiccup would. */
let accountReadFails = false;

vi.mock('../src/domains/accounts/account.repository.js', () => ({
  accountRepository: {
    findById: () =>
      accountReadFails
        ? Promise.reject(new Error('database unavailable'))
        : Promise.resolve({ id: 'acc1', contacts }),
  },
}));

vi.mock('../src/domains/jobs/job.repository.js', () => ({
  jobRepository: { findById: () => Promise.resolve(null) },
}));

const { jobNotices } = await import('../src/domains/notifications/job-notices.service.js');

const job = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'job1',
  jobNumber: 61489,
  siteName: 'Lot 9 Example Rise',
  accountId: 'acc1',
  accountName: 'Allcastle Homes',
  targetDate: '2026-09-24',
  siteContactEmail: null,
  siteContactMobile: null,
  ...over,
}) as Parameters<typeof jobNotices.booked>[0];

beforeEach(() => {
  sent = [];
  audiences = [];
  accountReadFails = false;
  contacts = [
    { role: 'accounts', email: 'accounts@allcastle.com.au', mobile: null },
    { role: 'site', email: 'site@allcastle.com.au', mobile: '0430942011' },
  ];
});

describe('who a pickup notice reaches', () => {
  it("uses the job's own site contact when it has one", async () => {
    await jobNotices.booked(job({ siteContactEmail: 'boss@thissite.com.au' }));

    expect(sent[0]?.recipient).toEqual({ email: 'boss@thissite.com.au', mobile: null });
  });

  /* The whole point of the fix: no site contact must not mean nobody. */
  it("falls back to the account's SITE contact when the job has none", async () => {
    await jobNotices.booked(job());

    expect(sent[0]?.recipient).toEqual({
      email: 'site@allcastle.com.au',
      mobile: '0430942011',
    });
  });

  /* Operational news goes to whoever is on site, not to whoever pays. */
  it('prefers the site contact over the accounts contact', async () => {
    await jobNotices.booked(job());

    expect(sent[0]?.recipient.email).not.toBe('accounts@allcastle.com.au');
  });

  it('falls back to any reachable contact when there is no site one', async () => {
    contacts = [{ role: 'accounts', email: 'accounts@allcastle.com.au', mobile: null }];

    await jobNotices.booked(job());

    expect(sent[0]?.recipient.email).toBe('accounts@allcastle.com.au');
  });

  /* Nothing reachable is still a real answer — it must not throw. */
  it('sends to nobody, quietly, when the account has no contacts at all', async () => {
    contacts = [];

    await expect(jobNotices.booked(job())).resolves.toBeUndefined();
    expect(sent[0]?.recipient).toEqual({ email: null, mobile: null });
  });
});

/*
 * M8.4 — the switches on the portal's Account page.
 *
 * ⚠️ They were dropped on the way to the send, so a customer who switched
 * email off kept receiving every pickup email while the page promised
 * "notifications will follow these settings".
 */
describe("a contact's notification switches", () => {
  it('carries them with the fallback contact, so "off" is honoured', async () => {
    contacts = [
      {
        role: 'accounts',
        email: 'accounts@allcastle.com.au',
        mobile: null,
        notifyByEmail: false,
        notifyBySms: false,
      },
    ];

    await jobNotices.booked(job());

    // Returned WITH the switch, so the send log says "turned off".
    expect(sent[0]?.recipient).toMatchObject({
      email: 'accounts@allcastle.com.au',
      notifyByEmail: false,
    });
  });

  it('passes over a contact who switched everything off for one who did not', async () => {
    contacts = [
      { role: 'site', email: 'quiet@allcastle.com.au', mobile: null, notifyByEmail: false, notifyBySms: false },
      { role: 'accounts', email: 'accounts@allcastle.com.au', mobile: null, notifyByEmail: true, notifyBySms: false },
    ];

    await jobNotices.booked(job());

    expect(sent[0]?.recipient.email).toBe('accounts@allcastle.com.au');
  });

  it("applies a contact's email switch when the job names the same address", async () => {
    contacts = [
      { role: 'accounts', email: 'Boss@ThisSite.com.au', mobile: null, notifyByEmail: false, notifyBySms: false },
    ];

    await jobNotices.booked(job({ siteContactEmail: 'boss@thissite.com.au' }));

    expect(sent[0]?.recipient.notifyByEmail).toBe(false);
  });

  /*
   * ⚠️ Per address. Every accounts contact is created with SMS off and no
   * mobile; that must not silence a site mobile typed onto the job.
   */
  it('does not let an SMS switch silence a mobile the contact never gave', async () => {
    contacts = [
      { role: 'accounts', email: 'accounts@allcastle.com.au', mobile: null, notifyByEmail: true, notifyBySms: false },
    ];

    await jobNotices.booked(
      job({ siteContactEmail: 'accounts@allcastle.com.au', siteContactMobile: '0430942011' }),
    );

    expect(sent[0]?.recipient.notifyBySms).toBeUndefined();
  });

  /* The switches are a refinement; losing them must not lose the notice. */
  it('still tells the site when the contact switches cannot be read', async () => {
    accountReadFails = true;

    await jobNotices.booked(job({ siteContactMobile: '0430942011' }));

    expect(sent[0]?.recipient).toEqual({ email: null, mobile: '0430942011' });
  });

  it('matches a mobile however it was typed', async () => {
    contacts = [
      { role: 'site', email: null, mobile: '0430942011', notifyByEmail: false, notifyBySms: false },
    ];

    await jobNotices.booked(job({ siteContactMobile: '+61 430 942 011' }));

    expect(sent[0]?.recipient.notifyBySms).toBe(false);
  });
});

/*
 * Who sees the notice in the PORTAL — separate from who is emailed.
 *
 * ⚠️ These went to every portal user on the account, so every site supervisor
 * was told about every pickup — including ones the portal will not open for
 * them. They now go to the pickup's audience: its administrators and the
 * supervisor who booked it.
 */
describe('who sees a pickup notice in the portal', () => {
  it('names the supervisor who booked it on "Pickup booked"', async () => {
    await jobNotices.booked(job({ bookedByUserId: 'usr0000000000000000000s1' }));

    expect(audiences).toEqual([
      expect.objectContaining({
        accountId: 'acc1',
        bookedByUserId: 'usr0000000000000000000s1',
        title: 'Pickup booked — Lot 9 Example Rise',
      }),
    ]);
  });

  it('names nobody but the administrators on a job the office booked', async () => {
    await jobNotices.booked(job({ bookedByUserId: null }));

    expect(audiences[0]?.bookedByUserId).toBeNull();
  });

  it('does the same for "Ready for tomorrow?"', async () => {
    await jobNotices.readinessReminder({
      ...job({ bookedByUserId: 'usr0000000000000000000s1' }),
      // The run's day — what a reminder is about since it follows the truck.
      runDate: '2026-09-25',
    });

    expect(audiences).toEqual([
      expect.objectContaining({
        bookedByUserId: 'usr0000000000000000000s1',
        title: 'Ready for tomorrow? Lot 9 Example Rise',
      }),
    ]);
  });
});
