import type {
  InvoiceKind,
  InvoiceListItem,
  InvoiceStatus,
  XeroSyncState,
} from '@plastago/shared';
import type {
  CreateInvoiceInput,
  InvoiceScope,
} from '../../src/domains/invoices/invoice.repository.js';

/**
 * An in-memory stand-in for the invoice repository.
 *
 * ── Why a fake and not a mocked Mongo ─────────────────────────────────────
 * What is under test is the SPLIT: which charges land on which invoice, what
 * status each gets, and whether a retry bills the customer twice. None of that
 * needs a database.
 *
 * The one thing modelled faithfully is the conditional bulk write:
 * `transitionMany` filters on the CURRENT status exactly as the real query
 * does, because "an awaiting-PO invoice must not be sendable" is a rule that
 * lives in that filter.
 */

let counter = 0;

/** The statuses an invoice can still be changed in — see `UNSENT_STATUSES`. */
const UNSENT: readonly InvoiceStatus[] = ['draft', 'awaiting-po'];

function nextId(): string {
  counter += 1;
  return counter.toString(16).padStart(24, '0');
}

export interface StoredInvoice extends InvoiceListItem {
  lines: CreateInvoiceInput['lines'];
  sentAt: string | null;
  xeroState: XeroSyncState;
  xeroMessage: string | null;
  /** M7.6 — set once a PDF has been drawn. Null means one has never been. */
  pdfKey: string | null;
}

