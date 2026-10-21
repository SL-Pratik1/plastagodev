import { createHash } from 'node:crypto';
import type { Surface } from '@plastago/shared';
import { sortdBaseUrl } from '../../config/env.js';
import { buildSupportTicketEmail } from '../../integrations/notice-messages.js';
import { sortdWebhookSecretFor } from '../../integrations/sortd.js';
import { logger } from '../../lib/logger.js';
import { verifySortdSignature } from '../../lib/sortd-webhook.js';
import { notificationService } from '../notifications/notification.service.js';
import { outboundService } from '../notifications/outbound.service.js';
import { sortdRepository } from './sortd.repository.js';

const log = logger.child({ module: 'sortd-webhook' });

/**
 * What Sortd tells PlastaGo, and what PlastaGo does about it.
 *
 * Only `ticket.created` is acted on: it means the support agent could not
 * answer and a person has to. Everything else — `ticket.updated`,
 * `ticket.resolved`, `conversation.resolved`, the `bug_task.*` and
 * `backlog_item.*` events — describes work being done in the Sortd portal,
 * which is where that work is seen. Those are acknowledged, not refused: a 4xx
 * would make Sortd retry three times and log a delivery failure nobody needs
 * to investigate.
 */

/** The subset of the payload this reads. Everything else is ignored by design. */
interface SortdWebhookPayload {
  event?: unknown;
  ticket?: {
    id?: unknown;
    _id?: unknown;
    displayId?: unknown;
    reason?: unknown;
    summary?: unknown;
    reportedFrom?: { url?: unknown; label?: unknown };
  };
  conversation?: { id?: unknown; summary?: unknown };
}

export type WebhookOutcome =
  | { status: 200; body: { ok: true; duplicate?: true } }
  | { status: 400; body: { error: 'invalid_json' } }
  | { status: 401; body: { error: 'unauthorized' } };

/**
 * Escalation reasons, in words for somebody reading an email rather than a
 * spec. Every value the vendor documents; an unknown one falls back to a
 * neutral sentence rather than printing a raw enum.
 */
const REASON_TEXT: Record<string, string> = {
  low_confidence: 'the agent was not confident in its answer',
  no_knowledge: 'the agent had nothing to answer from',
  bug: 'it looks like a bug',
  feature_request: 'it is a feature request',
  manual_action_required: 'it needs somebody to do something',
  sensitive_topic: 'it is a sensitive topic',
  negative_feedback: 'the person was unhappy with the answer',
  user_requested: 'the person asked for a human',
  agent_error: 'the agent itself errored',
  llm_budget_exceeded: 'the agent ran out of budget',
  input_rejected: 'the agent could not accept the question',
  grounded_answer_unsafe: 'the agent could not answer safely',
  user_raised: 'the person raised it directly',
};

/** Where the ticket came from, as the email and the bell say it. */
export const SURFACE_LABEL: Record<Surface, string> = {
  admin: 'the console',
  portal: 'the customer portal',
  driver: 'the driver app',
};

