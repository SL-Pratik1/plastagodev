import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Invoice, InvoiceLayout, InvoiceTemplate, Settings } from '@plastago/shared';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'invoice-pdf' });

/**
 * The invoice PDF (M7.5, M7.6).
 *
 * ── Why this draws rather than renders HTML ───────────────────────────────
 * §6A.6 originally said "server-side from HTML+CSS", which means a headless
 * browser. That was reconsidered deliberately: it puts Chromium (~300MB) and a
 * second process model into the API container, for a document that is a
 * header, a table and a totals block. `pdf-lib` draws it in-process with no
 * binary and no sandbox to keep patched.
 *
 * The cost of that choice is that layout is arithmetic, not CSS — so the
 * arithmetic is isolated HERE, in a handful of primitives, and the five
 * templates are declarative configuration on top of them. A new template is a
 * row in the database, not a new document.
 *
 * ── The one rule this file must never break ───────────────────────────────
 * ⚠️ It renders what it is GIVEN. It does not look up a rate, re-derive a
 * total, or ask what the current settings are. Every figure arrives already
 * decided, because a PDF that recomputed anything could disagree with the
 * invoice it claims to be — and the customer holds the copy that disagrees.
 */

/* ── Page geometry, in PostScript points (72 per inch) ────────────────────── */

const A4 = { width: 595.28, height: 841.89 } as const;
const MARGIN = 48;
const CONTENT_WIDTH = A4.width - MARGIN * 2;

/** Leaves room for the footer and the page number below it. */
const BOTTOM_LIMIT = 96;

const INK = rgb(0.11, 0.12, 0.13);
const MUTED = rgb(0.42, 0.45, 0.48);
const HAIRLINE = rgb(0.85, 0.86, 0.87);
const PAPER_TINT = rgb(0.97, 0.97, 0.98);

/**
 * What the renderer needs, gathered by the caller.
 *
 * Deliberately a flat snapshot rather than ids to look up: see the note above.
 * `branding` is the invoicing settings as they were when the PDF was produced,
 * and `logo` is bytes already fetched from storage — this module performs no
 * I/O of its own beyond building the document.
 */
export interface InvoicePdfInput {
  invoice: Invoice;
  template: InvoiceTemplate;
  branding: Settings['invoicing'];
  /** Printed in front of the number. Presentation only — see the settings note. */
  invoiceNumberPrefix: string;
  /** PNG or JPEG bytes, or null to print the company name as text instead. */
  logo: Uint8Array | null;
  /** M7.5 — the job's site and collection date, for the `detailed` layout. */
  jobContext: {
    siteName: string | null;
    addressLine: string | null;
    suburb: string | null;
    collectedOn: string | null;
    recoveredWeightKg: number | null;
    expectedAreaM2: number | null;
  } | null;
}

/* ── A cursor over one growing document ───────────────────────────────────── */

interface Ctx {
  doc: PDFDocument;
  page: PDFPage;
  /** Distance from the top of the page to the next thing drawn. */
  y: number;
  regular: PDFFont;
  bold: PDFFont;
  accent: ReturnType<typeof rgb>;
  pages: PDFPage[];
}

/**
 * Move down, starting a new page when the content would run into the footer.
 *
 * Returns nothing and mutates the cursor, because every draw helper below
 * needs the same "am I still on this page?" question answered the same way —
 * and a helper that forgot to ask would silently draw off the bottom edge.
 */
function advance(ctx: Ctx, by: number): void {
  ctx.y -= by;
  if (ctx.y > BOTTOM_LIMIT) return;

  ctx.page = ctx.doc.addPage([A4.width, A4.height]);
  ctx.pages.push(ctx.page);
  ctx.y = A4.height - MARGIN;
}

