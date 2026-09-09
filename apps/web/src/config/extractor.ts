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
 * The embed pages, in the order the tab strip shows them.
 *
 * ⚠️ `upload` is the vendor's bare `/embed`, not `/embed/upload`. The guide's
 * table names it "File Upload & Extraction" at the root path, and guessing a
 * tidier URL renders the vendor's own 404 inside our frame.
 */
export const EXTRACTOR_PAGES = [
  { id: 'upload', label: 'Upload', path: '' },
  { id: 'documents', label: 'Documents', path: '/documents' },
  { id: 'extractions', label: 'Extractions', path: '/extractions' },
  { id: 'processing-log', label: 'Activity log', path: '/processing-log' },
  { id: 'settings', label: 'Settings', path: '/settings' },
] as const;

export type ExtractorPageId = (typeof EXTRACTOR_PAGES)[number]['id'];

/** The origin, for verifying `postMessage` events actually came from the frame. */
export const EXTRACTOR_ORIGIN = EXTRACTOR_ENABLED ? new URL(baseUrl).origin : '';

/**
 * The iframe URL for one page and one brokered session.
 *
 * The session id is the credential, so it is encoded rather than interpolated
 * raw — a value that ever contained a `&` would otherwise silently truncate.
 */
export function extractorEmbedUrl(page: ExtractorPageId, sessionId: string): string | null {
  if (!EXTRACTOR_ENABLED) return null;

  const match = EXTRACTOR_PAGES.find((entry) => entry.id === page);
  if (!match) return null;

  return `${baseUrl.replace(/\/$/, '')}/embed${match.path}?sessionId=${encodeURIComponent(sessionId)}`;
}
