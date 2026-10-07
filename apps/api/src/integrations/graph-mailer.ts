import {
  ClientCertificateCredential,
  ClientSecretCredential,
  type TokenCredential,
} from '@azure/identity';
import { env } from '../config/env.js';
import { AppError } from '../lib/app-error.js';
import { logger } from '../lib/logger.js';
import { certificateExpiry } from '../lib/pem.js';
import {
  MAX_ATTACHMENT_BYTES,
  senderAddress,
  type Mailer,
  type OutboundEmail,
} from './messaging.js';

const log = logger.child({ module: 'graph-mailer' });

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/**
 * Outbound email through Microsoft 365 (I5).
 *
 * ── Why Graph and not SMTP ──────────────────────────────────────────────────
 * SMTP AUTH needs a mailbox password in our configuration, and Microsoft ships
 * Exchange Online with it disabled — the client's IT would have to deliberately
 * re-enable Authenticated SMTP per mailbox. Graph needs no password, is
 * revocable without a credential rotation, and can be scoped to a single
 * mailbox with an Application Access Policy.
 *
 * The decisive reason is I6: the PO pipeline (M2.12) has to READ a mailbox, and
 * SMTP cannot. One app registration with `Mail.Send` and `Mail.Read` covers
 * sending sign-in codes now and reading purchase orders later — so choosing
 * SMTP here would mean asking the client's IT for two unrelated setups.
 *
 * ── Why no Graph SDK ────────────────────────────────────────────────────────
 * The platform makes exactly two Graph calls in its entire lifetime: send a
 * message, and list an inbox. `@microsoft/microsoft-graph-client` brings a
 * middleware pipeline and a large type surface to wrap two `fetch` calls that
 * are three lines each. `@azure/identity` is kept because token acquisition,
 * caching and renewal is the part genuinely worth not writing.
 */
export function createGraphMailer(): Mailer {
  // Validated in `env.ts` — non-null here, and asserted so a config regression
  // fails loudly at construction rather than on someone's sign-in attempt.
  const tenantId = required(env.MS_GRAPH_TENANT_ID, 'MS_GRAPH_TENANT_ID');
  const clientId = required(env.MS_GRAPH_CLIENT_ID, 'MS_GRAPH_CLIENT_ID');
  const defaultSender = required(env.MS_GRAPH_MAIL_SENDER, 'MS_GRAPH_MAIL_SENDER');

  const credential = graphCredential(tenantId, clientId);

  return {
    name: 'graph',

    async send({ to, subject, text, html, attachments, mailbox }: OutboundEmail): Promise<void> {
      /*
       * Per message: invoices and PO requests go from the accounts mailbox,
       * everything else from the default. Graph sends AS whichever mailbox is
       * in the URL, which the client's IT has scoped this app to.
       */
      const sender = senderAddress(mailbox) ?? defaultSender;
      const fromAccounts = sender !== defaultSender;

      const token = await credential.getToken(GRAPH_SCOPE);
      if (!token) {
        throw AppError.dependencyUnavailable('Could not obtain a Microsoft Graph token');
      }

      /*
       * ⚠️ Checked BEFORE the request, not after Graph rejects it.
       *
       * Graph refuses an oversized message with a 413 that names no file, so
       * the office would see "could not send the email" with nothing to act
       * on. Failing here says which message was too big and by how much.
       */
      const totalBytes = (attachments ?? []).reduce(
        (sum, attachment) => sum + attachment.content.byteLength,
        0,
      );

      if (totalBytes > MAX_ATTACHMENT_BYTES) {
        log.error({ to, subject, totalBytes }, 'attachments exceed the message limit');
        throw AppError.validation('That email is too large to send', [
          {
            path: 'attachments',
            message: `Attachments total ${String(Math.round(totalBytes / 1024 / 1024))}MB; the limit is ${String(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB`,
          },
        ]);
      }

      const response = await fetch(
        `${GRAPH_BASE}/users/${encodeURIComponent(sender)}/sendMail`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              subject,
              body: { contentType: 'HTML', content: html },
              toRecipients: [{ emailAddress: { address: to } }],
              /*
               * Graph's inline attachment form. Omitted entirely rather than
               * sent empty: an empty `attachments` array makes some clients
               * render a paperclip on a message carrying nothing.
               */
              ...(attachments && attachments.length > 0
                ? {
                    attachments: attachments.map((attachment) => ({
                      '@odata.type': '#microsoft.graph.fileAttachment',
                      name: attachment.filename,
                      contentType: attachment.contentType,
                      contentBytes: attachment.content.toString('base64'),
                    })),
                  }
                : {}),
            },
            /*
             * A sign-in code is not correspondence. Keeping it out of Sent Items
             * avoids filling the mailbox with thousands of one-time codes.
             *
             * An invoice IS correspondence: the accounts team needs to see what
             * went out, beside the replies it prompts.
             */
            saveToSentItems: fromAccounts,
          }),
          // Longer than the 10s a bare message gets: an invoice PDF has to
          // cross the wire, and a timeout here loses a send that would have
          // succeeded.
          signal: AbortSignal.timeout(attachments && attachments.length > 0 ? 30_000 : 10_000),
        },
      );

      // Graph answers 202 Accepted with an empty body on success.
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        // `from` matters here: a 403 on the accounts mailbox means the client's
        // IT has not yet granted send rights on it.
        log.error(
          { status: response.status, detail: detail.slice(0, 500), to, from: sender },
          'Graph sendMail failed',
        );
        throw AppError.dependencyUnavailable('Could not send the email');
      }

      // `text` is unused by Graph's HTML message but kept on the interface so a
      // future SMTP or plain-text provider needs no signature change.
      void text;
      log.debug({ to, from: sender, subject }, 'sent via Graph');
    },
  };
}

/** How far ahead an expiring certificate starts being shouted about. */
const EXPIRY_WARNING_DAYS = 30;

/**
 * Who we are to Microsoft: a certificate where one is configured, else a secret.
 *
 * ── Why a certificate is preferred ────────────────────────────────────────
 * The client's IT chose it (07/10/2026), and it is the better trade: Microsoft
 * holds only the public half, so nothing that could send mail as PlastaGo ever
 * travels between the two companies — where a client secret has to be handed
 * over and then exists in two places.
 */
function graphCredential(tenantId: string, clientId: string): TokenCredential {
  const certificate = env.MS_GRAPH_CLIENT_CERTIFICATE;

  if (certificate) {
    warnIfExpiring(certificate);
    log.info('Microsoft Graph credential: certificate');
    return new ClientCertificateCredential(tenantId, clientId, { certificate });
  }

  const secret = required(env.MS_GRAPH_CLIENT_SECRET, 'MS_GRAPH_CLIENT_SECRET');
  log.info('Microsoft Graph credential: client secret');
  return new ClientSecretCredential(tenantId, clientId, secret);
}

/**
 * ⚠️ An expired certificate stops every email — sign-in codes included — with
 * no other symptom. It is logged when the mailer starts, so the renewal is due
 * before the outage rather than discovered by it.
 */
function warnIfExpiring(pem: string): void {
  const expiresAt = certificateExpiry(pem);
  if (!expiresAt) return;

  const daysLeft = Math.floor((expiresAt.getTime() - Date.now()) / 86_400_000);

  if (daysLeft < 0) {
    log.error({ expiresAt }, 'Microsoft Graph certificate has EXPIRED — no email will send');
  } else if (daysLeft <= EXPIRY_WARNING_DAYS) {
    log.warn({ expiresAt, daysLeft }, 'Microsoft Graph certificate expires soon — renew it');
  }
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required when MAIL_PROVIDER=graph`);
  return value;
}
