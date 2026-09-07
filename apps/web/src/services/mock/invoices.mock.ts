import type { Invoice, InvoiceLine, InvoiceListItem } from '@plastago/shared';
import { ServiceError } from '../service-error';
import type { InvoiceService } from '../types';
import { applyListQuery, byDate, byNumber, byText } from './list-query';
import { objectId } from './fixtures/reference';
import { latency } from './mock-transport';
import { findJob, invoiceList, store } from './store';

/**
 * Invoicing (M7).
 *
 * ── Overrides layered over derived invoices ────────────────────────────────
 * Invoices are projected from jobs (see `store.ts`) because that is what they
 * are: one invoice per job on completion. But sending one, or recording the PO
 * that releases it, has to persist — so those changes live in a small override
 * map keyed by invoice id, applied on read.
 *
 * The alternative would be materialising invoices into their own array, which
 * then has to be kept in step with the jobs it came from. Overriding a derived
 * view is less code and cannot drift.
 */
/**
 * The override map lives in `store.ts`, not here.
 *
 * Two domains read it: the invoice list and the awaiting-PO queue are the same
 * fact seen from two places (M7.3). While the map was private to this file,
 * recording a PO updated the invoice and left the queue row untouched — the
 * shared store exists precisely to make that impossible.
 *
 * `invoiceList()` already applies the overrides, so this is now just a name.
 */
const overrides = store.invoiceOverrides;

function currentList(): InvoiceListItem[] {
  return invoiceList();
}

/**
 * Xero state, derived from the invoice's own state unless overridden.
 *
 * `unknown` is seeded for a slice of paid invoices on purpose: their current
 * list genuinely shows payment status "Unknown" for several customers because
 * the sync only partly works today. Showing it is what makes fixing it visible.
 */
function xeroStateFor(invoice: InvoiceListItem): Invoice['xeroState'] {
  const override = overrides.get(invoice.id)?.xeroState;
  if (override) return override;
  if (invoice.status === 'draft' || invoice.status === 'awaiting-po') return 'not-synced';
  // Deterministic from the invoice number so it never changes between reads.
  if (invoice.invoiceNumber % 17 === 0) return 'failed';
  if (invoice.invoiceNumber % 11 === 0) return 'unknown';
  return 'synced';
}

function toDetail(invoice: InvoiceListItem): Invoice {
  const job = invoice.jobId === null ? undefined : findJob(invoice.jobId);
  const override = overrides.get(invoice.id);

  // Base invoices carry the office-raised lines; the additional-charges invoice
  // carries only what a driver or the system raised (M7.2).
  const charges = (job?.charges ?? []).filter((charge) =>
    invoice.kind === 'base' ? charge.source === 'office' : charge.source !== 'office',
  );

  const lines: InvoiceLine[] = charges.map((charge) => ({
    id: charge.id,
    description: charge.description,
    quantity: charge.quantity,
    unitRate: charge.unitRate,
    amount: charge.amount,
    raisedBy: charge.source === 'office' ? null : (charge.raisedBy ?? 'System'),
  }));

  // A derived invoice with no charge rows still needs a line, or the detail
  // page would show a total with nothing above it.
  if (lines.length === 0) {
    lines.push({
      id: objectId('il', invoice.invoiceNumber),
      description: invoice.kind === 'base' ? 'Recycling service' : 'Additional charges',
      quantity: 1,
      unitRate: invoice.subtotalExGst,
      amount: invoice.subtotalExGst,
      raisedBy: null,
    });
  }

  const captureWeight = job?.recoveredWeightKg !== null && job?.recoveredWeightKg !== undefined;
  const xeroState = xeroStateFor(invoice);

  return {
    ...invoice,
    lines,
    // M7.4 — the template resolves from the account's capture configuration.
    templateName:
      invoice.brandId === 'easylift'
        ? captureWeight
          ? 'EasyLift Recycling Invoice (kg & m²)'
          : 'EasyLift Recycling Invoice (m²)'
        : captureWeight
          ? 'PlastaGo Recycling Invoice (kg & m²)'
          : 'PlastaGo Recycling Invoice (m² only)',
    sentAt: override?.sentAt ?? (invoice.status === 'draft' ? null : invoice.issuedOn),
    xeroState,
    xeroLastSyncAt:
      override?.xeroLastSyncAt ?? (xeroState === 'not-synced' ? null : invoice.issuedOn),
    xeroMessage:
      override?.xeroMessage ??
      (xeroState === 'failed'
        ? 'Xero rejected the contact: no matching account code. Check the account’s Xero mapping.'
        : xeroState === 'unknown'
          ? 'Xero has not reported a payment status for this invoice.'
          : null),
    paymentTermsDays: 7,
    notes: '',
  };
}

