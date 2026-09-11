import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { createGraphMailer } from './graph-mailer.js';
import { createTwilioSmsSender } from './twilio-sms.js';

const log = logger.child({ module: 'messaging' });

/**
 * A file travelling with an email.
 *
 * ⚠️ Held as BYTES, not as a storage key or a URL. A mailer that resolved a
 * key would need storage credentials and could fail at send time with the
 * message half-built; and a link is not an attachment — a builder's accounts
 * department files the PDF, it does not click through to fetch one.
 */
export interface OutboundAttachment {
  /** What it is called in the recipient's inbox — `Invoice PGA-104312.pdf`. */
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface OutboundEmail {
  to: string;
  subject: string;
  /** Plain text alternative. Always sent — some clients prefer it, all accept it. */
  text: string;
  html: string;
  /**
   * Files to attach. Omitted on almost every message.
   *
   * ⚠️ M365 caps a message at roughly 25MB after base64 expansion, which
   * inflates bytes by about a third. An invoice PDF is a few tens of
   * kilobytes, so the cap is nowhere near — but a caller attaching job photos
   * would reach it, and the mailer refuses rather than letting Graph reject
   * the whole send.
   */
  attachments?: readonly OutboundAttachment[];
}

/**
 * The most a single message may carry, before base64.
 *
 * 18MB rather than 25: base64 adds ~33%, so this lands just under the real
 * limit with room for the body and headers.
 */
export const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;

export interface OutboundSms {
  /**
   * The recipient in PlastaGo's own storage form — Australian local,
   * `0412345678` (see `normaliseMobile`).
   *
   * ⚠️ NOT E.164. Each provider formats for its own vendor: Twilio converts to
   * `+61…` because it rejects anything else with error 21211, and the stub
   * prints what it was given so the console matches what is on screen
   * everywhere else in the app.
   */
  to: string;
  body: string;
}

/**
 * Outbound channels, behind an interface (I5 · I2).
 *
 * ── Why an interface for two vendors we have already chosen ─────────────────
 * Not for vendor portability — that is a benefit, not the reason. The reason is
 * that the sign-in flow had to be buildable and testable before either account
 * existed, and a stub that logs the code is the only way to walk the whole path
 * on a laptop. The interface also means the auth service has no idea whether a
 * message was really sent, which is exactly how much it should know.
 *
 * Selecting a provider is `MAIL_PROVIDER` / `SMS_PROVIDER` plus credentials.
 * Never a code change (§8).
 */
export interface Mailer {
  /** For logs and `/readyz`, so it is obvious which provider is live. */
  readonly name: string;
  send: (email: OutboundEmail) => Promise<void>;
}

export interface SmsSender {
  readonly name: string;
  send: (sms: OutboundSms) => Promise<void>;
}

/**
 * Prints the message to the console instead of sending it.
 *
 * ── Why this writes to STDERR and not through the logger alone ──────────────
 * The point of this provider is that a developer can read the code and sign in,
 * so the one thing it must not do is fail to appear — and a log line can fail
 * to appear for ordinary reasons: someone raises `LOG_LEVEL` to `warn`, or
 * pipes stdout into a JSON tool that renders a multi-line message unreadably.
 *
 * A direct write is immune to both. stderr rather than stdout because this is
 * an operator notice, not application output: it keeps structured logs on
 * stdout clean enough to pipe, which is where they are meant to go.
 *
 * The structured line is still emitted alongside it, so there is a machine
 * record that a send happened. The code is unredacted deliberately — hiding it
 * would defeat the provider — and `env.ts` refuses to boot with `stub` in
 * production, which is the guard that actually matters.
 */
function printBox(title: string, lines: readonly string[]): void {
  const width = 62;
  const body = lines.map((line) => `│ ${line}`).join('\n');
  process.stderr.write(
    `\n┌─ ${title} ${'─'.repeat(Math.max(0, width - title.length - 4))}\n` +
      `${body}\n` +
      `└${'─'.repeat(width - 1)}\n\n`,
  );
}

/**
 * The sign-in code, on its own, impossible to miss.
 *
 * ── Why this is separate from the message box above ───────────────────────
 * The stub already printed the whole email, and the code was in it — on line
 * four, in a sentence, directly beneath a wall of request logging. It was
 * technically visible and practically unfindable, which is the same as absent
 * when somebody is trying to sign in.
 *
 * So the code gets its own banner: spaced digits, blank lines either side, and
 * nothing else on the line. Printed to stderr like the box, so piping stdout to
 * a file still leaves it on the terminal.
 */
function printSignInCode(to: string, code: string): void {
  const spaced = code.split('').join(' ');

  process.stderr.write(
    `\n${'═'.repeat(62)}\n` +
      `  SIGN-IN CODE for ${to}\n\n` +
      `      ${spaced}\n\n` +
      `${'═'.repeat(62)}\n\n`,
  );
}

/**
 * Pulls the code out of an outbound message.
 *
 * ⚠️ Deliberately narrow: exactly six digits, standing alone. Matching loosely
 * would print a postcode or an invoice number as if it were a code, and a
 * wrong code shown confidently is worse than none.
 *
 * Reading it back out of the copy rather than threading it through every send
 * signature keeps the code out of the `Mailer` interface — the real providers
 * have no business knowing which of their messages is an OTP.
 */
function extractCode(text: string): string | null {
  const match = /(?<![0-9])([0-9]{6})(?![0-9])/.exec(text);
  return match?.[1] ?? null;
}

function createStubMailer(): Mailer {
  return {
    name: 'stub',
    send({ to, subject, text, attachments }) {
      log.info(
        { to, subject, provider: 'stub', attachments: attachments?.length ?? 0 },
        'email not sent (MAIL_PROVIDER=stub)',
      );
      printBox('EMAIL — not sent (MAIL_PROVIDER=stub)', [
        `to      : ${to}`,
        `subject : ${subject}`,
        /*
         * Attachments are NAMED in the stub output, not silently dropped.
         *
         * "Did the invoice actually carry its PDF?" is the thing being
         * developed, and a stub that printed the body alone would answer it
         * the same way whether the attachment was built or not.
         */
        ...(attachments && attachments.length > 0
          ? attachments.map(
              (attachment) =>
                `attach  : ${attachment.filename} (${String(Math.round(attachment.content.byteLength / 1024))} KB, ${attachment.contentType})`,
            )
          : []),
        '',
        ...text.split('\n'),
      ]);

      // The banner goes LAST so it is the final thing on the terminal — the
      // one place somebody signing in will actually look.
      const code = extractCode(text);
      if (code) printSignInCode(to, code);

      return Promise.resolve();
    },
  };
}

function createStubSmsSender(): SmsSender {
  return {
    name: 'stub',
    send({ to, body }) {
      log.info({ to, provider: 'stub' }, 'SMS not sent (SMS_PROVIDER=stub)');
      printBox('SMS — not sent (SMS_PROVIDER=stub)', [`to   : ${to}`, `body : ${body}`]);

      // A driver signs in by SMS (§9 A2), so the same banner matters here.
      const code = extractCode(body);
      if (code) printSignInCode(to, code);

      return Promise.resolve();
    },
  };
}

/**
 * Built once at boot, not per message — a Graph credential caches its access
 * token, and rebuilding the client would throw that away on every send.
 */
let mailer: Mailer | undefined;
let smsSender: SmsSender | undefined;

export function getMailer(): Mailer {
  mailer ??= env.MAIL_PROVIDER === 'graph' ? createGraphMailer() : createStubMailer();
  return mailer;
}

export function getSmsSender(): SmsSender {
  smsSender ??= env.SMS_PROVIDER === 'twilio' ? createTwilioSmsSender() : createStubSmsSender();
  return smsSender;
}

/** Test seam: swap in a recording double without touching the environment. */
export function setMessagingProvidersForTests(overrides: {
  mailer?: Mailer;
  smsSender?: SmsSender;
}): void {
  if (overrides.mailer) mailer = overrides.mailer;
  if (overrides.smsSender) smsSender = overrides.smsSender;
}

export function resetMessagingProviders(): void {
  mailer = undefined;
  smsSender = undefined;
}
