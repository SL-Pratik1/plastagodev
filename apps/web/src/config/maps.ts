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
 * ── Two embeds, because the API has two ───────────────────────────────────
 * ⚠️ The Embed API's `directions` mode REQUIRES an origin. It does not fall
 * back to the device's own location — it answers `400 Missing the 'origin'
 * parameter` and renders an error where the map should be. This file used to
 * omit the origin on purpose, with a comment claiming the opposite; with no key
 * on any environment, nothing ever rendered the thing that would have proved it
 * wrong.
 *
 * So there are two URLs. `place` needs nothing but the destination and is what
 * the screen opens with. `directions` is the upgrade, once the browser has told
 * us where the driver actually is — which it may never do, on a phone in a
 * basement or with location denied.
 */
const embedKey = import.meta.env.VITE_GOOGLE_MAPS_EMBED_KEY?.trim() ?? '';

/** True when the in-app map can actually render. */
export const MAPS_EMBED_ENABLED = embedKey !== '';

export interface LatLng {
  latitude: number;
  longitude: number;
}

/**
 * The destination on a map, with no route.
 *
 * Always available when there is a key, because it asks nothing of the device.
 * A driver who can see the site, the street around it and the shape of the
 * block has most of what the map was for.
 */
export function placeEmbedUrl(latitude: number, longitude: number): string | null {
  if (!MAPS_EMBED_ENABLED) return null;
  const query = `${String(latitude)},${String(longitude)}`;
  // Zoom 16 is a few streets across — close enough to see which corner of the
  // estate, wide enough to show how to get into it.
  return `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(embedKey)}&q=${encodeURIComponent(query)}&zoom=16`;
}

/**
 * The driving route from where the driver is standing to the site.
 *
 * ⚠️ `from` is not optional, and that is the API's rule rather than a choice
 * made here. See the note at the top of this file.
 */
export function directionsEmbedUrl(from: LatLng, latitude: number, longitude: number): string | null {
  if (!MAPS_EMBED_ENABLED) return null;
  const origin = `${String(from.latitude)},${String(from.longitude)}`;
  const destination = `${String(latitude)},${String(longitude)}`;
  return `https://www.google.com/maps/embed/v1/directions?key=${encodeURIComponent(embedKey)}&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&mode=driving`;
}

/** The hand-off to the phone's own maps app. Always available. */
export function externalDirectionsUrl(latitude: number, longitude: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${String(latitude)},${String(longitude)}`;
}