function text(
  ctx: Ctx,
  value: string,
  options: {
    x?: number;
    size?: number;
    font?: PDFFont;
    colour?: ReturnType<typeof rgb>;
    /** Right edge to align against, for money columns. */
    rightAt?: number;
  } = {},
): void {
  const font = options.font ?? ctx.regular;
  const size = options.size ?? 9.5;
  const x =
    options.rightAt === undefined
      ? (options.x ?? MARGIN)
      : options.rightAt - font.widthOfTextAtSize(value, size);

  ctx.page.drawText(value, {
    x,
    y: ctx.y,
    size,
    font,
    color: options.colour ?? INK,
  });
}

/**
 * Wrap to a width, measuring the real font rather than guessing at characters.
 *
 * A site address or a terms paragraph is arbitrary text an administrator
 * typed; counting characters overflows on capitals and wastes half a line on
 * lowercase. Returns the lines so callers can decide how many to keep.
 */
function wrap(value: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];

  for (const paragraph of value.split('\n')) {
    let current = '';

    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = current === '' ? word : `${current} ${word}`;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        current = candidate;
        continue;
      }
      if (current !== '') lines.push(current);
      current = word;
    }

    lines.push(current);
  }

  return lines;
}

function paragraph(
  ctx: Ctx,
  value: string,
  options: { size?: number; colour?: ReturnType<typeof rgb>; leading?: number } = {},
): void {
  if (value.trim() === '') return;

  const size = options.size ?? 9;
  const leading = options.leading ?? size + 3;

  for (const line of wrap(value, ctx.regular, size, CONTENT_WIDTH)) {
    text(ctx, line, { size, colour: options.colour ?? MUTED });
    advance(ctx, leading);
  }
}

function rule(ctx: Ctx, colour = HAIRLINE, thickness = 0.75): void {
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y },
    end: { x: MARGIN + CONTENT_WIDTH, y: ctx.y },
    thickness,
    color: colour,
  });
}

/* ── Money and dates ──────────────────────────────────────────────────────── */

/**
 * `"1234.5"` → `"$1,234.50"`.
 *
 * ⚠️ Formats a decimal STRING and never parses it into a float. These figures
 * arrive as decimal strings precisely because a double cannot hold them
 * exactly, and turning one into a Number here to add a comma would undo that
 * at the last possible moment — on the document the customer keeps.
 */
export function formatMoney(value: string): string {
  const negative = value.trim().startsWith('-');
  const [whole = '0', fraction = ''] = value.trim().replace(/^-/, '').split('.');

  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = `${fraction}00`.slice(0, 2);

  return `${negative ? '-' : ''}$${grouped}.${cents}`;
}

/** `2026-09-11` → `11 Sep 2026`. Unambiguous for an Australian reader. */
function formatDate(iso: string | null): string {
  if (!iso) return '—';

  const [year, month, day] = iso.split('-');
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];

  const index = Number(month) - 1;
  if (!year || !day || index < 0 || index > 11) return iso;

  return `${day} ${months[index] ?? month} ${year}`;
}

/** `#1a4d3a` → a pdf-lib colour, falling back to ink on anything malformed. */
function parseHex(hex: string): ReturnType<typeof rgb> {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match?.[1]) return INK;

  const int = Number.parseInt(match[1], 16);
  return rgb(((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255);
}

/* ── The document ─────────────────────────────────────────────────────────── */

/**
 * Whether this template's layout prints the RCTI wording.
 *
 * ⚠️ An RCTI is a different legal document: the RECIPIENT raises it, and the
 * ATO requires it to say so. Printing "Tax Invoice" on one, or omitting the
 * agreement statement, makes it invalid — so the heading is derived from the
 * layout rather than being a free-text field somebody could mistype.
 */
function headingFor(layout: InvoiceLayout, kind: Invoice['kind']): string {
  if (layout === 'rcti') return 'RECIPIENT CREATED TAX INVOICE';
  return kind === 'additional-charges' ? 'TAX INVOICE — ADDITIONAL CHARGES' : 'TAX INVOICE';
}

export async function renderInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  const { invoice, template } = input;

  const doc = await PDFDocument.create();
  doc.setTitle(`Invoice ${input.invoiceNumberPrefix}${String(invoice.invoiceNumber)}`);
  doc.setProducer('PlastaGo');
  doc.setCreator('PlastaGo');

  const page = doc.addPage([A4.width, A4.height]);

  const ctx: Ctx = {
    doc,
    page,
    y: A4.height - MARGIN,
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    accent: parseHex(template.accentColour),
    pages: [page],
  };

  await drawHeader(ctx, input);
  drawParties(ctx, input);
  drawMeta(ctx, input);

  if (template.layout === 'detailed') drawJobContext(ctx, input);

  drawLines(ctx, input);
  drawTotals(ctx, input);
  drawPayment(ctx, input);
  drawFooter(ctx, input);

  const bytes = await doc.save();
  log.info(
    { invoiceId: invoice.id, layout: template.layout, pages: ctx.pages.length },
    'invoice pdf rendered',
  );

  return Buffer.from(bytes);
}

