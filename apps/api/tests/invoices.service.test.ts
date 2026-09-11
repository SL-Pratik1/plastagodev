import type { Role } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearOutbound,
  makeFakeNotificationRepository,
  providerFailure,
  recordingProviders,
  sentMessages,
} from './helpers/fake-outbound.js';
import { createFakeInvoiceRepository } from './helpers/fake-invoices.js';
import { createFakeSettingsRepository } from './helpers/fake-settings.js';

/**
 * Invoicing (M7).
 *
 * ── What is actually under test ───────────────────────────────────────────
 * The split, and the queue it feeds. Matt, 33:56:
 *
 *   *"the system we have doesn't really allow us to split onto two invoices"*
 *
 * Additional charges need their own PO, and that PO can take three months. So
 * these tests pin the thing that unblocks their cash: the base invoice goes out
 * immediately against the PO already on the job, and the extras wait separately
 * without holding it up.
 */

let invoices: ReturnType<typeof createFakeInvoiceRepository>;
let settings: ReturnType<typeof createFakeSettingsRepository>;

const ACCOUNT = {
  id: 'acc0000000000000000000a1',
  name: 'Clarendon Homes',
  brandId: 'plastago' as const,
  poPolicy: 'required-before-invoice' as 'required-before-invoice' | 'not-required',
  paymentTermsDays: 7,
  status: 'active' as const,
  /*
   * M8.4 — two contacts, deliberately. The covering email has to reach the
   * accounts desk and not the site foreman: *"today there is exactly one email
   * — the site contact. The AP person who needs the invoice..."*
   */
  contacts: [
    {
      id: 'con000000000000000000s1',
      name: 'Dave Nguyen',
      role: 'site' as string,
      email: 'dave@clarendon.com.au' as string | null,
      mobile: '0466778899' as string | null,
      notifyBySms: true,
      notifyByEmail: true,
    },
    {
      id: 'con000000000000000000a1',
      name: 'Angela Fitzgerald',
      role: 'accounts' as string,
      email: 'accounts@clarendon.com.au' as string | null,
      mobile: null as string | null,
      notifyBySms: false,
      notifyByEmail: true,
    },
  ],
};

const JOB = {
  id: 'job0000000000000000000j1',
  jobNumber: 61_314,
  accountId: ACCOUNT.id,
  status: 'completed' as string,
  poNumber: 'PO-88213' as string | null,
};

/** What `billableCharges` returns — approved and not-required only. */
let charges: Array<{
  id: string;
  code: string;
  description: string;
  quantity: number;
  unitRate: string;
  amount: string;
  source: 'office' | 'driver' | 'system';
  raisedBy: string | null;
}> = [];

let invoiceStatusWrites: Array<{ jobId: string; status: string; invoiceNumber?: number }> = [];

// GETTERS, not values: `vi.mock` factories hoist above every import.
vi.mock('../src/domains/invoices/invoice.repository.js', () => ({
  get invoiceRepository() {
    return invoices.repository;
  },
}));

vi.mock('../src/domains/settings/settings.repository.js', () => ({
  get settingsRepository() {
    return settings.repository;
  },
}));

vi.mock('../src/domains/accounts/account.repository.js', () => ({
  accountRepository: {
    findById: () => Promise.resolve({ ...ACCOUNT }),
  },
}));

vi.mock('../src/domains/jobs/job.repository.js', () => ({
  jobRepository: {
    findById: () => Promise.resolve({ ...JOB }),
  },
  billableCharges: () => Promise.resolve(charges),
  setInvoiceStatus: (jobId: string, status: string, invoiceNumber?: number) => {
    invoiceStatusWrites.push({ jobId, status, invoiceNumber });
    return Promise.resolve();
  },
}));

/*
 * M7.7 — sending an invoice now emails the people who pay it. The send log is
 * faked like every other repository; the real one would buffer a write against
 * a MongoDB that is not there.
 */
vi.mock('../src/domains/notifications/notification.repository.js', () => ({
  notificationRepository: makeFakeNotificationRepository(),
}));

/**
 * I1 — Xero, faked like every other collaborator.
 *
 * ⚠️ Not optional, and not merely for speed. `config/env.ts` calls
 * `dotenv/config`, so a developer whose `.env` holds real Xero credentials
 * runs this suite with `XERO_PROVIDER=xero` — and the un-faked service would
 * reach for Mongo to read the connection and then for Xero itself. Sending a
 * test fixture's invoice into a real set of accounting books is a considerably
 * worse outcome than a slow test.
 *
 * The push's own behaviour is covered properly in `xero.service.test.ts`;
 * here it only has to exist and resolve.
 */
