import { logger } from '../../lib/logger.js';
import { maskIdentifier } from '../../lib/mask-identifier.js';
import {
  getMailer,
  getSmsSender,
  type OutboundEmail,
  type OutboundSms,
} from '../../integrations/messaging.js';
import { notificationRepository } from './notification.repository.js';

const log = logger.child({ module: 'outbound' });

/**
 * Sending a message to a person outside the office (M8.1 · M8.2 · M8.4).
 *
 * ── Why every send goes through one function ───────────────────────────────
 * Six domains need to send something — an invitation, a lead acknowledgement, a
 * job update, a completion summary, a readiness reminder, an invoice notice —
 * and four rules have to hold identically for all of them:
 *
 *  1. **Email unless the person has none.** Matt's office runs on email, and an
 *     SMS costs money per message. SMS is the fallback that reaches the people
 *     §9 deliberately made mobile-only: drivers and site supervisors, who have
 *     *"no email to check"* on a building site.
 *  2. **Honour the contact's preferences.** `notifyByEmail` / `notifyBySms`
 *     (M8.4) are set per contact because the AP clerk who needs the invoice is
 *     not the site foreman who needs the pickup time.
 *  3. **Never twice.** A reminder sent twice is worse than one sent late — the
 *     customer stops reading them.
 *  4. **Never take the caller down.** A booking that failed because a mail
 *     server was unreachable is a lost job. The send is recorded as failed and
 *     the caller is told, but the work it belongs to still stands.
 *
 * ⚠️ This function never throws. Callers get an outcome to report; they do not
 * get an exception to handle.
 */

export interface NoticeRecipient {
  email: string | null;
  mobile: string | null;
  /**
   * Per-contact preferences (M8.4). `undefined` means nobody has expressed one
   * — the default is to allow, because silence must not mean "unreachable".
   */
  notifyByEmail?: boolean | undefined;
  notifyBySms?: boolean | undefined;
}

export type NoticeOutcome = 'sent' | 'failed' | 'skipped' | 'duplicate';

export interface NoticeResult {
  outcome: NoticeOutcome;
  channel: 'email' | 'sms' | null;
  /** Redacted, safe to log and to show in the console. */
  toMasked: string | null;
  /** Why it did not go, in words an operator can act on. */
  detail: string | null;
}

export interface NoticeRequest {
  /** Which rule raised it — `user-invite`, `job-completed`. */
  event: string;
  /**
   * The once-only handle, e.g. `user-invite:<userId>`. One send per subject per
   * channel, enforced by a unique index.
   */
  subjectKey: string;
  recipient: NoticeRecipient;
  email: (to: string) => OutboundEmail;
  /** Omit where a message genuinely cannot be expressed in 160 characters. */
  sms?: ((to: string) => OutboundSms) | undefined;
  accountId?: string | null;
  jobId?: string | null;
  invoiceId?: string | null;
  /**
   * A deliberate human re-send ("Resend invitation").
   *
   * It bypasses the once-only guard, because a person clicking the button has
   * decided the first attempt did not land. The log still gets a row: the
   * subject key is suffixed so the original attempt is not overwritten and
   * "how many times did we chase them?" stays answerable.
   */
  force?: boolean | undefined;
}

export const outboundService = {
  /**
   * Never throws — see the note above. The outer guard covers the LOG as well
   * as the provider: a message store that is down must not take a booking with
   * it, and an exception escaping here would do exactly that.
   */
  async send(request: NoticeRequest): Promise<NoticeResult> {
    try {
      return await deliver(request);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'send failed';
      log.error({ err: error, event: request.event }, 'outbound send failed outright');
      return { outcome: 'failed', channel: null, toMasked: null, detail };
    }
  },
};

async function deliver(request: NoticeRequest): Promise<NoticeResult> {
  const channel = chooseChannel(request);

  if (channel === null) {
    const detail = describeUnreachable(request);

    // Recorded, not silent: "we never told them" is the answer support needs,
    // and it is invisible unless it is written down.
    await notificationRepository.recordSend({
      event: request.event,
      channel: 'email',
      toMasked: '—',
      subject: '',
      accountId: request.accountId ?? null,
      jobId: request.jobId ?? null,
      invoiceId: request.invoiceId ?? null,
      outcome: 'skipped',
      detail,
      subjectKey: `${request.subjectKey}:skipped`,
    });

    log.warn({ event: request.event, subjectKey: request.subjectKey, detail }, 'nothing sent');
    return { outcome: 'skipped', channel: null, toMasked: null, detail };
  }

  const to = channel === 'email' ? (request.recipient.email ?? '') : (request.recipient.mobile ?? '');
  const toMasked = maskIdentifier(to, channel);

  const message = channel === 'email' ? request.email(to) : request.sms?.(to);
  if (!message) {
    // Unreachable in practice — `chooseChannel` only returns `sms` when a
    // builder exists — but a wrong answer here would send a blank message.
    return { outcome: 'skipped', channel, toMasked, detail: 'no message for this channel' };
  }

  /*
   * A forced resend writes its own row rather than reusing the original's, so
   * the first attempt's outcome survives in the log.
   */
  const subjectKey = request.force
    ? `${request.subjectKey}:resend:${String(Date.now())}`
    : request.subjectKey;

  const claimed = await notificationRepository.claimSend({
    event: request.event,
    channel,
    toMasked,
    subject: channel === 'email' ? (message as OutboundEmail).subject : '',
    accountId: request.accountId ?? null,
    jobId: request.jobId ?? null,
    invoiceId: request.invoiceId ?? null,
    subjectKey,
  });

  if (!claimed) {
    log.debug({ event: request.event, subjectKey }, 'already sent — skipping');
    return { outcome: 'duplicate', channel, toMasked, detail: 'already sent' };
  }

  try {
    if (channel === 'email') await getMailer().send(message as OutboundEmail);
    else await getSmsSender().send(message as OutboundSms);

    log.info({ event: request.event, channel, to: toMasked }, 'message sent');
    return { outcome: 'sent', channel, toMasked, detail: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'send failed';

    await notificationRepository.markSendOutcome(subjectKey, channel, 'failed', detail);

    /*
     * Logged as an error and swallowed. The caller's work — the user that was
     * created, the job that was booked — is already done and correct; losing it
     * because a provider was down would be the worse outcome by far.
     */
    log.error({ err: error, event: request.event, channel, to: toMasked }, 'message failed');
    return { outcome: 'failed', channel, toMasked, detail };
  }
}

/* ── Channel selection ───────────────────────────────────────────────────── */

/**
 * Email first, SMS only where there is no email.
 *
 * A preference of `false` removes a channel; it never promotes the other one
 * past a missing address.
 */
function chooseChannel(request: NoticeRequest): 'email' | 'sms' | null {
  const { email, mobile, notifyByEmail, notifyBySms } = request.recipient;

  if (email && notifyByEmail !== false) return 'email';
  if (mobile && notifyBySms !== false && request.sms) return 'sms';
  return null;
}

/** Which of the three reasons applies, so the log says something useful. */
function describeUnreachable(request: NoticeRequest): string {
  const { email, mobile, notifyByEmail, notifyBySms } = request.recipient;

  if (!email && !mobile) return 'no email or mobile on file';
  if (email && notifyByEmail === false && !mobile) return 'email notifications turned off';
  if (mobile && !request.sms) return 'mobile only, and this message has no SMS form';
  if (mobile && notifyBySms === false) return 'SMS notifications turned off';
  return 'no usable channel';
}
