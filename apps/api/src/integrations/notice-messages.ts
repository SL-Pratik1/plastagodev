import { ROLE_LABELS, type Role } from '@plastago/shared';
import { env } from '../config/env.js';
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

/** The sign-in screen — where every invitation points. */
export function signInUrl(): string {
  return `${env.PUBLIC_APP_URL}/auth/sign-in`;
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
  const url = signInUrl();
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
      `Sign in at ${signInUrl()} with this mobile — we text you a code. No password.`,
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
  const url = signInUrl();

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
  const url = `${env.PUBLIC_APP_URL}/portal/invoices`;
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
      (context.poNumber ? `. Your purchase order: <strong>${escapeHtml(context.poNumber)}</strong>` : '') +
      (context.jobNumber ? `. Pickup: job #${escapeHtml(String(context.jobNumber))}` : ''),
    emailButton(url, 'View the invoice'),
    'Questions about this invoice? Reply to this email or call <strong>1300 395 438</strong>.',
  ]);

  return { to, subject: `${number} — ${context.accountName} — $${context.totalIncGst}`, text, html };
}

/* ── Job updates (M8.1 · M8.2) ───────────────────────────────────────────── */

export interface JobNoticeContext {
  jobNumber: number;
  siteName: string;
  /** Formatted for a person — "Tue 12 Sept", not an ISO date. */
  when: string;
  accountName: string;
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
  const url = `${env.PUBLIC_APP_URL}/portal/jobs`;

  const text = [
    `${context.siteName} — plasterboard pickup booked for ${context.when}.`,
    '',
    `Job #${String(context.jobNumber)} for ${context.accountName}.`,
    '',
    'Please have the pile stacked and clear of cars, and the gate accessible.',
    '',
    `Track it here: ${url}`,
  ].join('\n');

  const html = emailShell([
    `<strong>${escapeHtml(context.siteName)}</strong> — plasterboard pickup booked for ` +
      `<strong>${escapeHtml(context.when)}</strong>.`,
    `Job #${escapeHtml(String(context.jobNumber))} for ${escapeHtml(context.accountName)}.`,
    'Please have the pile stacked and clear of cars, and the gate accessible.',
    emailButton(url, 'Track this pickup'),
  ]);

  return { to, subject: `Pickup booked — ${context.siteName}, ${context.when}`, text, html };
}

export function buildJobBookedSms(to: string, context: JobNoticeContext): OutboundSms {
  const brand = env.OTP_SENDER_NAME;

  return {
    to,
    body:
      `${brand}: pickup booked for ${context.siteName} on ${context.when}. ` +
      `Job #${String(context.jobNumber)}. Please keep the pile clear and the gate accessible.`,
  };
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
  const url = `${env.PUBLIC_APP_URL}/portal/jobs`;

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
  const url = `${env.PUBLIC_APP_URL}/portal/jobs/${context.jobId}`;

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
  const brand = env.OTP_SENDER_NAME;

  return {
    to,
    body:
      `${brand}: is ${context.siteName} ready for tomorrow's pickup? ` +
      `If not, move it here: ${env.PUBLIC_APP_URL}/portal/jobs/${context.jobId}`,
  };
}
