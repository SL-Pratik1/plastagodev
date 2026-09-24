import { ROLE_LABELS, ROLE_SURFACE, type Role, type Surface } from '@plastago/shared';
import { env, publicUrlFor } from '../config/env.js';
import { emailButton, emailShell, escapeHtml } from './message-html.js';
import type { OutboundEmail, OutboundSms } from './messaging.js';

/**
 * The words people receive from PlastaGo, other than a sign-in code.
 *
 * Kept beside `otp-messages.ts` and away from every service for the same
 * reason: this is copy. It gets revised by whoever is writing to customers that
 * week, and it must be reviewable without reading a state machine.
 *
 * ── The rules these messages follow ───────────────────────────────────────
 *  1. **Say who it is from and why it arrived.** An unexplained message from a
 *     company you deal with is indistinguishable from a scam.
 *  2. **One action, named.** Every message has at most one thing to do, and the
 *     link goes to the screen that does it — never to a generic home page.
 *  3. **Never carry a code or a token.** A link here opens a page that asks the
 *     person to identify themselves; the code follows separately. That is what
 *     keeps a forwarded message harmless.
 *  4. **SMS is one segment.** 160 GSM-7 characters, so it arrives as one
 *     message and is billed once.
 */

/**
 * The sign-in screen — where every invitation points.
 *
 * ⚠️ Takes the recipient's SURFACE, because the surfaces are separate origins
 * (§6A.5) and each has its own sign-in screen. A driver sent to the console's
 * address would be bounced to theirs on arrival, which works but puts an extra
 * redirect and the wrong brand in front of somebody standing on a building
 * site; a supervisor sent there sees an office sign-in, which is the exact
 * thing Matt asked for the split to prevent (29:04).
 *
 * `ROLE_SURFACE` is the mapping when what you hold is a role.
 */
export function signInUrl(surface: Surface): string {
  return `${publicUrlFor(surface)}/auth/sign-in`;
}

/** The customer portal's origin — every `/portal/*` link below is built on it. */
function portal(): string {
  return publicUrlFor('portal');
}

/* ── One SMS, not three ──────────────────────────────────────────────────── */

/*
 * The GSM-7 alphabet. A single character outside it — an em dash, a curly
 * apostrophe, the ² in m² — switches the WHOLE message to UCS-2, where one SMS
 * holds 70 characters instead of 160 and every send is billed two or three
 * times over.
 */
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
/** These cost two characters each. */
const GSM_EXTENDED = '^{}\\[~]|€';

/** Whether `body` goes out as ONE standard SMS: GSM-7 and at most 160 characters. */
export function fitsOneSms(body: string): boolean {
  let length = 0;
  for (const character of body) {
    if (GSM_EXTENDED.includes(character)) length += 2;
    else if (GSM_BASIC.includes(character)) length += 1;
    else return false;
  }
  return length <= 160;
}

/**
 * Typed text made safe for GSM-7 — the characters people's keyboards and
 * address books slip in (curly quotes, dashes, a superscript two).
 */
