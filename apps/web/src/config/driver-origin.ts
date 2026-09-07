/**
 * Where the driver surface lives (M4 · Matt, 29:04).
 *
 * ── Two origins, one product ──────────────────────────────────────────────
 * Matt, 29:04: *"it looks like there's only one login screen… maybe it's an idea
 * to **split the driver section off into a separate login screen**."* And 29:19:
 * *"if I need to do multiple subdomains, I'm happy to do that."*
 *
 *   drivers.plastago.com.au  →  apps/driver  (the run sheet, and nothing else)
 *   portal.plastago.com.au   →  apps/web     (office and customers)
 *
 * The split is worth having for a reason beyond tidiness: a driver installs the
 * PWA from whichever page they are on, so the driver app must be reachable at an
 * address that contains only driver screens. Installing "PlastaGo" from the
 * office origin would put an icon on their phone that opens an office sign-in.
 *
 * ── Why this is configuration and not a constant ──────────────────────────
 * In development there is one origin: the driver screens are served from this
 * app at `/driver`, and there is nowhere else to send anyone. Hard-coding the
 * production hostname would make every local sign-in bounce to a domain that is
 * not running. Empty means "stay here", which is the correct dev behaviour and a
 * safe production default if the variable is ever forgotten.
 */
const configured = import.meta.env.VITE_DRIVER_APP_URL?.trim() ?? '';

/** The driver app's origin, or null when it is served from this one. */
export const DRIVER_APP_URL: string | null = configured === '' ? null : configured.replace(/\/$/, '');

/**
 * Where to send a driver after sign-in.
 *
 * Returns an absolute URL when the driver app is a separate origin, and null
 * when it is not — the caller then falls back to in-app routing rather than a
 * page load, which is what keeps development working with no configuration.
 */
export function driverAppHref(path = '/'): string | null {
  if (DRIVER_APP_URL === null) return null;
  return `${DRIVER_APP_URL}${path.startsWith('/') ? path : `/${path}`}`;
}
