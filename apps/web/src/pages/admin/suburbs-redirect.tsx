import { Navigate, useLocation } from 'react-router';

/**
 * `/admin/suburbs` → the Suburbs tab under Settings → Pricing (M6.3).
 *
 * ── Why the route survives without a screen ───────────────────────────────
 * Suburbs used to be its own item under Configuration, a whole navigation group
 * away from the zones it feeds and the rate cards those price. It is a tab now.
 * The address stays because it is in bookmarks and in the client's own notes,
 * and a 404 there reads as the feature having been taken away.
 *
 * ⚠️ It carries `?zoneId=` across rather than redirecting to a bare tab. That
 * parameter is the whole point of the link on every zone row — "which suburbs
 * are in this zone?" — and dropping it would answer a different question with
 * the full list, which looks like a working link and is not.
 */
export function SuburbsRedirect() {
  const { search } = useLocation();
  const zoneId = new URLSearchParams(search).get('zoneId');

  const params = new URLSearchParams({ tab: 'pricing', section: 'suburbs' });
  if (zoneId !== null && zoneId !== '') params.set('zoneId', zoneId);

  return <Navigate replace to={`/admin/settings?${params.toString()}`} />;
}