async function drawHeader(ctx: Ctx, input: InvoicePdfInput): Promise<void> {
  const { branding, template, invoice } = input;

  const headingTop = ctx.y;

  /*
   * The logo, or the company name set in type.
   *
   * Never a placeholder box: a document that reached a builder with an empty
   * frame where a logo belongs looks broken in a way a plain wordmark does
   * not.
   */
  if (input.logo) {
    try {
      // PNG and JPEG are the two the upload allow-list permits, and they are
      // told apart by magic bytes rather than by a filename nobody stored.
      const isPng = input.logo[0] === 0x89 && input.logo[1] === 0x50;
      const image = isPng ? await ctx.doc.embedPng(input.logo) : await ctx.doc.embedJpg(input.logo);

      // Bounded by height so a wide and a square logo both sit on the line.
      const height = 34;
      const scaled = image.scale(height / image.height);

      ctx.page.drawImage(image, {
        x: MARGIN,
        y: ctx.y - height + 8,
        width: scaled.width,
        height,
      });
    } catch (error) {
      /*
       * A corrupt or unsupported logo must not cost the customer their
       * invoice. Fall through to the wordmark and record why.
       */
      log.warn({ err: error, invoiceId: invoice.id }, 'logo could not be embedded — using text');
      text(ctx, branding.companyName || 'PlastaGo', { size: 18, font: ctx.bold });
    }
  } else {
    text(ctx, branding.companyName || 'PlastaGo', { size: 18, font: ctx.bold });
  }

  /* The document type, right-aligned against the logo. */
  const heading = headingFor(template.layout, invoice.kind);
  ctx.y = headingTop;
  text(ctx, heading, {
    size: 13,
    font: ctx.bold,
    colour: ctx.accent,
    rightAt: MARGIN + CONTENT_WIDTH,
  });

  advance(ctx, 16);
  text(ctx, `${input.invoiceNumberPrefix}${String(invoice.invoiceNumber)}`, {
    size: 11,
    font: ctx.bold,
    rightAt: MARGIN + CONTENT_WIDTH,
  });

  advance(ctx, 22);
  rule(ctx, ctx.accent, 2);
  advance(ctx, 18);
}

function drawParties(ctx: Ctx, input: InvoicePdfInput): void {
  const { branding, invoice } = input;

  const top = ctx.y;

  /* Who is billing. */
  text(ctx, 'FROM', { size: 7.5, font: ctx.bold, colour: MUTED });
  advance(ctx, 12);

  const fromLines = [
    branding.companyName,
    branding.companyAbn === '' ? '' : `ABN ${branding.companyAbn}`,
    branding.companyAddress,
    branding.companyPhone,
    branding.companyEmail,
  ].filter((line) => line.trim() !== '');

  for (const line of fromLines) {
    text(ctx, line, { size: 9 });
    advance(ctx, 12);
  }

  /*
   * Who is being billed, in a second column on the same rows.
   *
   * Drawn by rewinding the cursor rather than by a real two-column layout:
   * both blocks are short and bounded, and a column engine for two lists
   * would be more machinery than the page needs.
   */
  const afterFrom = ctx.y;
  ctx.y = top;
  const rightColumn = MARGIN + CONTENT_WIDTH / 2;

  text(ctx, 'BILL TO', { x: rightColumn, size: 7.5, font: ctx.bold, colour: MUTED });
  advance(ctx, 12);

  text(ctx, invoice.accountName, { x: rightColumn, size: 9, font: ctx.bold });
  advance(ctx, 12);

  ctx.y = Math.min(afterFrom, ctx.y);
  advance(ctx, 10);
}

