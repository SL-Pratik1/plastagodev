import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  CERTIFICATE_WEIGHT_BASIS_LABELS,
  type Certificate,
  type Settings,
} from '@plastago/shared';
import { logger } from '../lib/logger.js';
import {
  A4,
  CONTENT_WIDTH,
  HAIRLINE,
  INK,
  MARGIN,
  MUTED,
  PAPER_TINT,
  advance,
  embedImage,
  formatDate,
  parseHex,
  paragraph,
  rule,
  text,
  type Ctx,
} from './pdf-primitives.js';

const log = logger.child({ module: 'certificate-pdf' });

/**
 * The Certificate of Recycling (M9.5 · F52 · W15).
 *
 * ── What this document is for ─────────────────────────────────────────────
 * It is evidence in somebody else's audit. Builders put it into Green Star and
 * NABERS submissions and council Waste Management Plans, and the scope calls it
 * *"the single highest-value differentiator in the build"* — worth more to the
 * customer than the recycling itself. That value is entirely a function of
 * being believed, which is why the method, the docket and the issuer are on the
 * page and not only in the database.
 *
 * ── One fixed layout, deliberately ────────────────────────────────────────
 * There is no certificate template and no layout picker. Scope Call 1 keeps
 * branding in scope and puts layout AUTHORING in v1.1, and Risk 5 names the
 * WYSIWYG designer as *"the biggest single scope trap"* in the project. So the
 * company details come from settings and the arrangement of them does not.
 *
 * ⚠️ Like the invoice renderer, this draws what it is GIVEN. It looks nothing
 * up and re-derives nothing. Every figure arrives frozen from the certificate
 * record, because a document that recomputed its own tonnage could disagree
 * with the copy an assessor is holding.
 */

/**
 * The heading rule and the figure band.
 *
 * A constant rather than a setting: with no certificate template there is
 * nothing to hang a per-document colour off, and inventing a second colour
 * field for one document is the first step onto the path Risk 5 describes. It
 * matches the default invoice accent so the two documents read as a pair.
 */
const ACCENT = '#1a4d3a';

export interface CertificatePdfInput {
  certificate: Certificate;
  /** The invoicing settings, which is where the shared branding block lives. */
  branding: Settings['invoicing'];
  /** PNG or JPEG bytes, or null to print the company name as text instead. */
  logo: Uint8Array | null;
  /** An optional scanned signature. Null prints the name over a rule. */
  signature: Uint8Array | null;
}

export async function renderCertificatePdf(input: CertificatePdfInput): Promise<Buffer> {
  const { certificate } = input;

  const doc = await PDFDocument.create();
  doc.setTitle(`Certificate of Recycling ${certificate.reference}`);
  doc.setSubject(`${String(certificate.tonnesDiverted)} tonnes diverted from landfill`);
  doc.setProducer('PlastaGo');
  doc.setCreator('PlastaGo');

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

  await drawHeader(ctx, input);
  drawParties(ctx, input);
  drawFigures(ctx, input);
  drawStatement(ctx, input);
  drawMethod(ctx, input);
  await drawSignature(ctx, input);
  drawFooter(ctx, input);

  const bytes = await doc.save();
  log.info(
    { certificateId: certificate.id, reference: certificate.reference, pages: ctx.pages.length },
    'certificate pdf rendered',
  );

  return Buffer.from(bytes);
}

async function drawHeader(ctx: Ctx, input: CertificatePdfInput): Promise<void> {
  const { branding, certificate } = input;

  const headingTop = ctx.y;

  /*
   * The logo, or the company name set in type — never a placeholder frame. A
   * document that reached a builder with an empty box where a logo belongs
   * looks broken in a way a plain wordmark does not.
   */
  const image = input.logo ? await embedImage(ctx.doc, input.logo) : null;

  if (image) {
    const height = 34;
    const scaled = image.scale(height / image.height);
    ctx.page.drawImage(image, { x: MARGIN, y: ctx.y - height + 8, width: scaled.width, height });
  } else {
    if (input.logo) log.warn({ certificateId: certificate.id }, 'logo unreadable — using text');
    text(ctx, branding.companyName || 'PlastaGo', { size: 18, font: ctx.bold });
  }

  /* The document type, right-aligned against the logo. */
  ctx.y = headingTop;
  text(ctx, 'CERTIFICATE OF RECYCLING', {
    size: 13,
    font: ctx.bold,
    colour: ctx.accent,
    rightAt: MARGIN + CONTENT_WIDTH,
  });

  advance(ctx, 16);
  text(ctx, certificate.reference, {
    size: 11,
    font: ctx.bold,
    rightAt: MARGIN + CONTENT_WIDTH,
  });

  advance(ctx, 13);
  text(ctx, `Issued ${formatDate((certificate.issuedAt ?? '').slice(0, 10) || null)}`, {
    size: 8.5,
    colour: MUTED,
    rightAt: MARGIN + CONTENT_WIDTH,
  });

  advance(ctx, 20);
  rule(ctx, ctx.accent, 2);
  advance(ctx, 20);
}

