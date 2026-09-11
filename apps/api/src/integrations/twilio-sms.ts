import { toE164Mobile } from '@plastago/shared';
import Twilio from 'twilio';
import { env } from '../config/env.js';
import { AppError } from '../lib/app-error.js';
import { logger } from '../lib/logger.js';
import type { OutboundSms, SmsSender } from './messaging.js';

const log = logger.child({ module: 'twilio-sms' });

/**
 * SMS through Twilio (I2).
 *
 * This is the primary sign-in channel for drivers and site supervisors (§9 A2)
 * — people on building sites who will never remember a password — so a failure
 * here is a failure to let someone start work, not a missed notification.
 *
 * ⚠️ A Twilio TRIAL account can only message numbers verified in the console.
 * A driver's phone will silently fail until the account is upgraded; the log
 * line below is the only place that will say so.
 */
export function createTwilioSmsSender(): SmsSender {
  const accountSid = required(env.TWILIO_ACCOUNT_SID, 'TWILIO_ACCOUNT_SID');
  const authToken = required(env.TWILIO_AUTH_TOKEN, 'TWILIO_AUTH_TOKEN');
  const from = required(env.TWILIO_FROM, 'TWILIO_FROM');

  const client = Twilio(accountSid, authToken);

  return {
    name: 'twilio',

    async send({ to, body }: OutboundSms): Promise<void> {
      /*
       * ⚠️ Twilio requires E.164 and rejects anything else with 21211.
       *
       * PlastaGo stores and displays mobiles in Australian local form
       * (`0412345678`) because that is what people type and what the unique
       * index on the users collection is built from — see `normaliseMobile`.
       * Handing that straight to Twilio fails EVERY driver sign-in, which is
       * the one thing a driver cannot work around: SMS is their only way in.
       *
       * Converted here rather than at each of the eight call sites that send
       * an SMS, because "format the address the way this vendor demands" is a
       * property of the vendor, not of the message. The stub deliberately does
       * NOT convert — a developer reading a local number off the console is
       * reading the number as it appears everywhere else in the app.
       */
      const recipient = toE164Mobile(to);

      try {
        const message = await client.messages.create({ to: recipient, from, body });
        log.debug({ to: recipient, sid: message.sid, status: message.status }, 'sent via Twilio');
      } catch (error) {
        // Twilio error codes worth recognising in a log:
        //   21608 — unverified number on a trial account
        //   21211 — the number is not a valid destination
        //   21659 — the `from` number cannot send to this country
        log.error({ err: error, to: recipient }, 'Twilio message failed');
        throw AppError.dependencyUnavailable('Could not send the SMS');
      }
    },
  };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required when SMS_PROVIDER=twilio`);
  return value;
}
