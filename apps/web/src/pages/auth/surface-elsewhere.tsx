import { useEffect } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { Surface } from '@plastago/shared';
import { FullPageLoader } from '@/components/full-page-loader';
import { SURFACE_ORIGINS, leaveForSurface } from '@/config/surfaces';

export interface SurfaceElsewhereProps {
  surface: Surface;
}

/**
 * Stands in for a surface this build does not serve.
 *
 * ── Why these paths are routed at all ─────────────────────────────────────
 * They could just as easily 404: on the console's origin, `/portal/invoices` is
 * not a page. But it IS a page somewhere, and the person who typed it is
 * holding a link that used to work — every bookmark, email link and pasted URL
 * from before the split names a path without naming a surface. Answering "not
 * found" would break all of them at once, on an address the product itself sent
 * out.
 *
 * So the path is carried across rather than discarded: `/portal/invoices` on
 * the console origin becomes `/portal/invoices` on the portal's. The surface
 * moved; the route inside it did not.
 *
 * ⚠️ Unauthenticated is the normal case here, not an edge one. A link opened in
 * a fresh browser has no session, and this runs OUTSIDE `RequireAuth` on
 * purpose — bouncing to sign-in first would authenticate someone on the wrong
 * origin and then still have to move them. Send them to the right place and let
 * that origin ask who they are.
 */
export function SurfaceElsewhere({ surface }: SurfaceElsewhereProps) {
  const { pathname, search, hash } = useLocation();
  const origin = SURFACE_ORIGINS[surface];
  const href = origin === null ? null : `${origin}${pathname}${search}${hash}`;

  useEffect(() => {
    if (href !== null) leaveForSurface(href);
  }, [href]);

  /*
   * No origin configured for that surface — a deployment that has not been told
   * where its siblings live. Nothing useful to do but treat the path as what it
   * is on this origin: not a page.
   */
  if (href === null) return <Navigate to="/forbidden" replace />;

  return <FullPageLoader />;
}
