import type { AuthChannel } from '@plastago/shared';
import { isServiceError, serviceErrorCode } from '@/services/service-error';

/**
 * User-facing copy for the sign-in flow.
 *
 * Kept apart from `lib/error-message.ts` on purpose: these strings need to know
 * things the generic mapper does not — which channel the code went to, how many
 * attempts are left, whether the user is signing in for the first time or being
 * re-prompted mid-task. Generic copy would have to drop all of that and say
 * "authentication failed", which tells nobody anything.
 *
 * The standard being applied: name what happened, and say what to do next.
 */
export interface AuthMessage {
  /** Shown against the field, or as the form-level error. */
  message: string;
  /** Which field to attach it to, when it belongs to one. */
  field?: 'identifier' | 'code';
  /** True when the user has to go back and request a new code. */
  restart?: boolean;
}

export function describeAuthError(error: unknown): AuthMessage {
  const code = serviceErrorCode(error);

  switch (code) {
    case 'IDENTIFIER_UNKNOWN':
      return {
        field: 'identifier',
        message:
          'We don’t recognise that email or mobile. Check it for typos, or ask your site administrator to invite you.',
      };

    case 'ACCOUNT_SUSPENDED':
      return {
        field: 'identifier',
        message: 'That account has been suspended. Call the office on 1300 395 438.',
      };

    case 'CODE_INCORRECT': {
      // The mock and the future API both carry the remaining count on the error,
      // so the screen can warn before the last attempt is spent.
      const remaining = isServiceError(error)
        ? Number(error.fieldErrors.attemptsRemaining ?? Number.NaN)
        : Number.NaN;

      if (Number.isFinite(remaining) && remaining <= 2) {
        return {
          field: 'code',
          message: `That code isn’t right. ${remaining === 1 ? '1 attempt' : `${String(remaining)} attempts`} left before you’ll need a new code.`,
        };
      }

      return { field: 'code', message: 'That code isn’t right. Check the digits and try again.' };
    }

    case 'CODE_EXPIRED':
      return {
        field: 'code',
        message: 'That code has expired — they’re only valid for 5 minutes. Send a new one.',
      };

    case 'CODE_ATTEMPTS_EXCEEDED':
      return {
        restart: true,
        message: 'Too many incorrect attempts. Start again to get a new code.',
      };

    case 'CHALLENGE_NOT_FOUND':
      return {
        restart: true,
        message: 'This sign-in attempt has expired. Start again to get a new code.',
      };

    case 'RESEND_TOO_SOON':
      return { message: 'Hold on a moment before requesting another code.' };

    case 'RATE_LIMITED':
      return {
        field: 'identifier',
        message: 'Too many attempts from this device. Wait a few minutes and try again.',
      };

    case 'OFFLINE':
      return { message: 'You appear to be offline. Check your connection and try again.' };

    case 'TIMEOUT':
      return { message: 'The server didn’t respond. Try again.' };

    default:
      return {
        message:
          'We couldn’t complete that just now. Try again, and call the office if it persists.',
      };
  }
}

/** "We’ve texted a code to •••• ••• 678" — the channel is worth naming. */
export function codeSentMessage(channel: AuthChannel, sentTo: string): string {
  return channel === 'sms'
    ? `We’ve texted a code to ${sentTo}`
    : `We’ve emailed a code to ${sentTo}`;
}

export function codeSentHint(channel: AuthChannel): string {
  return channel === 'sms'
    ? 'It should arrive within a few seconds. Check your messages.'
    : 'It should arrive within a minute. Check your junk folder if it doesn’t.';
}