function drawMeta(ctx: Ctx, input: InvoicePdfInput): void {
  const { invoice } = input;

  /*
   * The four facts an accounts payable clerk matches on.
   *
   * The PO number is first and always present, even as a dash: an invoice
   * whose PO cannot be found is the single most common reason one gets
   * rejected (Matt, 9:56), and a clerk should not have to hunt for it.
   */
  const fields: Array<[string, string]> = [
    ['Purchase order', invoice.poNumber ?? '—'],
    ['Issued', formatDate(invoice.issuedOn)],
    ['Due', formatDate(invoice.dueOn)],
    ['Job', invoice.jobNumber === null ? '—' : String(invoice.jobNumber)],
  ];

  const boxTop = ctx.y;
  const boxHeight = 34;

  ctx.page.drawRectangle({
    x: MARGIN,
    y: boxTop - boxHeight + 10,
    width: CONTENT_WIDTH,
    height: boxHeight,
    color: PAPER_TINT,
  });

  const columnWidth = CONTENT_WIDTH / fields.length;

  fields.forEach(([label, value], index) => {
    const x = MARGIN + 10 + columnWidth * index;
    ctx.y = boxTop - 2;
    text(ctx, label.toUpperCase(), { x, size: 6.5, font: ctx.bold, colour: MUTED });
    ctx.y = boxTop - 15;
    text(ctx, value, { x, size: 9.5, font: ctx.bold });
  });

  ctx.y = boxTop - boxHeight;
  advance(ctx, 22);
}

/** M7.5 — the `detailed` layout names the site the work happened at. */
function drawJobContext(ctx: Ctx, input: InvoicePdfInput): void {
  const job = input.jobContext;
  if (!job) return;

  text(ctx, 'COLLECTION', { size: 7.5, font: ctx.bold, colour: MUTED });
  advance(ctx, 13);

  const site = [job.siteName, job.addressLine, job.suburb]
    .filter((part) => part !== null && part.trim() !== '')
    .join(', ');

  if (site !== '') {
    text(ctx, site, { size: 9 });
    advance(ctx, 12);
  }

  const measured: string[] = [];
  if (job.collectedOn) measured.push(`Collected ${formatDate(job.collectedOn)}`);
  if (job.expectedAreaM2 !== null) measured.push(`${String(job.expectedAreaM2)} m²`);
  // Only where the template prints weight — an account on m²-only capture has
  // no weight worth quoting, and a blank "0 kg" invites a query.
  if (input.template.showsWeight && job.recoveredWeightKg !== null) {
    measured.push(`${String(job.recoveredWeightKg)} kg recovered`);
  }

  if (measured.length > 0) {
    text(ctx, measured.join('  ·  '), { size: 9, colour: MUTED });
    advance(ctx, 12);
  }

  advance(ctx, 10);
}

