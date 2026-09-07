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
      try {
        const message = await client.messages.create({ to, from, body });
        log.debug({ to, sid: message.sid, status: message.status }, 'sent via Twilio');
      } catch (error) {
        // Twilio error codes worth recognising in a log:
        //   21608 — unverified number on a trial account
        //   21211 — the number is not a valid destination
        log.error({ err: error, to }, 'Twilio message failed');
        throw AppError.dependencyUnavailable('Could not send the SMS');
      }
    },
  };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required when SMS_PROVIDER=twilio`);
  return value;
}