function smsSafe(text: string): string {
  return text
    .replace(/[‘’‚‛`]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/…/g, '...')
    .replace(/²/g, '2')
    .replace(/\s/g, ' ')
    .replace(/[^\n\r -~£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà€]/g, '');
}

/**
 * The first wording that fits one SMS.
 *
 * Candidates go longest first; the last one should be short enough to always
 * fit. A site name is the usual reason a message overflows, so the fallbacks
 * drop it and keep the job number, which is enough to find the job.
 */
function firstThatFits(candidates: readonly string[]): string {
  return candidates.find(fitsOneSms) ?? candidates[candidates.length - 1] ?? '';
}

export interface InviteContext {
  /** The invited person's name, for the greeting. */
  name: string;
  /** Who set the access up — a real name is what makes this message credible. */
  invitedBy: string;
  role: Role;
  /** The identifier they must enter to get a code. Theirs, not ours. */
  identifier: string;
}

/**
 * "You have been given access" (M1.5).
 *
 * ── Why the identifier is spelled out ─────────────────────────────────────
 * Because sign-in has no username field in the usual sense: the address the
 * account was created against is the ONLY one that will receive a code. A site
 * supervisor who tries their personal email gets the decoy response by design
 * (see `auth.service`), which is indistinguishable from "this product is
 * broken". Naming the identifier in the invitation removes that whole failure.
 */
export function buildInviteEmail(to: string, context: InviteContext): OutboundEmail {
  const brand = env.OTP_SENDER_NAME;
  const url = signInUrl(ROLE_SURFACE[context.role]);
  const role = ROLE_LABELS[context.role];

  const text = [
    `Hello ${context.name},`,
    '',
    `${context.invitedBy} has set up your ${brand} access as ${role}.`,
    '',
    `Sign in here: ${url}`,
    `Enter ${context.identifier} and we will send you a 6-digit code.`,
    '',
    'There is no password to remember, and nothing to install.',
    '',
    `If you were not expecting this, tell the ${brand} office — it means an`,
    'account was created against your address by mistake.',
  ].join('\n');

  const html = emailShell([
    `Hello ${escapeHtml(context.name)},`,
    `${escapeHtml(context.invitedBy)} has set up your ${escapeHtml(brand)} access as ` +
      `<strong>${escapeHtml(role)}</strong>.`,
    emailButton(url, 'Sign in to PlastaGo'),
    `Enter <strong>${escapeHtml(context.identifier)}</strong> and we will send you a ` +
      `6-digit code. There is no password to remember, and nothing to install.`,
    `If you were not expecting this, tell the ${escapeHtml(brand)} office — it means an ` +
      `account was created against your address by mistake.`,
  ]);

  return {
    to,
    subject: `Your ${brand} access is ready`,
    text,
    html,
  };
}

/**
 * The same invitation, for somebody who has no email address.
 *
 * ⚠️ This is the ONLY route to a driver or a site supervisor. §9 makes them
 * SMS-first deliberately — *"a driver on a building site has no email to
 * check"* — so their invitation cannot be an email that is never opened.
 *
 * The link is the whole point: `13.2` calls for zero install friction, *"a site
 * supervisor receives an SMS with a link, taps it, logs in"*. It carries no
 * token, so a forwarded message grants nothing.
 */
export function buildInviteSms(to: string, context: InviteContext): OutboundSms {
  const brand = env.OTP_SENDER_NAME;

  return {
    to,
    body:
      `${brand}: ${context.invitedBy} has set up your access. ` +
      `Sign in at ${signInUrl(ROLE_SURFACE[context.role])} with this mobile — we text you a code. No password.`,
  };
}

/* ── Leads and onboarding (M5 · Journey A) ───────────────────────────────── */

export interface LeadAckContext {
  contactName: string;
  companyName: string;
}

/**
 * "We got your enquiry" (A.4).
 *
 * ── Why only for a website enquiry ────────────────────────────────────────
 * A lead the office typed up while the builder was on the phone has already
 * been acknowledged — by the person they were speaking to. Emailing them "we
 * will call you within one business day" after that call reads as though nobody
 * noticed they had already rung. So this is sent for `enquiry-form` leads,
 * where the enquiry went into a form and silence is the alternative.
 */
export function buildLeadAckEmail(to: string, context: LeadAckContext): OutboundEmail {
  const brand = env.OTP_SENDER_NAME;

  const text = [
    `Hello ${context.contactName},`,
    '',
    `Thanks for your enquiry about plasterboard recycling for ${context.companyName}.`,
    '',
    'Someone from our team will call you within one business day to talk through',
    'volumes, sites and pricing.',
    '',
    `If it is urgent, call us on 1300 395 438.`,
    '',
    `— The ${brand} team`,
  ].join('\n');

  const html = emailShell([
    `Hello ${escapeHtml(context.contactName)},`,
    `Thanks for your enquiry about plasterboard recycling for ` +
      `<strong>${escapeHtml(context.companyName)}</strong>.`,
    'Someone from our team will call you within one business day to talk through volumes, ' +
      'sites and pricing.',
    'If it is urgent, call us on <strong>1300 395 438</strong>.',
  ]);

  return { to, subject: `We have your enquiry, ${context.contactName}`, text, html };
}

export interface WelcomeContext {
  contactName: string;
  legalName: string;
  /** Their account code — the number they quote when they ring the office. */
  customerCode: string;
}

/**
 * "Your account is open" (A.4).
 *
 * ── Why the customer code is in the message ───────────────────────────────
 * Because it is the handle every later conversation uses — on an invoice, on a
 * PO, and on the phone. Putting it in the first message they receive means it
 * is searchable in their own mailbox for the life of the relationship, rather
 * than being something they have to ring up and ask for.
 */
export function buildWelcomeEmail(to: string, context: WelcomeContext): OutboundEmail {
  const brand = env.OTP_SENDER_NAME;
  const url = signInUrl('portal');

  const text = [
    `Hello ${context.contactName},`,
    '',
    `${context.legalName} is now set up with ${brand}.`,
    `Your customer code is ${context.customerCode}.`,
    '',
    `Sign in here: ${url}`,
    `Enter ${to} and we will send you a 6-digit code — there is no password.`,
    '',
    'From the portal you can book a pickup, follow its progress, download',
    'recycling certificates and see your invoices.',
    '',
    `— The ${brand} team`,
  ].join('\n');

  const html = emailShell([
    `Hello ${escapeHtml(context.contactName)},`,
    `<strong>${escapeHtml(context.legalName)}</strong> is now set up with ` +
      `${escapeHtml(brand)}. Your customer code is ` +
      `<strong>${escapeHtml(context.customerCode)}</strong>.`,
    emailButton(url, 'Open your portal'),
    `Enter <strong>${escapeHtml(to)}</strong> and we will send you a 6-digit code — there is ` +
      `no password.`,
    'From the portal you can book a pickup, follow its progress, download recycling ' +
      'certificates and see your invoices.',
  ]);

  return { to, subject: `${context.legalName} is set up with ${brand}`, text, html };
}

/* ── Invoicing (M7.7) ────────────────────────────────────────────────────── */

export interface InvoiceNoticeContext {
  accountName: string;
  invoiceNumber: number;
  totalIncGst: string;
  dueOn: string | null;
  paymentTermsDays: number;
  jobNumber: number | null;
  poNumber: string | null;
}

/**
 * "Your invoice is ready" (M7.7).
 *
 * ── Why this links to the portal instead of attaching a PDF ────────────────
 * Two reasons, one practical and one better than that. The practical one: the
 * mail interface carries no attachments today, and adding them touches the
 * Graph client, the storage layer and the queue that renders the document.
 *
 * The better one: an attachment is a copy that starts going out of date the
 * moment a credit note is raised against it, and an AP clerk chasing a
 * discrepancy is looking at whichever copy is in their inbox. The portal always
 * shows the current position, with the job and its photos behind it.
 *
 * The PO number is included when there is one because an invoice without the
 * builder's PO on it is rejected by their AP system (Matt, 9:56) — seeing it in
 * the covering email is how they know it will not be.
 */
export function buildInvoiceEmail(to: string, context: InvoiceNoticeContext): OutboundEmail {
  const brand = env.OTP_SENDER_NAME;
  const url = `${portal()}/portal/invoices`;
  const number = `INV-${String(context.invoiceNumber)}`;

  const terms = context.dueOn
    ? `Due ${context.dueOn}`
    : `Payment terms ${String(context.paymentTermsDays)} days`;

  const text = [
    `Hello,`,
    '',
    `${number} for ${context.accountName} is ready — $${context.totalIncGst} including GST.`,
    terms + '.',
    ...(context.poNumber ? [`Your purchase order: ${context.poNumber}`] : []),
    ...(context.jobNumber ? [`Pickup: job #${String(context.jobNumber)}`] : []),
    '',
    `See it here: ${url}`,
    '',
    `Questions about this invoice? Reply to this email or call 1300 395 438.`,
    '',
    `— ${brand} accounts`,
  ].join('\n');

  const html = emailShell([
    `<strong>${escapeHtml(number)}</strong> for ${escapeHtml(context.accountName)} is ready — ` +
      `<strong>$${escapeHtml(context.totalIncGst)}</strong> including GST.`,
    escapeHtml(terms) +
      (context.poNumber
        ? `. Your purchase order: <strong>${escapeHtml(context.poNumber)}</strong>`
        : '') +
      (context.jobNumber ? `. Pickup: job #${escapeHtml(String(context.jobNumber))}` : ''),
    emailButton(url, 'View the invoice'),
    'Questions about this invoice? Reply to this email or call <strong>1300 395 438</strong>.',
  ]);

  return {
    to,
    subject: `${number} — ${context.accountName} — $${context.totalIncGst}`,
    text,
    html,
  };
}

/* ── Diversion certificates (M9.5 · F52) ─────────────────────────────────── */

export interface CertificateNoticeContext {
  accountName: string;
  reference: string;
  tonnesDiverted: number;
  areaM2: number | null;
  siteName: string | null;
  jobNumber: number | null;
}

/**
 * "Your Certificate of Recycling is ready" (M9.5).
 *
 * ── Why this one DOES attach the PDF, where the invoice does not ──────────
 * The invoice deliberately links instead of attaching, because an invoice
 * starts going out of date the moment a credit note is raised against it and
 * the portal always shows the current position.
 *
 * A certificate is the opposite kind of document. Its figures are frozen at
 * issue and can never move, so a copy in an inbox can never be stale — and the
 * recipient's whole purpose is to FORWARD it, into a Green Star submission or
 * to their own sustainability consultant. Making them log in to fetch a file
 * they need to send to somebody else is friction for no safety.
 *
 * The link is there as well, because the attachment is what gets lost.
 */
export function buildCertificateEmail(
  to: string,
  context: CertificateNoticeContext,
  pdf: Buffer | null,
): OutboundEmail {
  const brand = env.OTP_SENDER_NAME;
  const url = `${portal()}/portal/certificates`;

  const tonnes = `${String(context.tonnesDiverted)} tonnes`;
  const where = [
    context.siteName,
    context.jobNumber === null ? null : `pickup #${String(context.jobNumber)}`,
  ]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .join(', ');

  const headline =
    where === ''
      ? `${tonnes} of plasterboard waste has been diverted from landfill.`
      : `${tonnes} of plasterboard waste from ${where} has been diverted from landfill.`;

  const text = [
    'Hello,',
    '',
    `Certificate ${context.reference} for ${context.accountName} has been issued.`,
    '',
    headline,
    ...(context.areaM2 === null ? [] : [`Plasterboard collected: ${String(context.areaM2)} m².`]),
    '',
    ...(pdf ? ['The certificate is attached as a PDF.'] : []),
    `You can also download it here: ${url}`,
    '',
    'This certificate can be included in Green Star and NABERS submissions and council',
    'waste management plans. Its figures are fixed and will not change.',
    '',
    `— The ${brand} team`,
  ].join('\n');

  const html = emailShell([
    `Certificate <strong>${escapeHtml(context.reference)}</strong> for ` +
      `${escapeHtml(context.accountName)} has been issued.`,
    escapeHtml(headline) +
      (context.areaM2 === null
        ? ''
        : ` Plasterboard collected: <strong>${escapeHtml(String(context.areaM2))} m²</strong>.`),
    ...(pdf ? ['The certificate is attached to this email as a PDF.'] : []),
    emailButton(url, 'Download the certificate'),
    'This certificate can be included in Green Star and NABERS submissions and council ' +
      'waste management plans. Its figures are fixed and will not change.',
  ]);

  return {
    to,
    subject: `Certificate of Recycling ${context.reference} — ${tonnes} diverted`,
    text,
    html,
    /*
     * ⚠️ Omitted entirely rather than sent empty when the render failed. An
     * empty attachments array makes some clients show a paperclip with nothing
     * behind it, and the covering text already adapts.
     */
    ...(pdf
      ? {
          attachments: [
            {
              filename: `Certificate of Recycling ${context.reference}.pdf`,
              contentType: 'application/pdf',
              content: pdf,
            },
          ],
        }
      : {}),
  };
}

/* ── Job updates (M8.1 · M8.2) ───────────────────────────────────────────── */

export interface JobNoticeContext {
  jobNumber: number;
  siteName: string;
  /**
   * Formatted for a person — "Tue 12 Sept", not an ISO date.
   *
   * On a booking this is the date we will collect BY (the SLA deadline); on a
   * readiness reminder it is the day the truck is booked to come.
   */
  when: string;
  /**
   * The customer's ready date, formatted. When present a booking reads "ready
   * from 24 Sept, collected by 1 Oct" — the deadline on its own read as the
   * day the truck was coming, which it is not.
   */
  readyFrom?: string | undefined;
  accountName: string;
}

/** "Ready from Thu 24 Sept, collected by Thu 1 Oct" — or the old one-date form. */
function collectionWindow(context: JobNoticeContext): string {
  if (!context.readyFrom) return `booked for ${context.when}`;
  if (context.readyFrom === context.when) return `booked for ${context.when}`;
  return `ready from ${context.readyFrom}, collected by ${context.when}`;
}

/**
 * "Your pickup is booked" (M8.1 · F12).
 *
 * ── Why the site is named before anything else ────────────────────────────
 * A supervisor runs several sites and receives messages about all of them. The
 * job number identifies it for us; the site identifies it for them, so it comes
 * first in both the SMS and the subject line.
 */
export function buildJobBookedEmail(to: string, context: JobNoticeContext): OutboundEmail {
  const url = `${portal()}/portal/jobs`;
  const window = collectionWindow(context);

  const text = [
    `${context.siteName} — plasterboard pickup ${window}.`,
    '',
    `Job #${String(context.jobNumber)} for ${context.accountName}.`,
    '',
    'Please have the pile stacked and clear of cars, and the gate accessible.',
    '',
    `Track it here: ${url}`,
  ].join('\n');

  const html = emailShell([
    `<strong>${escapeHtml(context.siteName)}</strong> — plasterboard pickup ` +
      `<strong>${escapeHtml(window)}</strong>.`,
    `Job #${escapeHtml(String(context.jobNumber))} for ${escapeHtml(context.accountName)}.`,
    'Please have the pile stacked and clear of cars, and the gate accessible.',
    emailButton(url, 'Track this pickup'),
  ]);

  const subject = context.readyFrom
    ? `Pickup booked — ${context.siteName}, ready from ${context.readyFrom}`
    : `Pickup booked — ${context.siteName}, ${context.when}`;

  return { to, subject, text, html };
}

export function buildJobBookedSms(to: string, context: JobNoticeContext): OutboundSms {
  const brand = smsSafe(env.OTP_SENDER_NAME);
  const site = smsSafe(context.siteName);
  const window = smsSafe(windowSentence(context));
  const job = `Job #${String(context.jobNumber)}`;

  return {
    to,
    body: firstThatFits([
      `${brand}: pickup booked at ${site}. ${window}. ${job}. Please keep the pile clear and the gate open.`,
      `${brand}: pickup booked at ${site}. ${window}. ${job}.`,
      `${brand}: pickup booked. ${window}. ${job}.`,
    ]),
  };
}

/** The collection window as a sentence of its own, for an SMS. */
function windowSentence(context: JobNoticeContext): string {
  return context.readyFrom && context.readyFrom !== context.when
    ? `Ready from ${context.readyFrom}, collected by ${context.when}`
    : `Collection ${context.when}`;
}

/** "The driver is on the way" — the message that stops the "where are they?" call. */
export function buildJobEnRouteEmail(to: string, context: JobNoticeContext): OutboundEmail {
  const text = [
    `Our driver is on the way to ${context.siteName}.`,
    '',
    `Job #${String(context.jobNumber)}. If access has changed since booking, call`,
    '1300 395 438 now rather than after they arrive.',
  ].join('\n');

  const html = emailShell([
    `Our driver is on the way to <strong>${escapeHtml(context.siteName)}</strong>.`,
    `Job #${escapeHtml(String(context.jobNumber))}. If access has changed since booking, call ` +
      `<strong>1300 395 438</strong> now rather than after they arrive.`,
  ]);

  return { to, subject: `Driver on the way — ${context.siteName}`, text, html };
}

export function buildJobEnRouteSms(to: string, context: JobNoticeContext): OutboundSms {
  const brand = env.OTP_SENDER_NAME;

  return {
    to,
    body:
      `${brand}: our driver is on the way to ${context.siteName} ` +
      `(job #${String(context.jobNumber)}). Access changed? Call 1300 395 438.`,
  };
}

export interface JobCompletedContext extends JobNoticeContext {
  areaM2: number | null;
  weightKg: number | null;
  bagCount: number;
  photoCount: number;
}

/**
 * "It is done, and here is what we took" (M8.2 · F24).
 *
 * ── Why the photos are linked and not attached ────────────────────────────
 * Two reasons. The mail interface carries no attachments today — adding them
 * reaches into the Graph client and the storage layer. More importantly, a
 * photo URL that works in an email has to work for whoever holds the email,
 * which means site photos would be readable by anyone the message was forwarded
 * to. In the portal they sit behind the same account scope as everything else,
 * and the message says how many there are so nobody has to guess whether the
 * driver took any.
 *
 * ⚠️ A `null` area is not zero — see the note in `schemas/jobs.ts`. A line
 * reading "0 m² recovered" on a hand-load stop is wrong in a way the customer
 * will repeat back to you.
 */
export function buildJobCompletedEmail(to: string, context: JobCompletedContext): OutboundEmail {
  const url = `${portal()}/portal/jobs`;

  const recovered = [
    context.areaM2 === null ? null : `${String(context.areaM2)} m²`,
    context.weightKg === null ? null : `${String(Math.round(context.weightKg / 100) / 10)} tonnes`,
    context.bagCount > 0 ? `${String(context.bagCount)} bags` : null,
  ].filter((part): part is string => part !== null);

  const text = [
    `${context.siteName} — pickup complete.`,
    '',
    `Job #${String(context.jobNumber)} for ${context.accountName}.`,
    ...(recovered.length > 0 ? ['', `Recovered: ${recovered.join(' · ')}`] : []),
    ...(context.photoCount > 0
      ? ['', `${String(context.photoCount)} site photos are on the job in your portal.`]
      : []),
    '',
    `See the job: ${url}`,
    '',
    'Recycling certificates for this material are available in the portal under Certificates.',
  ].join('\n');

  const html = emailShell([
    `<strong>${escapeHtml(context.siteName)}</strong> — pickup complete.`,
    `Job #${escapeHtml(String(context.jobNumber))} for ${escapeHtml(context.accountName)}.` +
      (recovered.length > 0
        ? ` Recovered: <strong>${escapeHtml(recovered.join(' · '))}</strong>.`
        : ''),
    ...(context.photoCount > 0
      ? [`${escapeHtml(String(context.photoCount))} site photos are on the job in your portal.`]
      : []),
    emailButton(url, 'See the job and its photos'),
    'Recycling certificates for this material are available in the portal under Certificates.',
  ]);

  return { to, subject: `Pickup complete — ${context.siteName}`, text, html };
}

export function buildJobCompletedSms(to: string, context: JobCompletedContext): OutboundSms {
  const brand = env.OTP_SENDER_NAME;
  const area = context.areaM2 === null ? '' : ` ${String(context.areaM2)} m² collected.`;

  return {
    to,
    body: `${brand}: pickup at ${context.siteName} is complete.${area} Photos and details are in your portal.`,
  };
}

/* ── The readiness reminder (M8.3) ───────────────────────────────────────── */

export interface ReadinessContext extends JobNoticeContext {
  /** Deep link to this job's own screen — the tap-through (M8.3). */
  jobId: string;
}

/**
 * "Is the site ready for tomorrow?" — the direct attack on futile pickups.
 *
 * ── Why a link and not a reply ────────────────────────────────────────────
 * Matt framed this as replying to an SMS (F65). Inbound SMS parsing is
 * ambiguous — "no", "not tomorrow", "Wed instead" all have to be understood —
 * and a misread answer either sends a truck to a site that is not ready or
 * cancels one that is. A tap-through opens the job's own screen: nothing to
 * parse, fully audited, and identical for email and SMS.
 */
export function buildReadinessEmail(to: string, context: ReadinessContext): OutboundEmail {
  const url = `${portal()}/portal/jobs/${context.jobId}`;

  const text = [
    `Is ${context.siteName} ready for tomorrow's pickup?`,
    '',
    `We are booked for ${context.when} — job #${String(context.jobNumber)}.`,
    '',
    'If the pile is stacked and accessible, there is nothing to do.',
    `If it is not ready, move the date here: ${url}`,
    '',
    'A truck that arrives to a site that is not ready still has to be charged for,',
    'so it is worth thirty seconds now.',
  ].join('\n');

  const html = emailShell([
    `Is <strong>${escapeHtml(context.siteName)}</strong> ready for tomorrow's pickup?`,
    `We are booked for <strong>${escapeHtml(context.when)}</strong> — job ` +
      `#${escapeHtml(String(context.jobNumber))}.`,
    'If the pile is stacked and accessible, there is nothing to do.',
    emailButton(url, 'Not ready — move the date'),
    'A truck that arrives to a site that is not ready still has to be charged for, so it is ' +
      'worth thirty seconds now.',
  ]);

  return { to, subject: `Ready for tomorrow? ${context.siteName}`, text, html };
}

export function buildReadinessSms(to: string, context: ReadinessContext): OutboundSms {
  const brand = smsSafe(env.OTP_SENDER_NAME);
  const site = smsSafe(context.siteName);
  const url = `${portal()}/portal/jobs/${context.jobId}`;
  const job = `job #${String(context.jobNumber)}`;

  return {
    to,
    // The link is the point of the message, so it is never the part dropped.
    body: firstThatFits([
      `${brand}: is ${site} ready for tomorrow's pickup? If not, move it here: ${url}`,
      `${brand}: is the site for ${job} ready for tomorrow's pickup? If not: ${url}`,
      `${brand}: ${job} pickup is tomorrow. Not ready? ${url}`,
    ]),
  };
}

/* ── Messages on a pickup (M2.11) ────────────────────────────────────────── */

export interface JobMessageContext {
  jobId: string;
  jobNumber: number;
  siteName: string;
  accountName: string;
  /** Who wrote it, as the thread shows them. */
  author: string;
  /** The message, as typed. */
  body: string;
}

/**
 * The message itself, set apart from the sentence that introduces it.
 *
 * Escaped, with line breaks kept as `<br>` rather than left to `pre-wrap`,
 * which some desktop mail clients ignore.
 */
function quotedMessage(body: string): string {
  return (
    '<span style="display:block;padding:12px 16px;border-left:3px solid #c9d3c4;' +
    `background:#f5f7f4;border-radius:4px">${escapeHtml(body).replace(/\r?\n/g, '<br>')}</span>`
  );
}

/**
 * "The office wrote to you about a pickup" (M2.11).
 *
 * ── Why the whole message is in the email ─────────────────────────────────
 * The point of emailing is that the customer can read it without signing in —
 * a new gate time or a question about the pile is exactly what they need on
 * their phone. The words are the office's own, written to them.
 *
 * ── Why it asks for the reply in the portal ───────────────────────────────
 * An emailed reply lands in a mailbox, not on the job: the office would read
 * it without the pickup it is about, and the thread on the job would be
 * missing half the conversation. The button opens the thread itself.
 */
export function buildJobMessageToCustomerEmail(
  to: string,
  context: JobMessageContext,
): OutboundEmail {
  const url = `${portal()}/portal/jobs/${context.jobId}#messages`;
  const job = `job #${String(context.jobNumber)}`;

  const text = [
    `${context.author} at PlastaGo wrote about ${context.siteName} (${job}):`,
    '',
    context.body,
    '',
    `Reply in the portal so it stays with the pickup: ${url}`,
  ].join('\n');

  const html = emailShell([
    `<strong>${escapeHtml(context.author)}</strong> at PlastaGo wrote about ` +
      `<strong>${escapeHtml(context.siteName)}</strong> (${escapeHtml(job)}):`,
    quotedMessage(context.body),
    emailButton(url, 'Reply in the portal'),
    'Please reply in the portal rather than to this email, so your answer stays with the pickup.',
  ]);

  return { to, subject: `Message about ${context.siteName} — ${job}`, text, html };
}

/**
 * "A customer wrote about a pickup" — the office's copy (M2.11).
 *
 * Links to the job's Customer thread in the console, where the reply belongs.
 */
export function buildJobMessageToOfficeEmail(to: string, context: JobMessageContext): OutboundEmail {
  const url = `${publicUrlFor('admin')}/admin/jobs/${context.jobId}?tab=comments&thread=customer`;
  const job = `job #${String(context.jobNumber)}`;

  const text = [
    `${context.author} at ${context.accountName} wrote about ${context.siteName} (${job}):`,
    '',
    context.body,
    '',
    `Answer on the job: ${url}`,
  ].join('\n');

  const html = emailShell([
    `<strong>${escapeHtml(context.author)}</strong> at ${escapeHtml(context.accountName)} wrote ` +
      `about <strong>${escapeHtml(context.siteName)}</strong> (${escapeHtml(job)}):`,
    quotedMessage(context.body),
    emailButton(url, 'Answer on the job'),
  ]);

  return { to, subject: `Message from ${context.accountName} — ${job}`, text, html };
}

/* ── When a pickup does not go ahead (M2.4 · M2.6) ───────────────────────── */

export interface JobFutileContext extends JobNoticeContext {
  jobId: string;
  /** Why the driver could not collect, in words — "Site not ready". */
  reason: string;
}

/**
 * "We could not collect today."
 *
 * ── Why the customer is told the same day ─────────────────────────────────
 * A futile pickup carries a fee, and until now the first the customer heard of
 * it was the invoice — weeks later, with nobody on site remembering the day.
 * Telling them while it is still fresh is what turns a dispute into "yes, the
 * pile was not ready".
 *
 * ⚠️ No amount. Whether the fee stands is the office's decision on the futile
 * review, and a figure in a text is a figure the customer argues with before
 * anybody has rung them.
 */
export function buildJobFutileEmail(to: string, context: JobFutileContext): OutboundEmail {
  const url = `${portal()}/portal/jobs/${context.jobId}`;
  const job = `Job #${String(context.jobNumber)}`;

  const text = [
    `We could not collect the plasterboard at ${context.siteName} today.`,
    '',
    `Reason: ${context.reason}.`,
    `${job} for ${context.accountName}.`,
    '',
    'The office will be in touch to book a new day. If the site is ready now, call',
    '1300 395 438.',
    '',
    `See the job: ${url}`,
  ].join('\n');

  const html = emailShell([
    `We could not collect the plasterboard at <strong>${escapeHtml(context.siteName)}</strong> today.`,
    `Reason: <strong>${escapeHtml(context.reason)}</strong>. ${escapeHtml(job)} for ` +
      `${escapeHtml(context.accountName)}.`,
    'The office will be in touch to book a new day. If the site is ready now, call ' +
      '<strong>1300 395 438</strong>.',
    emailButton(url, 'See the job'),
  ]);

  return { to, subject: `We could not collect today — ${context.siteName}`, text, html };
}

export function buildJobFutileSms(to: string, context: JobFutileContext): OutboundSms {
  const brand = smsSafe(env.OTP_SENDER_NAME);
  const site = smsSafe(context.siteName);
  const reason = smsSafe(context.reason);
  const job = `job #${String(context.jobNumber)}`;

  return {
    to,
    body: firstThatFits([
      `${brand}: we could not collect at ${site} today (${reason}). The office will call you to rebook. Ph 1300 395 438`,
      `${brand}: we could not collect ${job} today (${reason}). The office will call you to rebook. Ph 1300 395 438`,
      `${brand}: we could not collect ${job} today. The office will call you to rebook.`,
    ]),
  };
}

/** "Your pickup has been cancelled." */
export function buildJobCancelledEmail(to: string, context: JobNoticeContext): OutboundEmail {
  const job = `Job #${String(context.jobNumber)}`;

  const text = [
    `The plasterboard pickup at ${context.siteName} has been cancelled.`,
    '',
    `${job} for ${context.accountName}. Nobody will come to the site for it.`,
    '',
    'If this is a mistake, call 1300 395 438.',
  ].join('\n');

  const html = emailShell([
    `The plasterboard pickup at <strong>${escapeHtml(context.siteName)}</strong> has been ` +
      '<strong>cancelled</strong>.',
    `${escapeHtml(job)} for ${escapeHtml(context.accountName)}. Nobody will come to the site for it.`,
    'If this is a mistake, call <strong>1300 395 438</strong>.',
  ]);

  return { to, subject: `Pickup cancelled — ${context.siteName}`, text, html };
}

export function buildJobCancelledSms(to: string, context: JobNoticeContext): OutboundSms {
  const brand = smsSafe(env.OTP_SENDER_NAME);
  const site = smsSafe(context.siteName);
  const job = `job #${String(context.jobNumber)}`;

  return {
    to,
    body: firstThatFits([
      `${brand}: the pickup at ${site} (${job}) has been cancelled. If this is wrong, call 1300 395 438.`,
      `${brand}: pickup ${job} has been cancelled. If this is wrong, call 1300 395 438.`,
    ]),
  };
}

/** "Your pickup has a new date." */
export function buildJobMovedEmail(
  to: string,
  context: JobNoticeContext & { jobId: string },
): OutboundEmail {
  const url = `${portal()}/portal/jobs/${context.jobId}`;
  const window = collectionWindow(context);
  const job = `Job #${String(context.jobNumber)}`;

  const text = [
    `The plasterboard pickup at ${context.siteName} has a new date: ${window}.`,
    '',
    `${job} for ${context.accountName}.`,
    '',
    `Track it here: ${url}`,
  ].join('\n');

  const html = emailShell([
    `The plasterboard pickup at <strong>${escapeHtml(context.siteName)}</strong> has a new date: ` +
      `<strong>${escapeHtml(window)}</strong>.`,
    `${escapeHtml(job)} for ${escapeHtml(context.accountName)}.`,
    emailButton(url, 'Track this pickup'),
  ]);

  return { to, subject: `Pickup date changed — ${context.siteName}`, text, html };
}

export function buildJobMovedSms(to: string, context: JobNoticeContext): OutboundSms {
  const brand = smsSafe(env.OTP_SENDER_NAME);
  const site = smsSafe(context.siteName);
  const window = smsSafe(windowSentence(context));
  const job = `Job #${String(context.jobNumber)}`;

  return {
    to,
    body: firstThatFits([
      `${brand}: new date for the pickup at ${site}. ${window}. ${job}.`,
      `${brand}: new pickup date. ${window}. ${job}.`,
    ]),
  };
}

/* ── To a driver, about a job on their run ───────────────────────────────── */

export interface DriverJobContext {
  jobNumber: number;
  siteName: string;
  /** The run's day, formatted — "Fri 25 Sept". */
  runDay: string;
  /** Only on a move: the new ready date, formatted. */
  newReadyFrom?: string | undefined;
}

/**
 * "Do not collect it." — the office cancelled a job that is on your run.
 *
 * ⚠️ SMS first, whatever else is on file. A driver reads a text in the cab; an
 * email is found at the end of the day, after the wasted trip. The service only
 * falls back to email for a driver with no mobile at all.
 */
export function buildDriverJobCancelledSms(to: string, context: DriverJobContext): OutboundSms {
  const brand = smsSafe(env.OTP_SENDER_NAME);
  const site = smsSafe(context.siteName);
  const job = `job #${String(context.jobNumber)}`;
  const day = smsSafe(context.runDay);

  return {
    to,
    body: firstThatFits([
      `${brand}: ${job} at ${site} on your ${day} run is CANCELLED. Do not collect it.`,
      `${brand}: ${job} on your ${day} run is CANCELLED. Do not collect it.`,
    ]),
  };
}

export function buildDriverJobCancelledEmail(to: string, context: DriverJobContext): OutboundEmail {
  const sms = buildDriverJobCancelledSms(to, context).body;
  return {
    to,
    subject: `Job #${String(context.jobNumber)} cancelled — do not collect`,
    text: sms,
    html: emailShell([escapeHtml(sms)]),
  };
}

/** The job's date moved past the run's day, so it came off the driver's run. */
export function buildDriverJobMovedSms(to: string, context: DriverJobContext): OutboundSms {
  const brand = smsSafe(env.OTP_SENDER_NAME);
  const site = smsSafe(context.siteName);
  const job = `job #${String(context.jobNumber)}`;
  const day = smsSafe(context.runDay);
  const moved = context.newReadyFrom ? ` has moved to ${smsSafe(context.newReadyFrom)} and` : '';

  return {
    to,
    body: firstThatFits([
      `${brand}: ${job} at ${site}${moved} is off your ${day} run. Do not collect it.`,
      `${brand}: ${job}${moved} is off your ${day} run. Do not collect it.`,
      `${brand}: ${job} is off your ${day} run. Do not collect it.`,
    ]),
  };
}

export function buildDriverJobMovedEmail(to: string, context: DriverJobContext): OutboundEmail {
  const sms = buildDriverJobMovedSms(to, context).body;
  return {
    to,
    subject: `Job #${String(context.jobNumber)} taken off your run — do not collect`,
    text: sms,
    html: emailShell([escapeHtml(sms)]),
  };
}

/* ── Asking for a purchase order (M7.3) ──────────────────────────────────── */

export interface PoRequestContext {
  accountName: string;
  /** As printed on the invoice, prefix included — "PGA-104234" or "104234". */
  invoiceNumber: string;
  totalIncGst: string;
  /** What the PO is FOR — "Contamination — timber offcuts". */
  chargeSummary: string;
  jobNumber: number | null;
  siteName: string | null;
}

/**
 * "We need a purchase order for this invoice."
 *
 * Sent from the awaiting-PO queue's "Send reminder". It names what the PO is
 * for, because "we need a PO for invoice 104234" is not something an accounts
 * clerk can raise without asking what it covers.
 */
export function buildPoRequestEmail(to: string, context: PoRequestContext): OutboundEmail {
  const brand = env.OTP_SENDER_NAME;
  const where = [
    context.jobNumber === null ? null : `job #${String(context.jobNumber)}`,
    context.siteName,
  ]
    .filter((part): part is string => part !== null && part.trim() !== '' && part !== '—')
    .join(', ');

  const text = [
    'Hello,',
    '',
    `We need a purchase order for invoice ${context.invoiceNumber} before we can send it.`,
    '',
    `${context.chargeSummary} — $${context.totalIncGst} including GST.`,
    ...(where ? [`For ${where}.`] : []),
    '',
    'Please reply to this email with the PO number, or call 1300 395 438.',
    '',
    `— ${brand} accounts`,
  ].join('\n');

  const html = emailShell([
    `We need a purchase order for invoice <strong>${escapeHtml(context.invoiceNumber)}</strong> ` +
      'before we can send it.',
    `${escapeHtml(context.chargeSummary)} — <strong>$${escapeHtml(context.totalIncGst)}</strong> ` +
      'including GST.' +
      (where ? ` For ${escapeHtml(where)}.` : ''),
    'Please reply to this email with the PO number, or call <strong>1300 395 438</strong>.',
  ]);

  return {
    to,
    subject: `Purchase order needed — invoice ${context.invoiceNumber} — ${context.accountName}`,
    text,
    html,
  };
}