function drawLines(ctx: Ctx, input: InvoicePdfInput): void {
  const { invoice, template } = input;

  /*
   * The `compact` layout drops the per-unit columns.
   *
   * High-volume accounts get one line per job and never read the rate; the
   * columns are noise on a document somebody scans for a total. Every other
   * layout keeps them, because "2 bags at $30 each = $60" is the thing
   * TransVirtual cannot print and Matt asked for.
   */
  const showsUnits = template.layout !== 'compact';

  const amountRight = MARGIN + CONTENT_WIDTH;
  const rateRight = amountRight - 80;
  const qtyRight = rateRight - 60;
  const descriptionWidth = (showsUnits ? qtyRight - 8 : amountRight - 90) - MARGIN;

  /* Header row. */
  text(ctx, 'DESCRIPTION', { size: 7.5, font: ctx.bold, colour: MUTED });
  if (showsUnits) {
    text(ctx, 'QTY', { size: 7.5, font: ctx.bold, colour: MUTED, rightAt: qtyRight });
    text(ctx, 'RATE', { size: 7.5, font: ctx.bold, colour: MUTED, rightAt: rateRight });
  }
  text(ctx, 'AMOUNT', { size: 7.5, font: ctx.bold, colour: MUTED, rightAt: amountRight });

  advance(ctx, 8);
  rule(ctx);
  advance(ctx, 14);

  for (const line of invoice.lines) {
    const wrapped = wrap(line.description, ctx.regular, 9.5, descriptionWidth);
    const [first = '', ...rest] = wrapped;

    text(ctx, first, { size: 9.5 });
    if (showsUnits) {
      // Quantities print as typed — `2`, not `2.00`. A bag count with cents on
      // it reads as a rounding error.
      text(ctx, String(line.quantity), { size: 9.5, rightAt: qtyRight });
      text(ctx, formatMoney(line.unitRate), { size: 9.5, rightAt: rateRight });
    }
    text(ctx, formatMoney(line.amount), { size: 9.5, rightAt: amountRight });
    advance(ctx, 13);

    for (const continued of rest) {
      text(ctx, continued, { size: 9.5, colour: MUTED });
      advance(ctx, 12);
    }

    /*
     * Who raised it, where a driver did (M2.7).
     *
     * The evidence trail for an additional charge: a contamination fee with
     * no name against it is the one a builder rings up about.
     */
    if (line.raisedBy !== null && line.raisedBy.trim() !== '') {
      text(ctx, `Raised by ${line.raisedBy}`, { size: 7.5, colour: MUTED });
      advance(ctx, 12);
    }

    advance(ctx, 3);
  }

  rule(ctx);
  advance(ctx, 16);
}

function drawTotals(ctx: Ctx, input: InvoicePdfInput): void {
  const { invoice } = input;

  const right = MARGIN + CONTENT_WIDTH;
  const labelRight = right - 110;

  const rows: Array<[string, string, boolean]> = [
    ['Subtotal (ex GST)', formatMoney(invoice.subtotalExGst), false],
    ['GST', formatMoney(invoice.gst), false],
    ['Total (inc GST)', formatMoney(invoice.totalIncGst), true],
  ];

  for (const [label, value, emphasised] of rows) {
    if (emphasised) {
      advance(ctx, 4);
      ctx.page.drawLine({
        start: { x: labelRight - 40, y: ctx.y + 10 },
        end: { x: right, y: ctx.y + 10 },
        thickness: 0.75,
        color: HAIRLINE,
      });
      advance(ctx, 4);
    }

    text(ctx, label, {
      size: emphasised ? 10.5 : 9.5,
      font: emphasised ? ctx.bold : ctx.regular,
      colour: emphasised ? INK : MUTED,
      rightAt: labelRight,
    });
    text(ctx, value, {
      size: emphasised ? 11.5 : 9.5,
      font: emphasised ? ctx.bold : ctx.regular,
      colour: emphasised ? ctx.accent : INK,
      rightAt: right,
    });

    advance(ctx, emphasised ? 20 : 14);
  }

  /*
   * Paid, where it is.
   *
   * Stated on the document rather than left to the email, because a PDF gets
   * filed and forwarded long after the email is gone — and "is this one
   * still outstanding?" is the question the file is opened to answer.
   */
  if (invoice.paidAt !== null) {
    text(ctx, 'PAID IN FULL', { size: 10, font: ctx.bold, colour: ctx.accent, rightAt: right });
    advance(ctx, 18);
  }

  advance(ctx, 6);
}