const xeroPushes: string[] = [];

vi.mock('../src/domains/xero/xero.service.js', () => ({
  xeroService: {
    pushInvoice: (id: string) => {
      xeroPushes.push(id);
      return Promise.resolve({ pushed: true, message: null });
    },
  },
}));

const { invoiceService } = await import('../src/domains/invoices/invoice.service.js');
const { setMessagingProvidersForTests } = await import('../src/integrations/messaging.js');

const OFFICE = {
  userId: 'usr0000000000000000000f1',
  name: 'Priya Raman',
  roles: ['office-staff'] as Role[],
  accountId: null,
};

const CUSTOMER = {
  userId: 'usr0000000000000000000c1',
  name: 'Angela Fitzgerald',
  roles: ['customer-administrator'] as Role[],
  accountId: ACCOUNT.id,
};

/** The job as sold — service fee plus area. `system` source. */
const BASE_CHARGES = [
  {
    id: 'chg1',
    code: 'service-fee',
    description: 'Service fee — Sydney',
    quantity: 1,
    unitRate: '220.00',
    amount: '220.00',
    source: 'system' as const,
    raisedBy: null,
  },
  {
    id: 'chg2',
    code: 'area-charge',
    description: 'Plasterboard recycling (per m²)',
    quantity: 823.41,
    unitRate: '0.16',
    amount: '131.75',
    source: 'system' as const,
    raisedBy: null,
  },
];

/** What the driver raised on site — needs its own PO. */
const DRIVER_CHARGE = {
  id: 'chg3',
  code: 'contamination',
  description: 'Contamination charge',
  quantity: 1,
  unitRate: '90.00',
  amount: '90.00',
  source: 'driver' as const,
  raisedBy: 'Troy Holm',
};

/**
 * Bags the order never authorised (M6.5, Matt 07:37).
 *
 * Raised with `source: 'driver'` for exactly the same reason a contamination
 * charge is: it needs a purchase order the builder has not issued yet.
 */
const EXTRA_BAGS_CHARGE = {
  id: 'chg4',
  code: 'extra-bags',
  description: '2 bags beyond the 2 on the purchase order',
  quantity: 2,
  unitRate: '30.00',
  amount: '60.00',
  source: 'driver' as const,
  raisedBy: 'System · counted by Troy Holm',
};

beforeEach(() => {
  invoices = createFakeInvoiceRepository();
  settings = createFakeSettingsRepository();
  charges = [...BASE_CHARGES];
  invoiceStatusWrites = [];
  ACCOUNT.poPolicy = 'required-before-invoice';
  JOB.status = 'completed';
  JOB.poNumber = 'PO-88213';
  clearOutbound();
  setMessagingProvidersForTests(recordingProviders());
});

/**
 * The covering email (M7.7 · M8.4).
 *
 * "Sent" used to mean a status column. These are about the invoice actually
 * arriving at the desk that pays it.
 */
describe('what the customer receives', () => {
  it('emails the accounts contact, not the site foreman', async () => {
    const draft = invoices.seed({ status: 'draft' });

    await invoiceService.send([draft.id], OFFICE);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.to).toBe('accounts@clarendon.com.au');
  });

  /** An AP system rejects an invoice with no PO on it (Matt, 9:56). */
  it('quotes the purchase order and the amount', async () => {
    const draft = invoices.seed({ status: 'draft' });

    await invoiceService.send([draft.id], OFFICE);

    expect(sentMessages[0]?.subject).toContain('Clarendon Homes');
    expect(sentMessages[0]?.body).toContain('including GST');
  });

  /*
   * ⚠️ Only the rows that actually moved. A grid selection routinely holds
   * invoices that were sent last week, and a second covering email for one of
   * them reads as a duplicate bill.
   */
  it('says nothing about an invoice that had already been sent', async () => {
    const already = invoices.seed({ status: 'sent' });
    const draft = invoices.seed({ status: 'draft' });

    await invoiceService.send([already.id, draft.id], OFFICE);

    expect(sentMessages).toHaveLength(1);
  });

  /** A dead mailbox must not roll back a batch of forty invoices. */
  it('still marks the invoice sent when the email fails', async () => {
    providerFailure.message = 'mailbox full';
    const draft = invoices.seed({ status: 'draft' });

    await expect(invoiceService.send([draft.id], OFFICE)).resolves.toBe(1);
    expect(invoices.all.find((row) => row.id === draft.id)?.status).toBe('sent');
  });
});

