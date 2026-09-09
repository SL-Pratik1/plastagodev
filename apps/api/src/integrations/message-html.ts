/**
 * The bits of HTML every outbound email shares.
 *
 * ── Why inline styles and a table-free layout ──────────────────────────────
 * Outlook strips `<style>` blocks, so a stylesheet would render as unstyled
 * text for most of this customer base — builders and site offices run Outlook.
 * Everything here is therefore inline, and the layout is a single column with
 * no floats: a broken layout on an invoice or a sign-in notice reads as a
 * phishing attempt, which is the one impression these messages cannot afford.
 *
 * Kept next to the message builders rather than in `lib/` because it is copy
 * infrastructure, not application logic — the person editing the wording of a
 * reminder is the person who edits this.
 */

/** PlastaGo's deep forest green, matching the console's `--primary`. */
const INK = '#1B3820';
const MUTED = '#5a6b5c';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Wraps message content in the shared shell.
 *
 * `paragraphs` are already-escaped HTML fragments, not raw text — several
 * messages need a bold figure or a link inside a sentence, and escaping at the
 * call site is what keeps that possible without a template language.
 */
export function emailShell(paragraphs: readonly string[]): string {
  const body = paragraphs
    .map((paragraph) => `  <p style="margin:0 0 16px">${paragraph}</p>`)
    .join('\n');

  return `
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:${INK};max-width:520px">
${body}
  <p style="margin:24px 0 0;color:${MUTED};font-size:14px">PlastaGo — plasterboard recycling</p>
</div>`.trim();
}

/**
 * A call to action.
 *
 * A real `<a>` rather than a styled button element: Outlook renders padded
 * anchors reliably and button elements not at all, and a link that does not
 * render is a message with no way to act on it.
 */
export function emailButton(href: string, label: string): string {
  return (
    `<a href="${escapeHtml(href)}" ` +
    `style="display:inline-block;padding:12px 20px;background:${INK};color:#ffffff;` +
    `text-decoration:none;border-radius:8px;font-weight:600">${escapeHtml(label)}</a>`
  );
}
