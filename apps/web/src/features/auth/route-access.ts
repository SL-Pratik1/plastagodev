import { ROLE_SURFACE, type Role, type Surface } from '@plastago/shared';
import { ADMIN_NAV } from '@/config/navigation';
import { PORTAL_NAV } from '@/config/portal-navigation';
import { can, landingPathFor, type Capability } from './permissions';

/**
 * Is this path one the signed-in role could actually use?
 *
 * ── The problem this solves ────────────────────────────────────────────────
 * `RequireAuth` stashes the path an anonymous visitor was bounced off so a deep
 * link from an email survives the OTP round trip. That `from` then rides through
 * sign-in in the router's location state — which the History API persists across
 * reloads, and which nothing ties to an identity, because at capture time there
 * wasn't one.
 *
 * So `from` is a memory of what the BROWSER wanted, and the person who ends up
 * signing in need not be the person it was captured for. On a shared or demo
 * browser they routinely are not: a stale `/portal/invoices` handed to a Site
 * Supervisor dropped them on a 403 the moment they signed in — a dead end, on a
 * screen their role is never meant to reach, as their first impression of the
 * app.
 *
 * A deep link is a convenience. It must never outrank the session.
 *
 * ── Where the answer comes from ───────────────────────────────────────────
 * The navigation configs, not a second table written out by hand. They already
 * map every section of both surfaces to the capability that governs it, and they
 * are already the single source for "what may this role see" — so a section
 * added to the nav is covered here the day it appears, and one that moves cannot
 * drift out of step.
 *
 * ⚠️ Known imprecision, in the safe direction. Nav is section-grained while the
 * router is route-grained, so `/admin/jobs/new` resolves to `jobs:read` (its
 * section) rather than the `jobs:create` its route actually demands. Someone
 * holding one and not the other still reaches the 403 they would have reached
 * before — this check narrows that door, it does not claim to have closed it.
 * The route guards remain the enforcement; this is about where to LAND someone.
 */

/** Every `path → capability` pair both navigations know about, longest first. */
const PATH_CAPABILITIES: readonly (readonly [string, Capability])[] = [
  ...ADMIN_NAV.flatMap((group) => group.items).map((item) => [item.to, item.capability] as const),
  ...PORTAL_NAV.map((item) => [item.to, item.capability] as const),
  /*
   * The driver surface has no navigation config to read from, because its shell
   * has four fixed tabs rather than a capability-gated menu — see the note on
   * `driver:access` in `permissions.ts` for why one capability covers the whole
   * surface. One entry at the root is therefore complete, not a shortcut: every
   * path under `/driver` resolves through it.
   */
  ['/driver', 'driver:access'] as const,
].sort(([a], [b]) => b.length - a.length);

/** The path prefix that owns each surface. */
const SURFACE_PREFIX: Record<Surface, string> = {
  admin: '/admin',
  portal: '/portal',
  driver: '/driver',
};

/** `/portal/sites/abc?x=1` → the `/portal/sites` entry, not the `/portal` one. */
function capabilityForPath(path: string): Capability | null {
  const pathname = path.split(/[?#]/)[0] ?? path;
  const match = PATH_CAPABILITIES.find(([to]) => pathname === to || pathname.startsWith(`${to}/`));
  return match?.[1] ?? null;
}

/**
 * Where to send someone after sign-in, given the deep link they were reaching for.
 *
 * Honours `from` only when it is on the role's own surface AND behind a
 * capability they hold. The wrong surface, or a screen their role excludes,
 * falls back to their landing page — always somewhere they can stand.
 *
 * A path under a section they DO hold is honoured even if it leads nowhere:
 * `/admin/typo` resolves through the `/admin` entry and lands on the 404. That
 * is the right answer for a genuinely bad link, and not this function's to
 * second-guess — its job is role fit, not spelling.
 */
export function signInDestination(role: Role, from?: string | null): string {
  const landing = landingPathFor(role);
  if (!from) return landing;

  const prefix = SURFACE_PREFIX[ROLE_SURFACE[role]];
  const onSurface =
    from === prefix ||
    ['/', '?', '#'].some((separator) => from.startsWith(`${prefix}${separator}`));
  if (!onSurface) return landing;

  const capability = capabilityForPath(from);
  return capability !== null && can(role, capability) ? from : landing;
}