function drawParties(ctx: Ctx, input: CertificatePdfInput): void {
  const { branding, certificate } = input;

  const top = ctx.y;

  /* Who issued it. */
  text(ctx, 'ISSUED BY', { size: 7.5, font: ctx.bold, colour: MUTED });
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

  const leftBottom = ctx.y;

  /* Who it is for, in a second column on the same rows. */
  const column = MARGIN + CONTENT_WIDTH / 2;
  ctx.y = top;

  text(ctx, 'ISSUED TO', { size: 7.5, font: ctx.bold, colour: MUTED, x: column });
  advance(ctx, 12);

  text(ctx, certificate.accountName, { size: 10, font: ctx.bold, x: column });
  advance(ctx, 13);

  /*
   * Every one of these is optional and simply omitted when absent. A
   * period-scoped certificate has no single site and no one collection date,
   * and printing a dash against a label on a document going to an assessor
   * reads as missing data rather than as not applicable.
   */
  const toLines = [
    certificate.siteName,
    certificate.siteAddress,
    certificate.jobNumber === null ? null : `Pickup #${String(certificate.jobNumber)}`,
    certificate.collectedOn === null ? null : `Collected ${formatDate(certificate.collectedOn)}`,
    certificate.scope === 'job'
      ? null
      : `${String(certificate.jobs)} pickups · ${formatDate(certificate.periodFrom)} to ${formatDate(certificate.periodTo)}`,
  ].filter((line): line is string => line !== null && line.trim() !== '');

  for (const line of toLines) {
    text(ctx, line, { size: 9, x: column });
    advance(ctx, 12);
  }

  // Resume below whichever column ran longer.
  ctx.y = Math.min(leftBottom, ctx.y) - 10;
}

/**
 * The two figures, side by side.
 *
 * ⚠️ BOTH appear, and that is Matt's own requirement (`[C2 18:03]`): *"Your job
 * of X amount of square metres had X amount of waste."* Only the tonnage is
 * auditable — it came off a scale — but the m² is how the builder recognises
 * which of their jobs this is.
 */
function drawFigures(ctx: Ctx, input: CertificatePdfInput): void {
  const { certificate } = input;

  const boxHeight = 74;
  const boxTop = ctx.y;

  ctx.page.drawRectangle({
    x: MARGIN,
    y: boxTop - boxHeight,
    width: CONTENT_WIDTH,
    height: boxHeight,
    color: PAPER_TINT,
    borderColor: HAIRLINE,
    borderWidth: 0.75,
  });

  const half = CONTENT_WIDTH / 2;

  ctx.y = boxTop - 22;
  text(ctx, 'PLASTERBOARD COLLECTED', {
    size: 7.5,
    font: ctx.bold,
    colour: MUTED,
    x: MARGIN + 18,
  });
  text(ctx, 'DIVERTED FROM LANDFILL', {
    size: 7.5,
    font: ctx.bold,
    colour: MUTED,
    x: MARGIN + half + 18,
  });

  ctx.y = boxTop - 50;

  /*
   * ⚠️ "Not supplied", never "0 m²".
   *
   * A fixed-price builder's purchase orders carry no area at all (Matt, 31:04),
   * and a zero on this line would tell an assessor they installed no
   * plasterboard — which is a claim, not a gap.
   */
  text(
    ctx,
    certificate.areaM2 === null ? 'Not supplied' : `${formatNumber(certificate.areaM2)} m²`,
    {
      size: certificate.areaM2 === null ? 13 : 20,
      font: ctx.bold,
      colour: certificate.areaM2 === null ? MUTED : INK,
      x: MARGIN + 18,
    },
  );

  text(ctx, `${formatNumber(certificate.tonnesDiverted)} tonnes`, {
    size: 20,
    font: ctx.bold,
    colour: ctx.accent,
    x: MARGIN + half + 18,
  });

  ctx.y = boxTop - boxHeight - 22;
}

/** Matt's own sentence, with the figures substituted in. */
function drawStatement(ctx: Ctx, input: CertificatePdfInput): void {
  const { certificate } = input;

  const subject =
    certificate.scope === 'job'
      ? certificate.areaM2 === null
        ? 'This job'
        : `This job of ${formatNumber(certificate.areaM2)} square metres`
      : certificate.areaM2 === null
        ? `These ${String(certificate.jobs)} pickups`
        : `These ${String(certificate.jobs)} pickups, totalling ${formatNumber(certificate.areaM2)} square metres,`;

  paragraph(
    ctx,
    `${subject} had ${formatNumber(certificate.tonnesDiverted)} tonnes of plasterboard waste, and that has been successfully diverted from landfill and recycled.`,
    { size: 10.5, colour: INK, leading: 15, font: ctx.bold },
  );

  advance(ctx, 12);
}

/**
 * How the figure was arrived at.
 *
 * ── Why this block exists at all ──────────────────────────────────────────
 * Without it the tonnage is an assertion. The crane scale says what left the
 * site and the weighbridge docket says what reached the facility; an assessor
 * who wants to check can quote the docket number. This is the difference
 * between a certificate and a compliment.
 */
