import { describe, expect, it } from 'vitest';

const messages = await import('../src/integrations/notice-messages.js');

/**
 * Which emails ask for a reply, and so go from accounts@ (Matthew, 30/09/2026).
 *
 * Set by the builder rather than the caller, so this is where it is pinned: a
 * new path that sends an invoice gets the right mailbox for free.
 */
describe('the sending mailbox each email asks for', () => {
  it('sends the invoice from accounts@', () => {
    const email = messages.buildInvoiceEmail('ap@clarendon.com.au', {
      accountName: 'Clarendon Homes',
      invoiceNumber: 'PGA-104312',
      totalIncGst: '1,250.00',
      dueOn: '2026-11-05',
      paymentTermsDays: 30,
      jobNumber: 61_473,
      poNumber: 'PO-7990',
    });

    expect(email.mailbox).toBe('accounts');
    expect(email.subject).toBe('Invoice PGA-104312 — Clarendon Homes — $1,250.00');
  });

  it('sends the purchase-order request from accounts@', () => {
    const email = messages.buildPoRequestEmail('ap@clarendon.com.au', {
      accountName: 'Clarendon Homes',
      invoiceNumber: 'PGA-104312',
      totalIncGst: '132.00',
      chargeSummary: 'Contamination — timber offcuts',
      jobNumber: 61_473,
      siteName: 'Lot 9 Example Rise',
    });

    expect(email.mailbox).toBe('accounts');
  });

  /* Everything else stays on noreply@ — the default, so no mailbox at all. */
  it('leaves job updates on the default mailbox', () => {
    const email = messages.buildJobBookedEmail('site@clarendon.com.au', {
      jobNumber: 61_473,
      siteName: 'Lot 9 Example Rise',
      when: 'Thu, 1 Oct',
      readyFrom: 'Thu, 24 Sept',
      accountName: 'Clarendon Homes',
    });

    expect(email.mailbox).toBeUndefined();
  });
});
