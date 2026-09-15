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
  recipient: { email: string | null; mobile: string | null };
}

let sent: SendRequest[] = [];
let contacts: Array<{ role: string; email: string | null; mobile: string | null }> = [];

vi.mock('../src/domains/notifications/outbound.service.js', () => ({
  outboundService: {
    send: (request: SendRequest) => {
      sent.push(request);
      return Promise.resolve({ outcome: 'sent', channel: 'email', toMasked: null, detail: null });
    },
  },
}));

vi.mock('../src/domains/notifications/notification.service.js', () => ({
  notificationService: { notifyAccount: () => Promise.resolve() },
}));

vi.mock('../src/domains/accounts/account.repository.js', () => ({
  accountRepository: {
    findById: () => Promise.resolve({ id: 'acc1', contacts }),
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
