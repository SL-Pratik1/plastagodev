import { ROLE_SURFACE, type Role, type Surface } from '@plastago/shared';

/**
 * Which surface this build serves, and where the other two live.
 *
 * ── Three origins, one product ────────────────────────────────────────────
 * Matt, 29:04: *"it looks like there's only one login screen… maybe it's an idea
 * to **split the driver section off into a separate login screen**."* And 29:19:
 * *"if I need to do multiple subdomains, I'm happy to do that."* The same
 * argument applies to the customer portal: a builder's site supervisor and a
 * PlastaGo allocator have no business sharing an address.
 *
 *   console.plastago.com.au  →  /admin    the office
 *   portal.plastago.com.au   →  /portal   customers
 *   drivers.plastago.com.au  →  /driver   drivers
 *
 * Locally those are three ports rather than three hostnames — see
 * `scripts/dev-ports.mjs`, which also records what ports cannot reproduce.
 *
 * ── Why 'all' still exists ────────────────────────────────────────────────
 * It is how this app worked before the split, and `PLASTAGO_SURFACES=all` still does
 * it: one server, all three surfaces, every cross-surface move an ordinary route
 * change. Three dev servers cost three times the memory and three dependency
 * pre-bundles, which is the wrong trade for a change that touches one screen.
 *
 * In `all` mode every function here answers "same origin, route normally", so
 * the split adds nothing to reason about when it is switched off.
 */
/*
 * ⚠️ Set by `vite.config.ts` into `process.env`, NOT declared in any `.env`.
 * Vite folds prefixed process variables into `import.meta.env`, which is the
 * one channel that works identically in the dev server and in a build — see the
 * note there for the two spellings that look right and silently do not.
 */
const RAW_SURFACE = import.meta.env.VITE_SURFACE ?? 'all';

export type ActiveSurface = Surface | 'all';

function parseSurface(value: string): ActiveSurface {
  if (value === 'admin' || value === 'portal' || value === 'driver' || value === 'all') {
    return value;
  }
  /*
   * Fail LOUD, not open. An unrecognised surface silently treated as 'all'
   * would serve the office console from the driver's origin — the precise
   * outcome the split exists to prevent, arrived at by a typo.
   */
  throw new Error(
    `VITE_SURFACE must be admin, portal, driver or all — got "${value}". ` +
      'Set PLASTAGO_SURFACE when starting Vite (see scripts/dev-ports.mjs).',
  );
}

export const CURRENT_SURFACE: ActiveSurface = parseSurface(RAW_SURFACE);

/** True when this build serves every surface — the pre-split behaviour. */
export const IS_COMBINED = CURRENT_SURFACE === 'all';

/**
 * Where each surface lives.
 *
 * An explicit `VITE_*_APP_URL` wins, which is how production names real
 * hostnames. Otherwise the dev map `vite.config.ts` injected — the localhost
 * ports, already resolved through any override in `apps/web/.env`, so there is
 * no second copy of the port numbers to keep in step.
 */
function devOrigins(): Partial<Record<Surface, string>> {
  try {
    return JSON.parse(import.meta.env.VITE_SURFACE_ORIGINS ?? '{}') as Partial<
      Record<Surface, string>
    >;
  } catch {
    return {};
  }
}

function originFor(surface: Surface, configured: string | undefined): string | null {
  const explicit = configured?.trim() ?? '';
  const value = explicit === '' ? (devOrigins()[surface] ?? '') : explicit;
  return value === '' ? null : value.replace(/\/$/, '');
}

export const SURFACE_ORIGINS: Record<Surface, string | null> = {
  admin: originFor('admin', import.meta.env.VITE_ADMIN_APP_URL),
  portal: originFor('portal', import.meta.env.VITE_PORTAL_APP_URL),
  driver: originFor('driver', import.meta.env.VITE_DRIVER_APP_URL),
};

/** The path prefix that owns each surface. */
export const SURFACE_PREFIX: Record<Surface, string> = {
  admin: '/admin',
  portal: '/portal',
  driver: '/driver',
};

/** Does THIS build serve that surface's routes? */
export function servesSurface(surface: Surface): boolean {
  return IS_COMBINED || CURRENT_SURFACE === surface;
}

/**
 * An absolute URL for a path on another surface, or `null` to route in-app.
 *
 * `null` is the answer in two distinct situations, and both genuinely mean
 * "use the router": the surface is the one this build serves, and the split is
 * switched off. Callers therefore need no knowledge of the mode — they try this
 * first and fall back to `navigate()`, which is what keeps single-server mode working
 * with no configuration at all.
 *
 * `null` is ALSO the answer when a surface has no origin configured, and that is
 * deliberate: an unconfigured production deployment keeps working as one app
 * rather than sending people to a blank address. Missing configuration should
 * degrade, not strand somebody.
 */
export function surfaceHref(surface: Surface, path = '/'): string | null {
  if (servesSurface(surface)) return null;

  const origin = SURFACE_ORIGINS[surface];
  if (origin === null) return null;

  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

/** The same question, asked about a role rather than a surface. */
export function roleSurfaceHref(role: Role, path = '/'): string | null {
  return surfaceHref(ROLE_SURFACE[role], path);
}

/**
 * Leave for another origin.
 *
 * A full page load rather than a route change, because it IS a different
 * origin — and `replace` so the surface they should not have reached does not
 * sit in their back button waiting to bounce them again.
 */
export function leaveForSurface(href: string): void {
  window.location.replace(href);
}
