import { describe, expect, it } from 'vitest';
import type { Invoice, InvoiceLayout, InvoiceTemplate, Settings } from '@plastago/shared';
import { PDFDocument } from 'pdf-lib';
import { formatMoney, renderInvoicePdf } from '../src/integrations/invoice-pdf.js';

/**
 * The invoice PDF (M7.5, M7.6).
 *
 * ── What is worth asserting about a drawing ───────────────────────────────
 * Not pixels. Comparing rendered bytes to a golden file would fail on a font
 * metric change and tell nobody anything useful.
 *
 * What matters is that the document is STRUCTURALLY sound and that the
 * numbers on it are the numbers it was given: a PDF that paginates wrongly is
 * a page a builder never reads, and a total formatted through a float is a
 * cent the customer disputes. Those are the two classes tested here.
 */

const BRANDING: Settings['invoicing'] = {
  templates: [],
  invoiceNumberPrefix: 'PGA',
  splitAdditionalCharges: true,
  defaultPaymentTermsDays: 7,
  logoKey: '',
  // Derived from `logoKey`; null because this fixture has no logo uploaded.
  logoUrl: null,
  companyName: 'PlastaGo Pty Ltd',
  companyAbn: '51824753556',
  companyAddress: '1 Recycling Way, Smithfield NSW 2164',
  companyPhone: '02 9000 0000',
  companyEmail: 'accounts@plastago.com.au',
  termsText: 'Payment due within 7 days of the invoice date.',
  footerText: 'PlastaGo — plasterboard recycling',
  bankBsb: '082-343',
  bankAccount: '45 327 0863',
  bankAccountName: 'PlastaGo Pty Ltd',
  showGbcaBadge: true,
};

function template(overrides: Partial<InvoiceTemplate> = {}): InvoiceTemplate {
  return {
    id: 'pg-m2',
    name: 'PlastaGo Recycling Invoice (m²)',
    brandId: 'plastago',
    showsWeight: false,
    layout: 'standard',
    accentColour: '#1a4d3a',
    assignedAccountCount: 0,
    deletable: true,
    ...overrides,
  };
}

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'a'.repeat(24),
    invoiceNumber: 104_312,
    kind: 'base',
    status: 'sent',
    brandId: 'plastago',
    accountId: 'b'.repeat(24),
    accountName: 'Clarendon Homes',
    jobId: 'c'.repeat(24),
    jobNumber: 61_402,
    poNumber: 'PO-88214',
    issuedOn: '2026-09-11',
    dueOn: '2026-09-18',
    subtotalExGst: '474.68',
    gst: '47.47',
    totalIncGst: '522.15',
    paidAt: null,
    lines: [
      {
        id: 'd'.repeat(24),
        description: 'Service fee — Sydney',
        quantity: 1,
        unitRate: '220.00',
        amount: '220.00',
        raisedBy: null,
      },
      {
        id: 'e'.repeat(24),
        description: 'Plasterboard recycling (per m²)',
        quantity: 823.41,
        unitRate: '0.16',
        amount: '131.75',
        raisedBy: null,
      },
    ],
    templateName: 'PlastaGo Recycling Invoice (m²)',
    pdfKey: null,
    sentAt: null,
    xeroState: 'not-synced',
    xeroLastSyncAt: null,
    xeroMessage: null,
    paymentTermsDays: 7,
    notes: '',
    ...overrides,
  };
}

function render(overrides: { invoice?: Partial<Invoice>; template?: Partial<InvoiceTemplate> } = {}) {
  return renderInvoicePdf({
    invoice: invoice(overrides.invoice),
    template: template(overrides.template),
    branding: BRANDING,
    invoiceNumberPrefix: 'PGA-',
    logo: null,
    jobContext: {
      siteName: 'Oran Park Stage 7',
      addressLine: 'Lot 412 Dickson Road',
      suburb: 'Oran Park',
      collectedOn: '2026-09-10',
      recoveredWeightKg: 1840,
      expectedAreaM2: 823.41,
    },
  });
}

/**
 * How many pages a rendered document has.
 *
 * ⚠️ Parsed by loading the PDF, NOT by grepping for `/Type /Page`. pdf-lib
 * writes object streams compressed, so the markers are not in the byte stream
 * as text — a regex returns zero for every document and every pagination
 * assertion passes vacuously. Reading it back the way a viewer would is the
 * only honest check.
 */
async function pageCount(pdf: Buffer): Promise<number> {
  const parsed = await PDFDocument.load(pdf);
  return parsed.getPageCount();
}

/** The document title, read back through a real parse. */
async function titleOf(pdf: Buffer): Promise<string | undefined> {
  const parsed = await PDFDocument.load(pdf);
  return parsed.getTitle();
}