export function createFakeInvoiceRepository() {
  const invoices = new Map<string, StoredInvoice>();

  return {
    get all(): StoredInvoice[] {
      return [...invoices.values()];
    },
    byKind(kind: InvoiceKind): StoredInvoice | undefined {
      return [...invoices.values()].find((invoice) => invoice.kind === kind);
    },
    seed(invoice: Partial<StoredInvoice> & { status: InvoiceStatus }): StoredInvoice {
      const id = nextId();
      const row: StoredInvoice = {
        id,
        invoiceNumber: 104_100 + invoices.size,
        kind: 'base',
        brandId: 'plastago',
        accountId: 'acc0000000000000000000a1',
        accountName: 'Clarendon Homes',
        jobId: null,
        jobNumber: null,
        poNumber: null,
        issuedOn: '2026-09-10',
        dueOn: '2026-09-17',
        subtotalExGst: '351.75',
        gst: '35.18',
        totalIncGst: '386.93',
        paidAt: null,
        lines: [],
        sentAt: null,
        pdfKey: null,
        xeroState: 'not-synced',
        xeroMessage: null,
        ...invoice,
      };
      invoices.set(id, row);
      return row;
    },

    repository: {
      list() {
        return Promise.resolve({
          data: [...invoices.values()],
          meta: { page: 1, pageSize: 20, total: invoices.size, totalPages: 1 },
        });
      },

      findById(id: string, scope: InvoiceScope) {
        const invoice = invoices.get(id);
        // The scope, as the real query applies it: another account's invoice
        // simply does not exist for this caller.
        if (!invoice) return Promise.resolve(null);
        if (scope.accountId !== null && invoice.accountId !== scope.accountId) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          ...invoice,
          lines: invoice.lines.map((line, index) => ({
            id: String(index),
            description: line.description,
            quantity: line.quantity,
            unitRate: line.unitRate,
            amount: line.amount,
            raisedBy: line.raisedBy,
          })),
          templateName: 'Standard',
          pdfKey: invoice.pdfKey,
          xeroLastSyncAt: null,
          paymentTermsDays: 7,
          notes: '',
        });
      },

      create(input: CreateInvoiceInput) {
        const id = nextId();
        const row: StoredInvoice = {
          id,
          invoiceNumber: input.invoiceNumber,
          kind: input.kind,
          status: input.status,
          brandId: input.brandId,
          accountId: input.accountId,
          accountName: input.accountName,
          jobId: input.jobId,
          jobNumber: input.jobNumber,
          poNumber: input.poNumber,
          issuedOn: input.issuedOn,
          dueOn: input.dueOn,
          subtotalExGst: input.subtotalExGst,
          gst: input.gst,
          totalIncGst: input.totalIncGst,
          paidAt: null,
          lines: input.lines,
          sentAt: null,
          xeroState: 'not-synced',
          xeroMessage: null,
          // A freshly created invoice has never been rendered.
          pdfKey: null,
        };
        invoices.set(id, row);
        return Promise.resolve(row as InvoiceListItem);
      },

      deleteCascade(id: string) {
        invoices.delete(id);
        return Promise.resolve();
      },

      forJob(jobId: string) {
        return Promise.resolve(
          [...invoices.values()]
            .filter((invoice) => invoice.jobId === jobId)
            .map((invoice) => ({
              id: invoice.id,
              kind: invoice.kind,
              status: invoice.status,
              invoiceNumber: invoice.invoiceNumber,
              poNumber: invoice.poNumber,
              lines: invoice.lines.map((line) => ({
                sourceChargeId: line.sourceChargeId,
                description: line.description,
                quantity: line.quantity,
                unitRate: line.unitRate,
                amount: line.amount,
              })),
            })),
        );
      },

      /**
       * ⚠️ The status is in the filter, as in the real update: an invoice that
       * has gone out is a document a builder is holding, and is never rewritten.
       */
      replaceLines(
        invoiceId: string,
        input: Pick<CreateInvoiceInput, 'subtotalExGst' | 'gst' | 'totalIncGst' | 'lines'>,
      ) {
        const invoice = invoices.get(invoiceId);
        if (!invoice || !UNSENT.includes(invoice.status)) return Promise.resolve(null);

        invoice.lines = input.lines;
        invoice.subtotalExGst = input.subtotalExGst;
        invoice.gst = input.gst;
        invoice.totalIncGst = input.totalIncGst;
        invoice.pdfKey = null;
        return Promise.resolve({ ...invoice } as InvoiceListItem);
      },

      deleteUnsent(invoiceId: string) {
        const invoice = invoices.get(invoiceId);
        if (!invoice || !UNSENT.includes(invoice.status)) return Promise.resolve(false);
        invoices.delete(invoiceId);
        return Promise.resolve(true);
      },

      /**
       * ⚠️ Filters on the CURRENT status, exactly as the real update does. An
       * invoice that moved to `awaiting-po` since the grid selection was made
       * must not be sendable, and that rule lives entirely in this filter.
       */
      transitionMany(input: {
        ids: readonly string[];
        fromStatuses: InvoiceStatus[];
        to: InvoiceStatus;
        scope: InvoiceScope;
        set?: Record<string, unknown>;
        requirePo?: boolean;
      }) {
        let changed = 0;

        for (const id of input.ids) {
          const invoice = invoices.get(id);
          if (!invoice) continue;
          if (input.scope.accountId !== null && invoice.accountId !== input.scope.accountId) {
            continue;
          }
          if (!input.fromStatuses.includes(invoice.status)) continue;
          if (input.requirePo && !invoice.poNumber) continue;

          invoice.status = input.to;
          if (input.set?.sentAt instanceof Date) invoice.sentAt = input.set.sentAt.toISOString();
          changed += 1;
        }

        return Promise.resolve(changed);
      },

      recordPo(id: string, poNumber: string, scope: InvoiceScope) {
        const invoice = invoices.get(id);
        if (!invoice) return Promise.resolve({ matched: false, jobId: null });
        if (scope.accountId !== null && invoice.accountId !== scope.accountId) {
          return Promise.resolve({ matched: false, jobId: null });
        }

        invoice.poNumber = poNumber;
        // Recording a PO on a SENT invoice must not un-send it.
        if (invoice.status === 'awaiting-po') invoice.status = 'draft';

        return Promise.resolve({ matched: true, jobId: invoice.jobId });
      },

      recordXeroResult(input: { id: string; state: XeroSyncState; message: string | null }) {
        const invoice = invoices.get(input.id);
        if (!invoice) return Promise.resolve(false);
        invoice.xeroState = input.state;
        invoice.xeroMessage = input.message;
        return Promise.resolve(true);
      },

      existingIds(ids: readonly string[], scope: InvoiceScope) {
        return Promise.resolve(
          ids.filter((id) => {
            const invoice = invoices.get(id);
            if (!invoice) return false;
            return scope.accountId === null || invoice.accountId === scope.accountId;
          }),
        );
      },
    },
  };
}