/**
 * A payload string, trimmed and capped.
 *
 * Signed is not the same as safe: a summary is written from what the person
 * typed. It is rendered as text in the bell and escaped in the email, and the
 * cap keeps a pasted log file out of both.
 */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export const sortdWebhookService = {
  /**
   * One delivery, verified against its own surface's secret.
   *
   * Never throws for anything the sender did. It throws only when PlastaGo
   * cannot record the delivery at all — the database is down — so that the
   * answer is a 5xx and Sortd retries.
   */
  async receive(input: {
    surface: Surface;
    rawBody: string;
    timestamp: string;
    signature: string;
  }): Promise<WebhookOutcome> {
    const { surface, rawBody } = input;

    const verdict = verifySortdSignature({
      rawBody,
      timestamp: input.timestamp,
      signature: input.signature,
      // ⚠️ THIS surface's secret only. A delivery signed for the portal app
      // must not be accepted on the driver path, and vice versa.
      secret: sortdWebhookSecretFor(surface),
    });

    if (!verdict.ok) {
      /*
       * Logged, never returned. A 401 that said whether the secret was unset,
       * the clock was off or the digest was wrong would be a free oracle for
       * anyone probing the endpoint.
       */
      log.warn({ surface, reason: verdict.reason }, 'rejected a Sortd webhook');
      return { status: 401, body: { error: 'unauthorized' } };
    }

    let payload: SortdWebhookPayload;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      payload = parsed;
    } catch {
      // Signed but unparseable. Refusing is right, and a retry will not help.
      log.warn({ surface }, 'Sortd webhook body was not a JSON object');
      return { status: 400, body: { error: 'invalid_json' } };
    }

    const event = text(payload.event, 80) ?? '(unnamed)';

    if (event !== 'ticket.created') {
      log.info({ surface, event }, 'Sortd webhook acknowledged, no action');
      return { status: 200, body: { ok: true } };
    }

    /*
     * The ticket id is the vendor's documented dedupe key. A payload with none
     * is keyed on its own bytes instead: a retry resends the identical body, so
     * the hash still recognises it, and two different tickets cannot collide.
     */
    const ticketId =
      text(payload.ticket?.id, 100) ??
      text(payload.ticket?._id, 100) ??
      `body-${createHash('sha256').update(rawBody).digest('hex').slice(0, 24)}`;

    const eventKey = `${surface}:${event}:${ticketId}`;

    if (!(await sortdRepository.claimWebhookEvent(eventKey))) {
      // A retry of work already done. 200, so Sortd stops retrying.
      log.info({ surface, ticketId }, 'duplicate Sortd webhook ignored');
      return { status: 200, body: { ok: true, duplicate: true } };
    }

    try {
      await announceTicket(surface, ticketId, payload);
    } catch (error) {
      /*
       * Genuine, so it must not be lost — give the claim back and let Sortd's
       * retry try again. `notifyOffice` and `outboundService` already swallow
       * their own failures, so reaching here means something more basic broke.
       */
      await sortdRepository.releaseWebhookEvent(eventKey).catch(() => undefined);
      throw error;
    }

    return { status: 200, body: { ok: true } };
  },
};

/** Tells the super-admins somebody is waiting on a person. */
async function announceTicket(
  surface: Surface,
  ticketId: string,
  payload: SortdWebhookPayload,
): Promise<void> {
  const ticket = payload.ticket ?? {};
  const reference = text(ticket.displayId, 40) ?? 'A new ticket';
  const reasonKey = text(ticket.reason, 60);
  const reason = reasonKey ? (REASON_TEXT[reasonKey] ?? 'the agent escalated it') : null;
  const summary = text(ticket.summary, 500) ?? text(payload.conversation?.summary, 500);
  const reportedFrom =
    text(ticket.reportedFrom?.label, 120) ?? text(ticket.reportedFrom?.url, 200);
  const from = SURFACE_LABEL[surface];

  // One key for the bell and the emails. Both dedupe on it independently of
  // the claim above, so the ticket lands once even if the claim were lost.
  const subjectKey = `sortd-ticket:${surface}:${ticketId}`;

  const recipients = await notificationService.notifyOffice({
    audience: 'support',
    category: 'system',
    severity: 'action',
    title:
      reference === 'A new ticket'
        ? `New support ticket from ${from}`
        : `Support ticket ${reference} from ${from}`,
    body: summary ?? (reason ? `Somebody needs help — ${reason}.` : 'Somebody needs help.'),
    /*
     * The notification centre, not Sortd: a bell row navigates inside the app,
     * and the ticket is answered on another origin. The centre shows the whole
     * text; the email carries the link out.
     */
    href: '/admin/notifications',
    subjectKey,
  });

  const context = { reference, from, summary, reason, reportedFrom, sortdUrl: sortdBaseUrl || null };

  await Promise.all(
    recipients
      .filter((recipient) => recipient.email !== null)
      .map((recipient) =>
        outboundService.send({
          event: 'support-ticket-created',
          // Per person: each is their own row in the send log, sent once.
          subjectKey: `${subjectKey}:${recipient.id}`,
          recipient: { email: recipient.email, mobile: null },
          email: (to) => buildSupportTicketEmail(to, context),
        }),
      ),
  );

  log.info({ surface, ticketId, told: recipients.length }, 'Sortd ticket announced');
}
