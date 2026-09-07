import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { createGraphMailer } from './graph-mailer.js';
import { createTwilioSmsSender } from './twilio-sms.js';

const log = logger.child({ module: 'messaging' });

export interface OutboundEmail {
  to: string;
  subject: string;
  /** Plain text alternative. Always sent — some clients prefer it, all accept it. */
  text: string;
  html: string;
}

export interface OutboundSms {
  /** E.164. Normalisation happens before this layer, never inside a provider. */
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

function createStubMailer(): Mailer {
  return {
    name: 'stub',
    send({ to, subject, text }) {
      log.info({ to, subject, provider: 'stub' }, 'email not sent (MAIL_PROVIDER=stub)');
      printBox('EMAIL — not sent (MAIL_PROVIDER=stub)', [
        `to      : ${to}`,
        `subject : ${subject}`,
        '',
        ...text.split('\n'),
      ]);
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
