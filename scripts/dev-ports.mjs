/**
 * The development ports, resolved in one place.
 *
 * Read by `scripts/free-ports.mjs` (plain node) and by `apps/web/vite.config.ts`
 * (through esbuild), which is why this is a `.mjs` with no TypeScript in it.
 *
 * ── Why each surface gets its own port ────────────────────────────────────
 * In production the three surfaces are three hostnames: the office console, the
 * customer portal and the driver app are separate addresses, and somebody who
 * lands on the wrong one has simply gone to the wrong place. A single dev port
 * could not reproduce that — every cross-surface bounce was an in-app route
 * change, so the one thing most likely to break in production was the one thing
 * development never exercised.
 *
 * ⚠️ A PORT IS NOT AN ORIGIN, FOR COOKIES. Browsers scope cookies by host and
 * ignore the port, so a session set on `localhost:5173` is sent to
 * `localhost:5176` too — the surfaces share a sign-in here and will not once the
 * hostnames differ. Everything else about the split (redirects, CORS, the
 * per-surface manifests) does behave as it will in production. Do not use this
 * setup to convince yourself that session isolation works.
 *
 * ── Overriding, for a second checkout ─────────────────────────────────────
 * Every port below can be moved without touching code, which is what lets two
 * checkouts of this repo run at once:
 *
 *   apps/api/.env   PORT=4100
 *   apps/web/.env   PLASTAGO_PORT_ADMIN=5390
 *                   PLASTAGO_PORT_PORTAL=5391
 *                   PLASTAGO_PORT_DRIVER=5392
 *
 * ⚠️ Moving a port means moving it in THREE places or the app breaks in a way
 * that looks like a bug: the ports here, `CORS_ORIGINS` in `apps/api/.env`, and
 * `VITE_*_APP_URL` in `apps/web/.env`. `npm run check:ports` verifies all three
 * agree and is wired into `npm run dev`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The three surfaces, matching `ROLE_SURFACE` in `packages/shared`. */
export const SURFACES = Object.freeze(['admin', 'portal', 'driver']);

const DEFAULTS = Object.freeze({
  api: 4000,
  admin: 5173,
  portal: 5175,
  driver: 5176,
});

/**
 * `apps/driver`, the superseded standalone PWA (see README).
 *
 * Not part of `npm run dev` — it is excluded by filter, because it is not part
 * of the product any more and a port clash in it used to abort the entire dev
 * run through Turbo. `npm run dev:driver` still starts it, and
 * `PLASTAGO_PORT_LEGACY_DRIVER` in `apps/driver/.env` moves it when a second
 * checkout already holds 5174.
 */
export const DEFAULT_LEGACY_DRIVER_APP_PORT = 5174;

export function legacyDriverAppPort() {
  return readEnvPort(
    'apps/driver/.env',
    'PLASTAGO_PORT_LEGACY_DRIVER',
    DEFAULT_LEGACY_DRIVER_APP_PORT,
  );
}

/** `KEY=value` out of a dotenv file, ignoring comments. `null` if absent. */
function readEnvValue(file, key) {
  let text;
  try {
    text = readFileSync(resolve(REPO_ROOT, file), 'utf8');
  } catch {
    return null; // no .env yet — the default is the right answer
  }
  const match = new RegExp(`^\s*${key}\s*=\s*(.*)$`, 'm').exec(text);
  if (!match) return null;
  const value = match[1].trim().replace(/^["']|["']$/g, '');
  return value === '' ? null : value;
}

function readEnvPort(file, key, fallback) {
  const raw = readEnvValue(file, key);
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

/**
 * The ports THIS checkout is configured for — not the defaults.
 *
 * Resolved from the `.env` files rather than baked in, because a checkout that
 * has been repointed and a script that sweeps the defaults is the worst
 * combination available: the real server keeps running and the tooling reports
 * success.
 */
export function devPorts() {
  return {
    api: readEnvPort('apps/api/.env', 'PORT', DEFAULTS.api),
    admin: readEnvPort('apps/web/.env', 'PLASTAGO_PORT_ADMIN', DEFAULTS.admin),
    portal: readEnvPort('apps/web/.env', 'PLASTAGO_PORT_PORTAL', DEFAULTS.portal),
    driver: readEnvPort('apps/web/.env', 'PLASTAGO_PORT_DRIVER', DEFAULTS.driver),
  };
}

/** `http://localhost:5173` etc., keyed by surface. */
export function surfaceOrigins(ports = devPorts()) {
  return Object.fromEntries(
    SURFACES.map((surface) => [surface, `http://localhost:${ports[surface]}`]),
  );
}

export { DEFAULTS as DEFAULT_PORTS, readEnvValue };
