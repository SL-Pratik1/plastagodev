/**
 * Starts one Vite dev server per surface.
 *
 * ── Why a launcher and not three npm scripts ──────────────────────────────
 * Because the surface is passed in the environment, and there is no syntax for
 * that which works on both platforms: `PLASTAGO_SURFACE=admin vite` is a parse
 * error in cmd.exe, which is what npm runs scripts through on Windows. The
 * usual fix is a `cross-env` dependency; this is the same thing without the
 * dependency, and it also gets to prefix the output, which three separate
 * terminals would not.
 *
 * ── Which surfaces start ──────────────────────────────────────────────────
 * `PLASTAGO_SURFACES` in `apps/web/.env`, defaulting to all three. Set it to
 * `all` for the pre-split single-server mode — one port, every surface, every
 * cross-surface move an ordinary route change:
 *
 *   PLASTAGO_SURFACES=all        one server  (fastest; the split is off)
 *   PLASTAGO_SURFACES=admin      just the console
 *   PLASTAGO_SURFACES=admin,driver
 *
 * Worth knowing before leaving it on the default: three dev servers are three
 * Node processes, three dependency pre-bundles and roughly three times the
 * memory. For a change that touches one surface, naming that surface is
 * noticeably faster than starting all of them.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { REPO_ROOT, SURFACES, devPorts, readEnvValue } from './dev-ports.mjs';

const WEB_ROOT = resolve(REPO_ROOT, 'apps/web');

/** ANSI colours, one per surface, so interleaved output stays readable. */
const COLOUR = { admin: '[36m', portal: '[35m', driver: '[32m', all: '[36m' };
const RESET = '[0m';

function requestedSurfaces() {
  const raw = (
    process.env.PLASTAGO_SURFACES ??
    readEnvValue('apps/web/.env', 'PLASTAGO_SURFACES') ??
    ''
  )
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (raw.length === 0) return [...SURFACES];
  if (raw.includes('all')) return ['all'];

  const unknown = raw.filter((value) => !SURFACES.includes(value));
  if (unknown.length > 0) {
    console.error(
      `PLASTAGO_SURFACES: unknown surface ${unknown.join(', ')}. ` +
        `Expected any of ${SURFACES.join(', ')}, or "all".`,
    );
    process.exit(1);
  }
  return raw;
}

const surfaces = requestedSurfaces();
const ports = devPorts();
const children = [];
let shuttingDown = false;

/**
 * Line-buffered, so a prefix never lands mid-line.
 *
 * Vite writes its banner and its HMR notices in separate chunks that do not
 * align to lines; prefixing raw chunks produced output with the surface name
 * spliced into the middle of a URL, which is worse than no prefix at all.
 */
function prefixed(stream, label, colour, target) {
  let pending = '';
  stream.on('data', (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) target.write(`${colour}[${label}]${RESET} ${line}\n`);
  });
}

for (const surface of surfaces) {
  const port = surface === 'all' ? ports.admin : ports[surface];
  const child = spawn(process.execPath, [resolve(REPO_ROOT, 'node_modules/vite/bin/vite.js')], {
    cwd: WEB_ROOT,
    env: { ...process.env, PLASTAGO_SURFACE: surface, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const colour = COLOUR[surface] ?? '';
  prefixed(child.stdout, surface, colour, process.stdout);
  prefixed(child.stderr, surface, colour, process.stderr);

  console.log(`${colour}[${surface}]${RESET} starting on http://localhost:${port}`);
  children.push(child);

  /*
   * One surface dying takes the rest down with it.
   *
   * `strictPort` means a failure to start is almost always "that port is
   * already taken", and leaving the other two running would hide it: the
   * terminal still looks busy, the URLs still work, and the missing surface is
   * only discovered when somebody clicks through to it.
   */
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`${colour}[${surface}]${RESET} exited (${signal ?? code}) — stopping the rest.`);
    shutdown(code ?? 1);
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}
