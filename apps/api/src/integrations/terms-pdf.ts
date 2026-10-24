import { PDFDocument, StandardFonts } from 'pdf-lib';
import { logger } from '../lib/logger.js';
import {
  A4,
  INK,
  MARGIN,
  MUTED,
  advance,
  embedImage,
  paragraph,
  parseHex,
  rule,
  text,
  type Ctx,
} from './pdf-primitives.js';

const log = logger.child({ module: 'terms-pdf' });

const ACCENT = '#1a4d3a';
const SIGNATURE_BOX = { width: 220, height: 70 } as const;

export interface SignedTermsInput {
  /** The terms exactly as uploaded. Null or unreadable: the signing page stands alone. */
  termsPdf: Uint8Array | null;
  termsVersion: number;
  termsFileName: string;
  accountName: string;
  customerCode: string;
  signerName: string;
  signedAt: Date;
  ip: string | null;
  userAgent: string | null;
  signature: Uint8Array;
  directorName: string;
  directorAddress: string;
  directorSignature: Uint8Array;
}

/**
 * The terms the customer signed, with a signing page appended (Matt, 21 Oct).
 *
 * Wendell: *"they signed it on this particular date. Here's the actual
 * signature… time stamp… IP address… proof that they signed up."* So the office
 * downloads one document: the exact version they read, followed by who signed,
 * both drawn signatures, when, and from where.
 *
 * A PDF that pdf-lib cannot open (encrypted, damaged) is not a reason to lose
 * the evidence — the signing page is produced on its own and names the file.
 */
export async function renderSignedTerms(input: SignedTermsInput): Promise<Buffer> {
  const doc = await loadOrCreate(input.termsPdf);
  const page = doc.addPage([A4.width, A4.height]);

  const ctx: Ctx = {
    doc,
    page,
    y: A4.height - MARGIN,
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    accent: parseHex(ACCENT),
    pages: [page],
  };

  text(ctx, 'Acceptance of terms and conditions', { size: 16, font: ctx.bold, colour: ctx.accent });
  advance(ctx, 18);
  paragraph(
    ctx,
    printable(
      `${input.accountName} (${input.customerCode}) accepted version ${String(input.termsVersion)} of the terms and conditions (${input.termsFileName}), including the director’s guarantee, as recorded below.`,
    ),
  );
  advance(ctx, 8);
  rule(ctx);
  advance(ctx, 18);

  heading(ctx, 'Signed by');
  line(ctx, 'Name', input.signerName);
  line(ctx, 'Signed', sydneyTimestamp(input.signedAt));
  line(ctx, 'IP address', input.ip ?? 'Not recorded');
  line(ctx, 'Browser', input.userAgent ?? 'Not recorded');
  await signature(ctx, input.signature);

  advance(ctx, 14);
  heading(ctx, 'Director’s guarantee');
  line(ctx, 'Director', input.directorName);
  line(ctx, 'Residential address', input.directorAddress);
  await signature(ctx, input.directorSignature);

  return Buffer.from(await doc.save());
}

async function loadOrCreate(termsPdf: Uint8Array | null): Promise<PDFDocument> {
  if (termsPdf) {
    try {
      return await PDFDocument.load(termsPdf);
    } catch (error) {
      log.warn({ err: error }, 'terms PDF could not be opened — signing page produced on its own');
    }
  }
  return PDFDocument.create();
}

function heading(ctx: Ctx, value: string): void {
  text(ctx, printable(value), { size: 11, font: ctx.bold, colour: INK });
  advance(ctx, 16);
}

function line(ctx: Ctx, label: string, value: string): void {
  text(ctx, label, { size: 9, colour: MUTED });
  text(ctx, printable(value).slice(0, 110), { size: 9.5, x: MARGIN + 120, colour: INK });
  advance(ctx, 14);
}

async function signature(ctx: Ctx, png: Uint8Array): Promise<void> {
  const image = await embedImage(ctx.doc, png);
  advance(ctx, SIGNATURE_BOX.height);

  if (image) {
    const scale = Math.min(SIGNATURE_BOX.width / image.width, SIGNATURE_BOX.height / image.height, 1);
    ctx.page.drawImage(image, {
      x: MARGIN + 120,
      y: ctx.y,
      width: image.width * scale,
      height: image.height * scale,
    });
  } else {
    text(ctx, '[signature could not be drawn]', { size: 9, x: MARGIN + 120, colour: MUTED });
  }
  advance(ctx, 8);
}

/** Sydney time, with the zone named — the office reads this, not a server. */
function sydneyTimestamp(at: Date): string {
  return `${at.toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })} (Sydney time)`;
}

/**
 * Only what the standard PDF fonts can print.
 *
 * A name in a script Helvetica cannot encode would make pdf-lib throw and cost
 * the customer their signed copy; a question mark in its place does not.
 */
function printable(value: string): string {
  return value.replace(/[^\x20-\x7E\xA0-\xFF‘’“”–—•…]/g, '?');
}
