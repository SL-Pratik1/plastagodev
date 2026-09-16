import { toE164Mobile } from '@plastago/shared';
import { env } from '../config/env.js';
import { AppError } from '../lib/app-error.js';
import { logger } from '../lib/logger.js';
import type { OutboundSms, SmsSender } from './messaging.js';

const log = logger.child({ module: 'clicksend-sms' });

const SEND_URL = 'https://rest.clicksend.com/v3/sms/send';

/**
 * Ten seconds. A sign-in code is worthless if it arrives after the person has
 * given up and tapped "resend", and the caller is holding a request open while
 * this runs. Long enough for a slow round trip, short enough that a hung vendor
 * does not hold a driver on the sign-in screen.
 */
const SEND_TIMEOUT_MS = 10_000;

/**
 * SMS through ClickSend (I2).
 *
 * This is the primary sign-in channel for drivers and site supervisors (§9 A2)
 * — people on building sites who will never remember a password — so a failure
 * here is a failure to let someone start work, not a missed notification.
 *
 * ── Why a plain fetch and not the vendor SDK ───────────────────────────────
 * ClickSend publishes a generated `clicksend` npm client. It is a wrapper over
 * two HTTP calls, carries its own request library, and would be the only
 * integration here that does not use `fetch` — `graph-mailer`, `google-maps`
 * and `xero` are all hand-rolled against the REST API for the same reason. A
 * dependency earns its place by removing real work; this one does not.
 *
 * ── Why ClickSend and not Twilio ───────────────────────────────────────────
 * Twilio ships with its destination countries switched off by default and wants
 * a number provisioned in each; PlastaGo texts Australian mobiles exclusively,
 * and every attempt failed on geo permissions (21659) before a single message
 * was ever delivered. ClickSend is an Australian carrier, so AU delivery and an
 * AU sender id are the default rather than a support ticket.
 */
export function createClickSendSmsSender(): SmsSender {
  const username = required(env.CLICKSEND_USERNAME, 'CLICKSEND_USERNAME');
  const apiKey = required(env.CLICKSEND_API_KEY, 'CLICKSEND_API_KEY');
  const from = required(env.CLICKSEND_FROM, 'CLICKSEND_FROM');

  /*
   * HTTP Basic, built once. The credential is static — there is no token to
   * refresh and nothing to cache beyond this string, which is why this provider
   * has none of the token plumbing `graph-mailer` needs.
   */
  const authorization = `Basic ${Buffer.from(`${username}:${apiKey}`).toString('base64')}`;

  return {
    name: 'clicksend',

    async send({ to, body }: OutboundSms): Promise<void> {
      /*
       * ⚠️ ClickSend requires E.164.
       *
       * PlastaGo stores and displays mobiles in Australian local form
       * (`0412345678`) because that is what people type and what the unique
       * index on the users collection is built from — see `normaliseMobile`.
       * Handing that straight over fails EVERY driver sign-in, which is the one
       * thing a driver cannot work around: SMS is their only way in.
       *
       * Converted here rather than at each of the eight call sites that send an
       * SMS, because "format the address the way this vendor demands" is a
       * property of the vendor, not of the message. The stub deliberately does
       * NOT convert — a developer reading a local number off the console is
       * reading the number as it appears everywhere else in the app.
       */
      const recipient = toE164Mobile(to);

      let response: Response;

      try {
        response = await fetch(SEND_URL, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body: JSON.stringify({
            messages: [
              {
                // Free-text tag ClickSend shows in its own reporting; it is how
                // someone reading their dashboard tells our traffic apart from
                // anything else billed to the account.
                source: 'plastago',
                from,
                to: recipient,
                body,
              },
            ],
          }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (error) {
        // A timeout or a DNS failure — no HTTP answer at all, so there is no
        // body to read and nothing to say beyond "it did not go".
        log.error({ err: error, to: recipient }, 'ClickSend request failed');
        throw AppError.dependencyUnavailable('Could not send the SMS');
      }

      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        /*
         * Account-level problems land here:
         *   401 — wrong username or API key
         *   403 — the account has no credit
         *   429 — rate limited
         */
        log.error(
          { status: response.status, detail: describe(payload), to: recipient },
          'ClickSend rejected the request',
        );
        throw AppError.dependencyUnavailable('Could not send the SMS');
      }

      /*
       * ⚠️ A 200 DOES NOT MEAN SENT.
       *
       * This is the one real difference from Twilio, which signals a bad
       * recipient with an HTTP error. ClickSend accepts the batch, answers 200,
       * and reports each message's fate inside `data.messages[]` — so a bad
       * number, a sender id that is not registered, and an empty balance all
       * arrive looking exactly like success. Trusting the status code would
       * have `outbound.service` record `sent` for a message nobody received,
       * and "we definitely texted them" is the worst possible answer for
       * support to be holding.
       *
       * Checked per message rather than on the envelope's `response_code`,
       * because the envelope reports the batch and we care about the one
       * recipient we asked for.
       */
      const status = firstMessageStatus(payload);

      if (status !== 'SUCCESS') {
        // Statuses worth recognising in a log:
        //   INVALID_RECIPIENT    — not a valid destination number
        //   NO_CREDIT            — the account balance is empty
        //   INVALID_SENDER_ID    — the `from` is not approved for this account
        log.error(
          { status: status ?? 'unknown', detail: describe(payload), to: recipient },
          'ClickSend accepted the request but refused the message',
        );
        throw AppError.dependencyUnavailable('Could not send the SMS');
      }

      log.debug({ to: recipient, messageId: firstMessageId(payload) }, 'sent via ClickSend');
    },
  };
}

/* ── Reading the answer ──────────────────────────────────────────────────── */

/**
 * The first entry of `{ data: { messages: [...] } }`.
 *
 * Every step is guarded because this is an external payload: a shape change at
 * the vendor must surface as a failed send with the body in the log, never as a
 * crash inside a notification that some service is awaiting.
 */
function firstMessage(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== 'object' || payload === null) return null;

  const data = (payload as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;

  const messages = (data as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const first: unknown = messages[0];
  return typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : null;
}

function firstMessageStatus(payload: unknown): string | null {
  const status = firstMessage(payload)?.status;
  return typeof status === 'string' ? status : null;
}

function firstMessageId(payload: unknown): string | null {
  const id = firstMessage(payload)?.message_id;
  return typeof id === 'string' ? id : null;
}

/**
 * The response, trimmed for a log line.
 *
 * ⚠️ Truncated at 500 characters. ClickSend echoes the whole batch back, which
 * includes the message body — and the body of an OTP is the code itself. A full
 * dump would put live sign-in codes in the application log.
 */
function describe(payload: unknown): string {
  if (payload === null || payload === undefined) return '';
  try {
    return JSON.stringify(payload).slice(0, 500);
  } catch {
    return '';
  }
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required when SMS_PROVIDER=clicksend`);
  return value;
}
