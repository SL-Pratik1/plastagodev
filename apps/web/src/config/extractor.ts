/**
 * 3PM Extractor embed configuration (I6).
 *
 * ── Why the base URL is public and the credential is not ──────────────────
 * The iframe's `src` is built in the browser, so the origin has to be a
 * `VITE_*` value — it is in the page source either way. What is NOT here is the
 * embed token: that is a tenant-wide credential with no expiry, and the API
 * brokers a one-day session id in its place. See `extractor.service.ts`.
 *
 * ── Why it degrades instead of pretending ─────────────────────────────────
 * Same argument as `maps.ts`: with no URL configured the tab says so rather
 * than rendering an empty frame that looks like a broken integration.
 */
const baseUrl = import.meta.env.VITE_EXTRACTOR_URL?.trim() ?? '';

/** True when the Extractor tab can actually render. */
export const EXTRACTOR_ENABLED = baseUrl !== '';

/**
 * The iframe URL for a brokered session.
 *
 * ── Why only the root `/embed`, and no per-page URLs ──────────────────────
 * The vendor's embedded app carries its own navigation — upload, documents,
 * extractions, activity log and settings are tabs INSIDE the frame. PlastaGo
 * used to wrap that in a second tab strip of its own, which meant two rows of
 * tabs stacked on one screen, disagreeing about which section was open.
 *
 * So the frame is given the root path and left to navigate itself. Deep-linking
 * to one section would mean re-introducing the outer strip; if that is ever
 * wanted, the vendor's sub-paths are `/embed/documents`, `/embed/extractions`,
 * `/embed/processing-log` and `/embed/settings`.
 *
 * The session id is the credential, so it is encoded rather than interpolated
 * raw — a value that ever contained a `&` would otherwise silently truncate.
 */
export function extractorEmbedUrl(sessionId: string): string | null {
  if (!EXTRACTOR_ENABLED) return null;

  return `${baseUrl.replace(/\/$/, '')}/embed?sessionId=${encodeURIComponent(sessionId)}`;
}