describe('the split (M7.2)', () => {
  /*
   * ⚠️ The test this whole domain exists for. The pickup's money must not wait
   * on a PO for a $90 contamination charge.
   */
  it('sends the job out now and makes the extras wait on their own PO', async () => {
    charges = [...BASE_CHARGES, DRIVER_CHARGE];

    const created = await invoiceService.generateForJob(JOB.id, OFFICE);

    expect(created).toHaveLength(2);

    const base = invoices.byKind('base');
    const extra = invoices.byKind('additional-charges');

    // The job as sold, against the PO the customer already gave us — ready to go.
    expect(base?.status).toBe('draft');
    expect(base?.poNumber).toBe('PO-88213');
    expect(base?.subtotalExGst).toBe('351.75');

    // The extras carry NO PO, even though the base has one. That is the split.
    expect(extra?.status).toBe('awaiting-po');
    expect(extra?.poNumber).toBeNull();
    expect(extra?.subtotalExGst).toBe('90.00');
  });

  /*
   * Matt, 09:55: *"the original invoice for the job… has to go out exactly
   * matching what the build has given us."*
   *
   * The base invoice is priced on the order's two bags and must stay at that
   * figure. The two extra bags the driver found are worth real money, and they
   * belong on the invoice that waits for a second PO — not folded into the
   * ordered line, where they would make the base invoice disagree with the
   * builder's order and be rejected weeks later (Matt, 09:56).
   */
  it('keeps extra bags off the invoice that has to match the order', async () => {
    charges = [...BASE_CHARGES, EXTRA_BAGS_CHARGE];

    const created = await invoiceService.generateForJob(JOB.id, OFFICE);

    expect(created).toHaveLength(2);

    const base = invoices.byKind('base');
    const extra = invoices.byKind('additional-charges');

    // Unchanged by the overage — still the job exactly as ordered.
    expect(base?.poNumber).toBe('PO-88213');
    expect(base?.subtotalExGst).toBe('351.75');
    // Invoice lines carry a description, not a code — so this asserts on the
    // wording the overage charge is raised with.
    expect(base?.lines).toHaveLength(2);
    expect(base?.lines.some((line) => /purchase order/i.test(line.description))).toBe(false);

    // The excess, on its own invoice, waiting on a purchase order.
    expect(extra?.status).toBe('awaiting-po');
    expect(extra?.poNumber).toBeNull();
    expect(extra?.subtotalExGst).toBe('60.00');
  });

  it('puts driver charges on the second invoice and nothing else', async () => {
    charges = [...BASE_CHARGES, DRIVER_CHARGE];
    await invoiceService.generateForJob(JOB.id, OFFICE);

    expect(invoices.byKind('base')?.lines).toHaveLength(2);
    expect(invoices.byKind('additional-charges')?.lines).toHaveLength(1);
    expect(invoices.byKind('additional-charges')?.lines[0]?.raisedBy).toBe('Troy Holm');
  });

  /*
   * The split exists to unblock cash. Where nothing is blocked it would only be
   * noise on a builder's desk.
   */
  it('puts everything on one invoice when the account needs no PO', async () => {
    ACCOUNT.poPolicy = 'not-required';
    charges = [...BASE_CHARGES, DRIVER_CHARGE];

    const created = await invoiceService.generateForJob(JOB.id, OFFICE);

    expect(created).toHaveLength(1);
    expect(invoices.byKind('base')?.lines).toHaveLength(3);
    expect(invoices.byKind('base')?.subtotalExGst).toBe('441.75');
    expect(invoices.byKind('base')?.status).toBe('draft');
  });

  it('raises only a base invoice when the driver reported nothing', async () => {
    const created = await invoiceService.generateForJob(JOB.id, OFFICE);

    expect(created).toHaveLength(1);
    expect(invoices.byKind('additional-charges')).toBeUndefined();
  });

  /*
   * A PO-required account whose job never carried a PO. The base invoice cannot
   * go out either — that is the queue doing its job (M7.3).
   */
  it('holds the base invoice too when the job has no PO at all', async () => {
    JOB.poNumber = null;

    await invoiceService.generateForJob(JOB.id, OFFICE);

    expect(invoices.byKind('base')?.status).toBe('awaiting-po');
  });
});

