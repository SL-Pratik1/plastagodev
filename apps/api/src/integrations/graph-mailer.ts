import { ClientSecretCredential } from '@azure/identity';
import { env } from '../config/env.js';
import { AppError } from '../lib/app-error.js';
import { logger } from '../lib/logger.js';
import type { Mailer, OutboundEmail } from './messaging.js';

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
  const clientSecret = required(env.MS_GRAPH_CLIENT_SECRET, 'MS_GRAPH_CLIENT_SECRET');
  const sender = required(env.MS_GRAPH_MAIL_SENDER, 'MS_GRAPH_MAIL_SENDER');

  const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);

  return {
    name: 'graph',

    async send({ to, subject, text, html }: OutboundEmail): Promise<void> {
      const token = await credential.getToken(GRAPH_SCOPE);
      if (!token) {
        throw AppError.dependencyUnavailable('Could not obtain a Microsoft Graph token');
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
            },
            // A sign-in code is not correspondence. Keeping it out of Sent Items
            // avoids filling the mailbox with thousands of one-time codes.
            saveToSentItems: false,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );

      // Graph answers 202 Accepted with an empty body on success.
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        log.error(
          { status: response.status, detail: detail.slice(0, 500), to },
          'Graph sendMail failed',
        );
        throw AppError.dependencyUnavailable('Could not send the email');
      }

      // `text` is unused by Graph's HTML message but kept on the interface so a
      // future SMTP or plain-text provider needs no signature change.
      void text;
      log.debug({ to, subject }, 'sent via Graph');
    },
  };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required when MAIL_PROVIDER=graph`);
  return value;
}
