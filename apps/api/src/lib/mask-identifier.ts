/**
 * Redacts an email address or a mobile number for storage and display.
 *
 * ── Why one definition, imported ──────────────────────────────────────────
 * Three places show a masked identifier — the OTP challenge the sign-in screen
 * renders ("we sent a code to a•••••@example.com"), the outbound message log,
 * and the audit trail. If they mask differently, the same person appears as two
 * different recipients depending on which screen you are looking at, and the
 * question those screens exist to answer — *did the message reach them?* —
 * becomes unanswerable.
 *
 * The shape is deliberate: the first character and the domain survive on an
 * email, and the last three digits on a mobile. Enough for the recipient to
 * recognise their own address, never enough for a reader of the log to learn a
 * customer's contact details.
 */

export type MaskChannel = 'email' | 'sms';

export function maskIdentifier(identifier: string, channel: MaskChannel): string {
  if (channel === 'email') {
    const [local = '', domain = ''] = identifier.split('@');
    const head = local.slice(0, 1);
    return `${head}${'•'.repeat(Math.max(2, local.length - 1))}@${domain}`;
  }

  return `•••• ••• ${identifier.slice(-3)}`;
}