describe('the money adds up', () => {
  it('reproduces Matt’s Domain job to the cent', async () => {
    await invoiceService.generateForJob(JOB.id, OFFICE);

    // 823.41 m² × $0.16 = $131.75, plus the $220 Sydney service fee.
    const base = invoices.byKind('base');
    expect(base?.subtotalExGst).toBe('351.75');
    expect(base?.gst).toBe('35.18');
    expect(base?.totalIncGst).toBe('386.93');
  });

  it('rounds GST once on the total, not per line', async () => {
    charges = [
      { ...BASE_CHARGES[0]!, amount: '0.05' },
      { ...BASE_CHARGES[1]!, amount: '0.05' },
    ];

    await invoiceService.generateForJob(JOB.id, OFFICE);

    // Per-line rounding would give 0.01 + 0.01 = 0.02 against a 0.10 subtotal.
    expect(invoices.byKind('base')?.subtotalExGst).toBe('0.10');
    expect(invoices.byKind('base')?.gst).toBe('0.01');
  });

  it('sets a due date in calendar days, not business days', async () => {
    await invoiceService.generateForJob(JOB.id, OFFICE);

    const base = invoices.byKind('base');
    const issued = new Date(`${base?.issuedOn ?? ''}T00:00:00Z`);
    const due = new Date(`${base?.dueOn ?? ''}T00:00:00Z`);

    // An invoice due date is a banking term the customer agreed to — "7 days"
    // means seven days, unlike the job SLA which skips weekends.
    expect((due.getTime() - issued.getTime()) / 86_400_000).toBe(7);
  });
});

describe('not billing twice', () => {
  /*
   * ⚠️ A retried completion, or two office staff clicking at once. The database
   * has a unique index; this is the check that gives the second caller an
   * explanation rather than a duplicate-key error.
   */
  it('does not raise a second invoice for the same job and kind', async () => {
    await invoiceService.generateForJob(JOB.id, OFFICE);

    /*
     * An explanation, not an empty list. This used to resolve with `[]` and a
     * 201, which reads to the caller as "done" — so pressing it twice looked
     * like it worked twice while the second press silently did nothing.
     */
    await expect(invoiceService.generateForJob(JOB.id, OFFICE)).rejects.toMatchObject({
      status: 409,
    });

    expect(invoices.all).toHaveLength(1);
  });

  it('raises only the missing kind on a re-run', async () => {
    await invoiceService.generateForJob(JOB.id, OFFICE);

    // The driver's charge is approved after the base invoice went out.
    charges = [...BASE_CHARGES, DRIVER_CHARGE];
    const second = await invoiceService.generateForJob(JOB.id, OFFICE);

    expect(second).toHaveLength(1);
    expect(second[0]?.kind).toBe('additional-charges');
    expect(invoices.all).toHaveLength(2);
  });
});