describe('formatting money for a document a customer keeps', () => {
  /*
   * ⚠️ These figures arrive as decimal STRINGS because a double cannot hold
   * them exactly. Formatting must not be the place that undoes it.
   */
  it('groups thousands and always shows two decimals', () => {
    expect(formatMoney('1234.5')).toBe('$1,234.50');
    expect(formatMoney('220.00')).toBe('$220.00');
    expect(formatMoney('0.16')).toBe('$0.16');
  });

  it('handles millions, where a naive regex drops a group', () => {
    expect(formatMoney('1234567.89')).toBe('$1,234,567.89');
  });

  it('pads a bare whole number rather than printing "$5."', () => {
    expect(formatMoney('5')).toBe('$5.00');
  });

  it('keeps a credit negative', () => {
    // Credit notes are v1.1, but a negative reaching the formatter must not
    // silently render as a positive charge.
    expect(formatMoney('-90.00')).toBe('-$90.00');
  });

  it('does not round a third decimal into the cents', () => {
    /*
     * `0.165` truncates to `0.16`, it does not round to `0.17`. Rounding here
     * would disagree with the stored amount, and the stored amount is what
     * was charged.
     */
    expect(formatMoney('0.165')).toBe('$0.16');
  });

  it('survives a value with no fractional part at all', () => {
    expect(formatMoney('1000')).toBe('$1,000.00');
  });
});

describe('the rendered document', () => {
  it('produces a valid PDF', async () => {
    const pdf = await render();

    // The magic bytes, and a trailer — enough to know a reader will open it.
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('%%EOF');
    expect(pdf.byteLength).toBeGreaterThan(1000);
  });

  it('fits an ordinary invoice on one page', async () => {
    // Two lines and a totals block should never spill. A second page here
    // means the layout arithmetic has drifted.
    await expect(pageCount(await render())).resolves.toBe(1);
  });

  /*
   * ⚠️ The pagination guard. A fifty-line invoice used to draw straight off
   * the bottom of page one, because the cursor only checked its limit when a
   * helper remembered to ask.
   */
  it('paginates a long invoice instead of drawing off the page', async () => {
    const lines = Array.from({ length: 60 }, (_, index) => ({
      id: String(index).padStart(24, '0'),
      description: `Recycling bags — delivery ${String(index + 1)}`,
      quantity: 2,
      unitRate: '30.00',
      amount: '60.00',
      raisedBy: null,
    }));

    const pdf = await render({ invoice: { lines } });
    await expect(pageCount(pdf)).resolves.toBeGreaterThan(1);
  });

  it('renders every layout', async () => {
    // A layout that threw would take the whole send path down with it.
    const layouts: InvoiceLayout[] = ['standard', 'detailed', 'compact', 'rcti'];

    for (const layout of layouts) {
      const pdf = await render({ template: { layout } });
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    }
  });

  it('renders with no job context, for an invoice not raised from a job', async () => {
    const pdf = await renderInvoicePdf({
      invoice: invoice({ jobId: null, jobNumber: null }),
      template: template({ layout: 'detailed' }),
      branding: BRANDING,
      invoiceNumberPrefix: 'PGA-',
      logo: null,
      // The detailed layout asks for a site and there is none. It must skip
      // the block, not throw.
      jobContext: null,
    });

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('renders with branding entirely blank', async () => {
    /*
     * A fresh environment has no logo, no ABN and no bank details. The
     * document must still be produced — degraded, not failed — because the
     * alternative is an invoice that cannot be sent at all.
     */
    const blank: Settings['invoicing'] = {
      ...BRANDING,
      companyName: '',
      companyAbn: '',
      companyAddress: '',
      companyPhone: '',
      companyEmail: '',
      termsText: '',
      footerText: '',
      bankBsb: '',
      bankAccount: '',
      bankAccountName: '',
      showGbcaBadge: false,
    };

    const pdf = await renderInvoicePdf({
      invoice: invoice(),
      template: template(),
      branding: blank,
      invoiceNumberPrefix: '',
      logo: null,
      jobContext: null,
    });

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('does not fail on a malformed accent colour', async () => {
    // An administrator can type into this field. A bad value falls back to
    // ink rather than throwing halfway through a batch of fifty.
    const pdf = await render({ template: { accentColour: 'not-a-colour' } });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('does not fail on a corrupt logo', async () => {
    /*
     * Bytes that are neither PNG nor JPEG. The embed throws, and the renderer
     * has to fall through to the wordmark — a broken logo must never cost the
     * customer their invoice.
     */
    const pdf = await renderInvoicePdf({
      invoice: invoice(),
      template: template(),
      branding: BRANDING,
      invoiceNumberPrefix: 'PGA-',
      logo: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      jobContext: null,
    });

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('wraps a long description rather than running off the edge', async () => {
    const pdf = await render({
      invoice: {
        lines: [
          {
            id: 'f'.repeat(24),
            description:
              'Contamination charge — mixed construction waste including timber offcuts, plastic sheeting and metal strapping found through the load on arrival at the tip',
            quantity: 1,
            unitRate: '90.00',
            amount: '90.00',
            raisedBy: 'Danny Pereira',
          },
        ],
      },
    });

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    await expect(pageCount(pdf)).resolves.toBe(1);
  });

  it('sets a document title carrying the prefixed number', async () => {
    // What a browser shows in the tab and what the file manager indexes.
    const pdf = await render();
    await expect(titleOf(pdf)).resolves.toContain('PGA-104312');
  });
});