function drawMethod(ctx: Ctx, input: CertificatePdfInput): void {
  const { certificate } = input;

  text(ctx, 'HOW THIS WAS MEASURED', { size: 7.5, font: ctx.bold, colour: MUTED });
  advance(ctx, 14);

  const rows: Array<[string, string]> = [
    ['Method', CERTIFICATE_WEIGHT_BASIS_LABELS[certificate.weightBasis]],
  ];

  if (certificate.docketNumber !== null && certificate.docketNumber.trim() !== '') {
    rows.push(['Weighbridge docket', certificate.docketNumber]);
  }
  if (certificate.tippedOffAt !== null) {
    rows.push(['Tipped', formatDate(certificate.tippedOffAt.slice(0, 10))]);
  }

  for (const [label, value] of rows) {
    text(ctx, label, { size: 9, colour: MUTED });
    text(ctx, value, { size: 9, x: MARGIN + 130 });
    advance(ctx, 13);
  }

  advance(ctx, 10);
  rule(ctx);
  advance(ctx, 18);
}

/**
 * The signature block.
 *
 * Both halves are optional. With no name configured nothing is drawn at all —
 * an empty rule with no name under it looks like a document somebody forgot to
 * sign, which is worse than one that does not claim a signature.
 */
async function drawSignature(ctx: Ctx, input: CertificatePdfInput): Promise<void> {
  const { branding } = input;

  if (branding.certificateSignatureName.trim() === '') return;

  const image = input.signature ? await embedImage(ctx.doc, input.signature) : null;

  if (image) {
    // Bounded by height so a wide scan and a square one both sit on the rule.
    const height = 30;
    const scaled = image.scale(height / image.height);
    ctx.page.drawImage(image, {
      x: MARGIN,
      y: ctx.y - 4,
      width: Math.min(scaled.width, 180),
      height,
    });
    advance(ctx, 34);
  } else {
    if (input.signature) log.warn('signature image unreadable — printing the name only');
    advance(ctx, 8);
  }

  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y },
    end: { x: MARGIN + 180, y: ctx.y },
    thickness: 0.75,
    color: HAIRLINE,
  });

  advance(ctx, 12);
  text(ctx, branding.certificateSignatureName, { size: 9, font: ctx.bold });

  if (branding.certificateSignatureTitle.trim() !== '') {
    advance(ctx, 11);
    text(ctx, branding.certificateSignatureTitle, { size: 8.5, colour: MUTED });
  }

  advance(ctx, 16);
}

function drawFooter(ctx: Ctx, input: CertificatePdfInput): void {
  const { branding, certificate } = input;

  /*
   * Fixed height on every page rather than after the content, so a certificate
   * that ever runs to two pages does not end with a footer floating in the
   * middle of page two.
   */
  const footerY = 56;

  /*
   * ⚠️ The freeze, stated on the document itself.
   *
   * The record cannot be re-issued and its figures cannot move. Saying so is
   * what makes the copy in an assessor's pack checkable against ours — and
   * warns anybody holding an altered one that it is not our certificate.
   */
  const issuer =
    certificate.issuedByName === null || certificate.issuedByName.trim() === ''
      ? ''
      : ` by ${certificate.issuedByName}`;

  for (const [index, page] of ctx.pages.entries()) {
    page.drawLine({
      start: { x: MARGIN, y: footerY + 30 },
      end: { x: MARGIN + CONTENT_WIDTH, y: footerY + 30 },
      thickness: 0.5,
      color: HAIRLINE,
    });

    page.drawText(
      `Issued${issuer} against reconciled weighbridge records. These figures are fixed at issue and cannot be amended.`,
      { x: MARGIN, y: footerY + 16, size: 7, font: ctx.regular, color: MUTED },
    );

    page.drawText(`Quote ${certificate.reference} to verify this certificate.`, {
      x: MARGIN,
      y: footerY + 6,
      size: 7,
      font: ctx.regular,
      color: MUTED,
    });

    if (branding.showGbcaBadge) {
      page.drawText('Green Building Council of Australia member', {
        x: MARGIN,
        y: footerY - 6,
        size: 7,
        font: ctx.regular,
        color: MUTED,
      });
    }

    /*
     * "Page 1 of 1" even on a single page, on purpose — it is how a recipient
     * knows nothing was lost in a scan or a print, which is still how a
     * proportion of these are handled.
     */
    const stamp = `Page ${String(index + 1)} of ${String(ctx.pages.length)}`;
    page.drawText(stamp, {
      x: MARGIN + CONTENT_WIDTH - ctx.regular.widthOfTextAtSize(stamp, 8),
      y: footerY + 6,
      size: 8,
      font: ctx.regular,
      color: MUTED,
    });
  }
}

/**
 * `2.4` → `2.4`, `1240` → `1,240`, `1240.5` → `1,240.5`.
 *
 * Grouped for readability but never padded to a fixed precision: these are
 * measurements, not money, and `2.40 tonnes` implies a scale that reported
 * hundredths.
 */
function formatNumber(value: number): string {
  const [whole = '0', fraction] = String(value).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}
