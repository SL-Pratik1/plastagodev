/**
 * Verifies that the three places a port is written down still agree.
 *
 * ── The failure this exists to prevent ────────────────────────────────────
 * A port lives in three files: the Vite servers take theirs from
 * `PLASTAGO_PORT_*`, the API allowlists browser origins in `CORS_ORIGINS`, and
 * the app is told where its sibling surfaces are by `VITE_*_APP_URL`. Move one
 * and forget the others and nothing announces itself — the dev proxy keeps
 * same-origin calls working, so the app looks fine until a cross-surface
 * redirect lands on a dead port, or a cross-origin call is refused by CORS with
 * an error that names neither file.
 *
 * That already happened in this repo: `apps/api/.env` was repointed to 4100 with
 * `CORS_ORIGINS` on 5390/5391 while both Vite servers stayed on 5173/5174 and
 * proxied to 4000. Three files, three different answers, no error message.
 *
 * Wired into `npm run dev`, so the check runs at the moment it is useful rather
 * than in CI an hour later. Warnings do not block the boot: a deliberately
 * unusual setup should not need this file edited to be allowed to start.
 */
import { devPorts, surfaceOrigins, readEnvValue, SURFACES } from './dev-ports.mjs';

const ports = devPorts();
const expected = surfaceOrigins(ports);
const problems = [];

/** `CORS_ORIGINS` must contain every surface origin, or the browser is refused. */
const corsRaw = readEnvValue('apps/api/.env', 'CORS_ORIGINS');
if (corsRaw === null) {
  problems.push('apps/api/.env has no CORS_ORIGINS — the API will fall back to its defaults.');
} else {
  const allowed = corsRaw.split(',').map((value) => value.trim().replace(/\/$/, ''));
  for (const surface of SURFACES) {
    if (!allowed.includes(expected[surface])) {
      problems.push(
        `CORS_ORIGINS (apps/api/.env) is missing ${expected[surface]} — the ${surface} surface ` +
          'will be refused on any cross-origin call.',
      );
    }
  }
}

/**
 * `VITE_*_APP_URL` may be empty — that is the documented "use the dev defaults"
 * state and the common one locally. It may not be WRONG, which is the case this
 * catches: a value left behind after a port moved.
 */
for (const surface of SURFACES) {
  const key = `VITE_${surface.toUpperCase()}_APP_URL`;
  const configured = readEnvValue('apps/web/.env', key);
  if (configured === null) continue;

  const normalised = configured.replace(/\/$/, '');
  const looksLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(normalised);
  if (looksLocal && normalised !== expected[surface]) {
    problems.push(
      `${key} (apps/web/.env) is ${normalised}, but the ${surface} surface serves ` +
        `${expected[surface]}. Cross-surface links will land on a dead port.`,
    );
  }
}

/** The proxy target, when it has been overridden by hand. */
const proxy =
  process.env.VITE_API_PROXY_TARGET ?? readEnvValue('apps/web/.env', 'VITE_API_PROXY_TARGET');
if (proxy !== null && proxy !== undefined) {
  const port = Number(/:(\d+)/.exec(proxy)?.[1]);
  if (Number.isInteger(port) && port !== ports.api) {
    problems.push(
      `VITE_API_PROXY_TARGET points at port ${port}, but the API listens on ${ports.api} ` +
        '(PORT in apps/api/.env). Every /api request will 502.',
    );
  }
}

if (problems.length > 0) {
  console.warn('\nPort configuration looks inconsistent:\n');
  for (const problem of problems) console.warn(`  ⚠️  ${problem}`);
  console.warn(
    `\n  Currently: api ${ports.api} · admin ${ports.admin} · portal ${ports.portal} ` +
      `· driver ${ports.driver}`,
  );
  console.warn('  See scripts/dev-ports.mjs for how to move a port properly.\n');
} else {
  console.log(
    `ports consistent — api ${ports.api} · admin ${ports.admin} · portal ${ports.portal} ` +
      `· driver ${ports.driver}`,
  );
}
