/**
 * Distance between two points on the earth, in kilometres (I3).
 *
 * ── Why this exists rather than a library ─────────────────────────────────
 * It is used for exactly one decision — "is this geocoded pin plausibly in the
 * suburb somebody picked?" — at a tolerance of tens of kilometres. Haversine on
 * a spherical earth is wrong by about 0.3% against the real ellipsoid, which at
 * a 25km threshold is under a hundred metres. Nothing here is close enough to
 * the boundary for that to change an answer, and a dependency that has to be
 * audited and updated forever is a poor trade for it.
 */
const EARTH_RADIUS_KM = 6371;

export interface LatLng {
  latitude: number;
  longitude: number;
}

export function distanceKm(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