export function createMockInvoiceService(): InvoiceService {
  return {
    async list(query) {
      await latency();

      return applyListQuery(currentList(), query, {
        search: (invoice) => [
          invoice.invoiceNumber,
          invoice.accountName,
          invoice.poNumber,
          invoice.poNumber,
          invoice.jobNumber,
        ],
        filters: {
          account: (invoice, value) => invoice.accountId === value,
          status: (invoice, value) => invoice.status === value,
          kind: (invoice, value) => invoice.kind === value,
          // Payment status is a different question from invoice state: "has it
          // been paid" versus "where is it in the workflow".
          payment: (invoice, value) =>
            value === 'paid'
              ? invoice.status === 'paid'
              : value === 'outstanding'
                ? invoice.status === 'sent' || invoice.status === 'overdue'
                : value === 'overdue'
                  ? invoice.status === 'overdue'
                  : invoice.status === 'unknown',
          issuedWindow: (invoice, value) => matchesWindow(invoice.issuedOn, value),
        },
        sorters: {
          invoiceNumber: byNumber((invoice) => invoice.invoiceNumber),
          accountName: byText((invoice) => invoice.accountName),
          status: byText((invoice) => invoice.status),
          issuedOn: byDate((invoice) => invoice.issuedOn),
          dueOn: byDate((invoice) => invoice.dueOn),
          totalIncGst: byNumber((invoice) => Number(invoice.totalIncGst)),
        },
        defaultSort: (a, b) => b.invoiceNumber - a.invoiceNumber,
      });
    },

    async get(id) {
      await latency();
      const invoice = currentList().find((candidate) => candidate.id === id);
      if (!invoice) throw new ServiceError('NOT_FOUND', `No invoice ${id}`);
      return toDetail(invoice);
    },

    async send(ids) {
      await latency(520, 240);

      let changed = 0;
      for (const id of ids) {
        const invoice = currentList().find((candidate) => candidate.id === id);
        if (!invoice) continue;
        // An invoice still waiting on a PO must not go out — that is the whole
        // point of the awaiting-PO queue (M7.3).
        if (invoice.status === 'awaiting-po') continue;
        if (invoice.status !== 'draft' && invoice.status !== 'unknown') continue;

        overrides.set(id, {
          ...overrides.get(id),
          status: 'sent',
          sentAt: new Date().toISOString(),
          xeroState: 'synced',
          xeroLastSyncAt: new Date().toISOString(),
        });
        changed += 1;
      }

      if (changed === 0) {
        throw new ServiceError('CONFLICT', 'None of the selected invoices could be sent');
      }
      return changed;
    },

    async approve(ids) {
      await latency(520, 240);

      let changed = 0;
      for (const id of ids) {
        const invoice = currentList().find((candidate) => candidate.id === id);
        if (!invoice || invoice.status !== 'awaiting-po') continue;
        // Approving without a PO would defeat the account's PO policy.
        if (!invoice.poNumber) continue;
        overrides.set(id, { ...overrides.get(id), status: 'draft' });
        changed += 1;
      }

      if (changed === 0) {
        throw new ServiceError(
          'CONFLICT',
          'These invoices still need a purchase order before they can be approved',
        );
      }
      return changed;
    },

    async recordPo(id, poNumber) {
      await latency(420, 200);
      const invoice = currentList().find((candidate) => candidate.id === id);
      if (!invoice) throw new ServiceError('NOT_FOUND', `No invoice ${id}`);
      if (!poNumber.trim()) {
        throw new ServiceError('VALIDATION_FAILED', 'A purchase order number is required', {
          fieldErrors: { poNumber: 'Enter the purchase order number the customer issued' },
        });
      }
      /*
       * ── Recording the PO also RELEASES the invoice ───────────────────────
       * M7.3's queue is "approved charges awaiting a PO", so the PO arriving is
       * the whole exit condition: the status moves off `awaiting-po` and the row
       * leaves the queue. Storing the number without moving the status would
       * leave it sitting there with a PO printed beside it, which is how a queue
       * stops being trusted.
       *
       * `draft` and not `sent`: the PO unblocks the invoice, it does not post
       * it. Sending is still a deliberate act from the invoice list (M7.7).
       */
      store.invoiceOverrides.set(id, {
        ...store.invoiceOverrides.get(id),
        poNumber: poNumber.trim(),
        status: 'draft',
      });

      // The job's rollup badge follows, so the jobs grid agrees with the queue.
      if (invoice.jobId !== null) {
        store.jobs = store.jobs.map((job) =>
          job.id === invoice.jobId && job.invoiceStatus === 'awaiting-po'
            ? { ...job, invoiceStatus: 'invoiced' }
            : job,
        );
      }
    },

    async requestPdf(ids) {
      await latency(600, 300);
      if (ids.length === 0) {
        throw new ServiceError('VALIDATION_FAILED', 'Select at least one invoice');
      }
      // PDFs are rendered server-side from HTML+CSS (§6A.6). Nothing to do here.
    },

    async retryXero(id) {
      await latency(700, 300);
      const invoice = currentList().find((candidate) => candidate.id === id);
      if (!invoice) throw new ServiceError('NOT_FOUND', `No invoice ${id}`);
      overrides.set(id, {
        ...overrides.get(id),
        xeroState: 'synced',
        xeroLastSyncAt: new Date().toISOString(),
        xeroMessage: null,
      });
    },
  };
}

/** Same relative windows the jobs list uses, so filters read consistently. */
function matchesWindow(isoDate: string | null, window: string): boolean {
  if (!isoDate) return window === 'unissued';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round(
    (new Date(`${isoDate}T00:00:00`).getTime() - today.getTime()) / 86400_000,
  );

  switch (window) {
    case 'this-month':
      return isoDate.slice(0, 7) === new Date().toISOString().slice(0, 7);
    case 'last-7':
      return days <= 0 && days >= -7;
    case 'last-30':
      return days <= 0 && days >= -30;
    case 'last-90':
      return days <= 0 && days >= -90;
    case 'unissued':
      return false;
    default:
      return true;
  }
}

/** Exposed so the notification mock can count the same awaiting-PO set. */
export function awaitingPoInvoices(): InvoiceListItem[] {
  return currentList().filter((invoice) => invoice.status === 'awaiting-po');
}
