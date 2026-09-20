import { rgb, type PDFDocument, type PDFFont, type PDFPage } from 'pdf-lib';

/**
 * The drawing primitives both generated documents share.
 *
 * ── Why this is its own module ────────────────────────────────────────────
 * The invoice (M7.5) and the diversion certificate (M9.5) are drawn with
 * `pdf-lib` rather than rendered from HTML — see the note at the top of
 * `invoice-pdf.ts` for that decision. The consequence is that layout is
 * arithmetic, and arithmetic duplicated across two documents drifts: a page
 * break that works on an invoice and not on a certificate is a bug nobody sees
 * until a customer's copy has a line missing off the bottom.
 *
 * So the cursor, the page-break rule, the wrapper and the measurements live
 * HERE, once, and each document is a sequence of draws on top of them.
 *
 * ⚠️ Nothing in this file performs I/O or knows what a job, an invoice or a
 * certificate is. It measures text and moves down a page.
 */

/* ── Page geometry, in PostScript points (72 per inch) ────────────────────── */

export const A4 = { width: 595.28, height: 841.89 } as const;
export const MARGIN = 48;
export const CONTENT_WIDTH = A4.width - MARGIN * 2;

/** Leaves room for the footer strip and the page number below it. */
export const BOTTOM_LIMIT = 96;

export const INK = rgb(0.11, 0.12, 0.13);
export const MUTED = rgb(0.42, 0.45, 0.48);
export const HAIRLINE = rgb(0.85, 0.86, 0.87);
export const PAPER_TINT = rgb(0.97, 0.97, 0.98);

export type Colour = ReturnType<typeof rgb>;

/** A cursor over one growing document. */
export interface Ctx {
  doc: PDFDocument;
  page: PDFPage;
  /** Distance from the BOTTOM of the page to the next thing drawn. */
  y: number;
  regular: PDFFont;
  bold: PDFFont;
  accent: Colour;
  pages: PDFPage[];
}

/**
 * Move down, starting a new page when the content would run into the footer.
 *
 * Returns nothing and mutates the cursor, because every draw helper needs the
 * same "am I still on this page?" question answered the same way — and a helper
 * that forgot to ask would silently draw off the bottom edge.
 */
export function advance(ctx: Ctx, by: number): void {
  ctx.y -= by;
  if (ctx.y > BOTTOM_LIMIT) return;

  ctx.page = ctx.doc.addPage([A4.width, A4.height]);
  ctx.pages.push(ctx.page);
  ctx.y = A4.height - MARGIN;
}

export function text(
  ctx: Ctx,
  value: string,
  options: {
    x?: number;
    size?: number;
    font?: PDFFont;
    colour?: Colour;
    /** Right edge to align against, for money and figure columns. */
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
 * A site address or a terms paragraph is arbitrary text an administrator typed;
 * counting characters overflows on capitals and wastes half a line on
 * lowercase. Returns the lines so callers can decide how many to keep.
 */
export function wrap(value: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];

  for (const paragraphText of value.split('\n')) {
    let current = '';

    for (const word of paragraphText.split(/\s+/).filter(Boolean)) {
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

export function paragraph(
  ctx: Ctx,
  value: string,
  options: { size?: number; colour?: Colour; leading?: number; font?: PDFFont } = {},
): void {
  if (value.trim() === '') return;

  const size = options.size ?? 9;
  const leading = options.leading ?? size + 3;
  const font = options.font ?? ctx.regular;

  for (const line of wrap(value, font, size, CONTENT_WIDTH)) {
    text(ctx, line, { size, colour: options.colour ?? MUTED, font });
    advance(ctx, leading);
  }
}

export function rule(ctx: Ctx, colour: Colour = HAIRLINE, thickness = 0.75): void {
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y },
    end: { x: MARGIN + CONTENT_WIDTH, y: ctx.y },
    thickness,
    color: colour,
  });
}

/** `2026-09-11` → `11 Sep 2026`. Unambiguous for an Australian reader. */
export function formatDate(iso: string | null): string {
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
export function parseHex(hex: string): Colour {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match?.[1]) return INK;

  const int = Number.parseInt(match[1], 16);
  return rgb(((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255);
}

/**
 * Embed a PNG or JPEG, told apart by magic bytes.
 *
 * ⚠️ Returns null rather than throwing on anything it cannot read. A corrupt
 * logo must not cost a customer their invoice or their certificate — the caller
 * falls back to type and records why.
 */
export async function embedImage(
  doc: PDFDocument,
  bytes: Uint8Array,
): Promise<Awaited<ReturnType<PDFDocument['embedPng']>> | null> {
  try {
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    return isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch {
    return null;
  }
}