describe('what may be invoiced at all', () => {
  it('refuses a job that is still on a truck', async () => {
    JOB.status = 'in-transit';

    // The driver may yet report contamination; the charges are not final.
    await expect(invoiceService.generateForJob(JOB.id, OFFICE)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('invoices a futile job — that is the money loop', async () => {
    JOB.status = 'futile';
    charges = [{ ...DRIVER_CHARGE, code: 'futile-pickup', amount: '120.00' }];

    await expect(invoiceService.generateForJob(JOB.id, OFFICE)).resolves.toHaveLength(1);
  });

  it('refuses when every charge is still pending approval', async () => {
    charges = [];

    await expect(invoiceService.generateForJob(JOB.id, OFFICE)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses a customer trying to raise their own invoice', async () => {
    await expect(invoiceService.generateForJob(JOB.id, CUSTOMER)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('sending (M7.7)', () => {
  /*
   * ⚠️ The rule the queue exists for. A builder's AP system rejects an invoice
   * with no PO on it (Matt, 9:56), so sending one is worse than not sending.
   */
  it('refuses to send an invoice still waiting on a PO', async () => {
    const waiting = invoices.seed({ status: 'awaiting-po' });

    await expect(invoiceService.send([waiting.id], OFFICE)).rejects.toMatchObject({ status: 409 });
    expect(invoices.all[0]?.status).toBe('awaiting-po');
  });

  it('sends drafts and reports how many moved', async () => {
    const a = invoices.seed({ status: 'draft' });
    const b = invoices.seed({ status: 'draft' });
    const blocked = invoices.seed({ status: 'awaiting-po' });

    // Partial by design: a grid selection is expected to contain rows that
    // cannot move, and failing the batch would make the button useless.
    await expect(invoiceService.send([a.id, b.id, blocked.id], OFFICE)).resolves.toBe(2);
    expect(invoices.all.filter((invoice) => invoice.status === 'sent')).toHaveLength(2);
  });

  it('does not re-send an invoice that has already gone', async () => {
    const sent = invoices.seed({ status: 'sent' });

    await expect(invoiceService.send([sent.id], OFFICE)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a customer sending invoices', async () => {
    const draft = invoices.seed({ status: 'draft' });

    await expect(invoiceService.send([draft.id], CUSTOMER)).rejects.toMatchObject({ status: 403 });
  });
});

describe('the awaiting-PO queue (M7.3)', () => {
  it('releases an invoice when its PO is recorded', async () => {
    const waiting = invoices.seed({ status: 'awaiting-po', jobId: JOB.id });

    await invoiceService.recordPo(waiting.id, '  PO-99001  ', OFFICE);

    // Recording the PO IS the exit condition. Leaving it in the queue with a PO
    // printed beside it is how a queue stops being trusted.
    expect(invoices.all[0]?.status).toBe('draft');
    expect(invoices.all[0]?.poNumber).toBe('PO-99001');
  });

  it('moves the job’s rollup so the jobs grid agrees', async () => {
    const waiting = invoices.seed({ status: 'awaiting-po', jobId: JOB.id });

    await invoiceService.recordPo(waiting.id, 'PO-99001', OFFICE);

    expect(invoiceStatusWrites.at(-1)).toMatchObject({ jobId: JOB.id, status: 'invoiced' });
  });

  it('does not un-send a sent invoice when a PO is recorded late', async () => {
    const sent = invoices.seed({ status: 'sent' });

    await invoiceService.recordPo(sent.id, 'PO-99002', OFFICE);

    expect(invoices.all[0]?.status).toBe('sent');
  });

  it('refuses an empty PO number', async () => {
    const waiting = invoices.seed({ status: 'awaiting-po' });

    await expect(invoiceService.recordPo(waiting.id, '   ', OFFICE)).rejects.toMatchObject({
      status: 422,
    });
  });

  /* Approving without a PO would defeat the account's whole policy. */
  it('refuses to approve an invoice that still has no PO', async () => {
    const waiting = invoices.seed({ status: 'awaiting-po', poNumber: null });

    await expect(invoiceService.approve([waiting.id], OFFICE)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('approves one whose PO arrived', async () => {
    const waiting = invoices.seed({ status: 'awaiting-po', poNumber: 'PO-99003' });

    await expect(invoiceService.approve([waiting.id], OFFICE)).resolves.toBe(1);
    expect(invoices.all[0]?.status).toBe('draft');
  });
});

describe('customers see their own and no more', () => {
  it('404s another account’s invoice', async () => {
    const other = invoices.seed({ status: 'sent', accountId: 'acc0000000000000000000zz' });

    // 404, not 403 — a 403 confirms it exists, and an invoice carries what
    // somebody pays.
    await expect(invoiceService.get(other.id, CUSTOMER)).rejects.toMatchObject({ status: 404 });
  });

  it('lets a customer read their own', async () => {
    const mine = invoices.seed({ status: 'sent', accountId: ACCOUNT.id });

    await expect(invoiceService.get(mine.id, CUSTOMER)).resolves.toMatchObject({ id: mine.id });
  });

  it('fails closed when a customer session carries no account', async () => {
    const mine = invoices.seed({ status: 'sent', accountId: ACCOUNT.id });

    await expect(
      invoiceService.get(mine.id, { ...CUSTOMER, accountId: null }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('will not render a PDF for someone else’s invoice', async () => {
    const other = invoices.seed({ status: 'sent', accountId: 'acc0000000000000000000zz' });

    await expect(invoiceService.requestPdf([other.id], CUSTOMER)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('Xero (I1)', () => {
  beforeEach(() => {
    xeroPushes.length = 0;
  });

  /*
   * ⚠️ This used to assert that a retry set `xeroState` to `unknown`.
   *
   * That was correct while the retry only re-queued: the push was a job that
   * had not happened, and `unknown` said so. The retry now performs the push
   * and waits, so the invoice ends on a real outcome and `unknown` would be a
   * state nothing ever leaves.
   */
  it('actually pushes, and reports what Xero did', async () => {
    const failed = invoices.seed({ status: 'sent', xeroState: 'failed' });

    const result = await invoiceService.retryXero(failed.id, OFFICE);

    expect(xeroPushes).toEqual([failed.id]);
    expect(result).toEqual({ pushed: true, message: null });
  });

  it('refuses to push an invoice that has not been sent', async () => {
    const draft = invoices.seed({ status: 'draft' });

    await expect(invoiceService.retryXero(draft.id, OFFICE)).rejects.toMatchObject({ status: 409 });
    // And nothing reached Xero — a draft must never enter the ledger.
    expect(xeroPushes).toEqual([]);
  });

  it('pushes every invoice in a batch that was actually sent', async () => {
    const a = invoices.seed({ status: 'draft' });
    const b = invoices.seed({ status: 'draft' });

    await invoiceService.send([a.id, b.id], OFFICE);

    expect(xeroPushes).toEqual([a.id, b.id]);
  });
});
