import type { Role } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const { invoiceService } = await import('../src/domains/invoices/invoice.service.js');

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

beforeEach(() => {
  invoices = createFakeInvoiceRepository();
  settings = createFakeSettingsRepository();
  charges = [...BASE_CHARGES];
  invoiceStatusWrites = [];
  ACCOUNT.poPolicy = 'required-before-invoice';
  JOB.status = 'completed';
  JOB.poNumber = 'PO-88213';
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
    const second = await invoiceService.generateForJob(JOB.id, OFFICE);

    expect(second).toHaveLength(0);
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
  it('re-queues a failed push', async () => {
    const failed = invoices.seed({ status: 'sent', xeroState: 'failed' });

    await invoiceService.retryXero(failed.id, OFFICE);

    // `unknown` while in flight, which is honest: we have asked and do not yet
    // know. Their current list genuinely shows this state.
    expect(invoices.all[0]?.xeroState).toBe('unknown');
    expect(invoices.all[0]?.xeroMessage).toBeNull();
  });

  it('refuses to push an invoice that has not been sent', async () => {
    const draft = invoices.seed({ status: 'draft' });

    await expect(invoiceService.retryXero(draft.id, OFFICE)).rejects.toMatchObject({ status: 409 });
  });
});