function drawPayment(ctx: Ctx, input: InvoicePdfInput): void {
  const { branding, invoice } = input;

  const hasBank = branding.bankBsb.trim() !== '' && branding.bankAccount.trim() !== '';
  if (!hasBank && branding.termsText.trim() === '') return;

  rule(ctx);
  advance(ctx, 16);

  if (hasBank) {
    text(ctx, 'PAYMENT', { size: 7.5, font: ctx.bold, colour: MUTED });
    advance(ctx, 13);

    /*
     * The account NAME is printed with the numbers, not instead of them.
     *
     * A BSB and account number alone will send money to whatever account
     * matches — banks do not verify the name, but the payer's own system
     * often asks for it, and an invoice that omits it generates a phone call.
     */
    const bankLine = [
      branding.bankAccountName,
      `BSB ${branding.bankBsb}`,
      `Acct ${branding.bankAccount}`,
    ]
      .filter((part) => part.trim() !== '')
      .join('   ·   ');

    text(ctx, bankLine, { size: 9.5, font: ctx.bold });
    advance(ctx, 14);

    text(
      ctx,
      `Please quote ${input.invoiceNumberPrefix}${String(invoice.invoiceNumber)} as the payment reference.`,
      { size: 8.5, colour: MUTED },
    );
    advance(ctx, 16);
  }

  paragraph(ctx, branding.termsText, { size: 8.5 });
  advance(ctx, 4);
}

function drawFooter(ctx: Ctx, input: InvoicePdfInput): void {
  const { branding, template } = input;

  /*
   * The footer is drawn at a FIXED height on every page rather than after the
   * content, so a two-page invoice does not end with a footer floating in the
   * middle of page two.
   */
  const footerY = 56;

  for (const [index, page] of ctx.pages.entries()) {
    page.drawLine({
      start: { x: MARGIN, y: footerY + 22 },
      end: { x: MARGIN + CONTENT_WIDTH, y: footerY + 22 },
      thickness: 0.5,
      color: HAIRLINE,
    });

    if (branding.footerText.trim() !== '') {
      // One line only: the footer is a strip, and a long paragraph typed into
      // it should be clipped here rather than allowed to climb the page.
      const [line = ''] = wrap(branding.footerText, ctx.regular, 8, CONTENT_WIDTH - 120);
      page.drawText(line, { x: MARGIN, y: footerY + 8, size: 8, font: ctx.regular, color: MUTED });
    }

    if (branding.showGbcaBadge) {
      page.drawText('Green Building Council of Australia member', {
        x: MARGIN,
        y: footerY - 4,
        size: 7,
        font: ctx.regular,
        color: MUTED,
      });
    }

    /*
     * ⚠️ "Page 1 of 1" is printed even on a single-page invoice, on purpose.
     * It is how a recipient knows nothing was lost in a fax, a scan or a
     * print job — which is still how a proportion of these are handled.
     */
    const stamp = `Page ${String(index + 1)} of ${String(ctx.pages.length)}`;
    page.drawText(stamp, {
      x: MARGIN + CONTENT_WIDTH - ctx.regular.widthOfTextAtSize(stamp, 8),
      y: footerY + 8,
      size: 8,
      font: ctx.regular,
      color: MUTED,
    });
  }

  /*
   * The RCTI declaration, on the last page only.
   *
   * Required wording: an RCTI is valid only where both parties have agreed in
   * writing that the recipient raises it and the supplier does not. Omitting
   * this makes the document fail an ATO review, so it is not optional and not
   * editable.
   */
  if (template.layout === 'rcti') {
    const last = ctx.pages[ctx.pages.length - 1];
    last?.drawText(
      'The recipient and the supplier declare that this is a recipient created tax invoice.',
      { x: MARGIN, y: footerY - 16, size: 7, font: ctx.regular, color: MUTED },
    );
  }
}
