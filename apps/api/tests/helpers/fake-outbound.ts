import type { OutboundEmail, OutboundSms } from '../../src/integrations/messaging.js';

/**
 * Stand-ins for the two things an outbound message touches: the send log and
 * the provider.
 *
 * ── Why both, and why not mock `outboundService` itself ───────────────────
 * The interesting decisions — email or SMS, send or skip, once or twice — all
 * live INSIDE `outboundService`. Mocking it away would leave the suites
 * asserting that a function they replaced was called, which is a test of the
 * test. So the real service runs, and only its two edges are faked.
 *
 * The log fake keeps a real `Map`, so de-duplication genuinely works: the
 * second claim on a subject that already went out is refused here exactly as
 * the unique index would refuse it in MongoDB.
 *
 * Usage — `vi.mock` is hoisted, so the factory goes inline:
 *
 *   vi.mock('../src/domains/notifications/notification.repository.js', () => ({
 *     notificationRepository: makeFakeNotificationRepository(),
 *   }));
 */

export interface SentMessage {
  channel: 'email' | 'sms';
  to: string;
  subject: string;
  body: string;
}

/** Everything a provider was asked to send during the current test file. */
export const sentMessages: SentMessage[] = [];

/** Every row the send log recorded, in order. */
export const sendLog: Array<{
  event: string;
  channel: 'email' | 'sms';
  toMasked: string;
  subjectKey: string;
  outcome: string;
  detail: string | null;
}> = [];

/** Set to make the provider fail, so the "message did not go" path is real. */
export const providerFailure = { message: null as string | null };

/**
 * Staff a suite can reach directly — a driver texted about their run. Keyed by
 * user id; seed it with `staffContacts.set(id, { … })`.
 */
export const staffContacts = new Map<
  string,
  { id: string; name: string; email: string | null; mobile: string | null }
>();

export function clearOutbound(): void {
  sentMessages.length = 0;
  sendLog.length = 0;
  providerFailure.message = null;
  claims.clear();
  staffContacts.clear();
}

/** subjectKey|channel → the outcome currently recorded against it. */
const claims = new Map<string, string>();

export function makeFakeNotificationRepository(): Record<string, unknown> {
  return {
    claimSend: (input: {
      event: string;
      channel: 'email' | 'sms';
      toMasked: string;
      subjectKey: string;
    }) => {
      const key = `${input.subjectKey}|${input.channel}`;

      // A successful send holds the row; a failed one may be taken over.
      if (claims.get(key) === 'sent') return Promise.resolve(false);

      claims.set(key, 'sent');
      sendLog.push({ ...input, outcome: 'sent', detail: null });
      return Promise.resolve(true);
    },

    markSendOutcome: (
      subjectKey: string,
      channel: 'email' | 'sms',
      outcome: string,
      detail: string | null,
    ) => {
      claims.set(`${subjectKey}|${channel}`, outcome);
      const row = sendLog.find(
        (entry) => entry.subjectKey === subjectKey && entry.channel === channel,
      );
      if (row) {
        row.outcome = outcome;
        row.detail = detail;
      }
      return Promise.resolve();
    },

    recordSend: (input: {
      event: string;
      channel: 'email' | 'sms';
      toMasked: string;
      subjectKey: string;
      outcome: string;
      detail: string | null;
    }) => {
      sendLog.push(input);
      return Promise.resolve(true);
    },

    alreadySent: (subjectKey: string, channel: 'email' | 'sms') =>
      Promise.resolve(claims.get(`${subjectKey}|${channel}`) === 'sent'),

    staffContact: (userId: string) => Promise.resolve(staffContacts.get(userId) ?? null),

    /* The inbox side of the domain, unused by these suites but imported with it. */
    officeRecipients: () => Promise.resolve([]),
    accountAdministrators: () => Promise.resolve([]),
    jobAudience: () => Promise.resolve([]),
    raise: () => Promise.resolve(),
    list: () =>
      Promise.resolve({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } }),
    summary: () => Promise.resolve({ unread: 0, urgent: 0 }),
  };
}

/** Recording providers, so a suite can read the words that were sent. */
export function recordingProviders(): {
  mailer: { name: string; send: (email: OutboundEmail) => Promise<void> };
  smsSender: { name: string; send: (sms: OutboundSms) => Promise<void> };
} {
  return {
    mailer: {
      name: 'recording',
      send: (email: OutboundEmail) => {
        if (providerFailure.message) return Promise.reject(new Error(providerFailure.message));
        sentMessages.push({
          channel: 'email',
          to: email.to,
          subject: email.subject,
          body: email.text,
        });
        return Promise.resolve();
      },
    },
    smsSender: {
      name: 'recording',
      send: (sms: OutboundSms) => {
        if (providerFailure.message) return Promise.reject(new Error(providerFailure.message));
        sentMessages.push({ channel: 'sms', to: sms.to, subject: '', body: sms.body });
        return Promise.resolve();
      },
    },
  };
}
