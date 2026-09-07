import { env } from '../config/env.js';
import type { OutboundEmail, OutboundSms } from './messaging.js';

/**
 * The words a person actually receives when they sign in.
 *
 * Kept in one file, away from the auth service, for the same reason the web app
 * keeps `auth-messages.ts` away from its service layer: this is copy, it will
 * be revised by someone who is not editing business logic that day, and it
 * should be reviewable without reading a state machine.
 *
 * Three rules these messages follow:
 *
 *  1. **No links.** A sign-in message containing a clickable link trains the
 *     recipient to click links in sign-in messages, which is precisely the
 *     behaviour a phishing campaign needs. The code is typed into a page the
 *     user already has open.
 *  2. **Name the expiry.** "Expires in 5 minutes" prevents the support call
 *     that starts "I got a code yesterday and it won't work".
 *  3. **Say what to do if it wasn't them.** For a driver whose number is on a
 *     job sheet, an unexpected code is the first sign of a problem.
 */

function minutesFrom(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

export function buildOtpEmail(to: string, code: string): OutboundEmail {
  const brand = env.OTP_SENDER_NAME;
  const minutes = minutesFrom(env.OTP_TTL_SECONDS);

  const text = [
    `Your ${brand} sign-in code is ${code}`,
    '',
    `Enter it on the sign-in screen. It expires in ${String(minutes)} minutes.`,
    '',
    `If you didn't try to sign in, you can ignore this email — but if it keeps`,
    `happening, tell the office.`,
  ].join('\n');

  // Inline styles only: Outlook strips <style> blocks, and a broken layout on a
  // sign-in code reads as a phishing attempt.
  const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#1B3820;max-width:480px">
  <p style="margin:0 0 20px">Your ${escapeHtml(brand)} sign-in code is:</p>
  <p style="margin:0 0 20px;font-size:34px;font-weight:700;letter-spacing:6px;color:#1B3820">${escapeHtml(code)}</p>
  <p style="margin:0 0 20px">Enter it on the sign-in screen. It expires in ${String(minutes)} minutes.</p>
  <p style="margin:0;color:#5a6b5c;font-size:14px">
    If you didn&rsquo;t try to sign in, you can ignore this email &mdash; but if it keeps
    happening, tell the office.
  </p>
</div>`.trim();

  return {
    to,
    // No code in the subject: notification previews on a lock screen are
    // readable by anyone holding the phone.
    subject: `Your ${brand} sign-in code`,
    text,
    html,
  };
}

export function buildOtpSms(to: string, code: string): OutboundSms {
  const brand = env.OTP_SENDER_NAME;
  const minutes = minutesFrom(env.OTP_TTL_SECONDS);

  // One segment (≤160 GSM-7 characters) so it arrives as a single message and
  // is billed once. Measured, not assumed — see the test.
  return {
    to,
    body:
      `${brand}: your sign-in code is ${code}. ` +
      `Expires in ${String(minutes)} min. Never share it.`,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
