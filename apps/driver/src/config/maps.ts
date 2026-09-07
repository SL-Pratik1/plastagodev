/**
 * Google Maps configuration (I3).
 *
 * ── Why navigation moved inside the app ───────────────────────────────────
 * Demoing the driver flow, the Navigate button handed the driver to the Google
 * Maps app and the run was over: the phone was now in another application, the
 * job's photo prompts and weight capture were behind an app switch, and coming
 * back meant remembering to. Keeping the map in the page keeps the job in the
 * page — which is the whole argument for the driver surface being one screen at
 * a time.
 *
 * ── Why it degrades instead of pretending ─────────────────────────────────
 * The Embed API needs a billed key, and this build has no credentials. Rather
 * than render a fake map — which would imply an integration that does not exist
 * and would be believed — the screen falls back to the destination detail plus
 * the external hand-off that works today. When the key lands, the same screen
 * shows the real map with no other change.
 */
const embedKey = import.meta.env.VITE_GOOGLE_MAPS_EMBED_KEY?.trim() ?? '';

/** True when the in-app map can actually render. */
export const MAPS_EMBED_ENABLED = embedKey !== '';

/**
 * A directions embed URL for one destination.
 *
 * `origin` is deliberately omitted: the Embed API then routes from the device's
 * own location, which is what a driver leaving the last stop needs and what
 * passing a stale coordinate would get wrong.
 */
export function directionsEmbedUrl(latitude: number, longitude: number): string | null {
  if (!MAPS_EMBED_ENABLED) return null;
  const destination = `${String(latitude)},${String(longitude)}`;
  return `https://www.google.com/maps/embed/v1/directions?key=${encodeURIComponent(embedKey)}&destination=${encodeURIComponent(destination)}&mode=driving`;
}

/** The hand-off to the phone's own maps app. Always available. */
export function externalDirectionsUrl(latitude: number, longitude: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${String(latitude)},${String(longitude)}`;
}
