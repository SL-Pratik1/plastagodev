/**
 * Frees the dev ports pinned in vite.config.ts / apps/api/.env.
 *
 * Every Vite surface sets `strictPort: true` because the API CORS allowlist and
 * the per-surface PWA manifests expect exactly these ports — so a stale server
 * has to be killed rather than worked around. Turbo does not always tear down
 * its grandchildren when a terminal is closed without Ctrl+C, which leaves the
 * ports held by orphaned vite/tsx processes.
 *
 * Only kills processes whose command line points back into this repo.
 */
import { execFileSync } from 'node:child_process';
import { REPO_ROOT, devPorts, legacyDriverAppPort } from './dev-ports.mjs';

const repoRoot = toPosix(REPO_ROOT);

/**
 * The ports `npm run dev` is about to bind: the API and the three surfaces
 * (§6A.5). Resolved from the `.env` files by `devPorts()`, so a checkout that
 * has been repointed is swept where it actually listens rather than where the
 * defaults say — the difference between sweeping and reporting success.
 *
 * A foreign process on one of these is fatal. `strictPort` means the server
 * will not start, and starting two of three surfaces silently is worse than
 * not starting at all.
 */
const ports = devPorts();
const REQUIRED_PORTS = [...new Set(Object.values(ports))];

/**
 * Swept too, but never fatal: the superseded standalone driver app.
 *
 * ⚠️ This distinction is the whole point. Two checkouts of this repo commonly
 * run side by side, and the other one holding 5174 — a port nothing in THIS
 * checkout binds — used to abort `npm run dev` here with a message about a
 * port the developer had no reason to care about. A port we are not going to
 * listen on is somebody else's business.
 */
const ADVISORY_PORTS = [legacyDriverAppPort()].filter(
  (port) => !REQUIRED_PORTS.includes(port),
);

const PORTS = [...REQUIRED_PORTS, ...ADVISORY_PORTS];

function toPosix(value) {
  return value.split('\\').join('/');
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return ''; // no listener on the port, or the tool is unavailable
  }
}

function parse(out) {
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf('|');
      return { pid: Number(line.slice(0, at)), command: line.slice(at + 1) };
    })
    .filter(({ pid }) => Number.isInteger(pid) && pid > 0);
}

/** @returns {Array<{pid: number, command: string}>} */
function listeners(port) {
  if (process.platform === 'win32') {
    const ps = [
      `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue`,
      'foreach ($x in $c) {',
      '  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($x.OwningProcess)" -ErrorAction SilentlyContinue',
      '  if ($p) { Write-Output ("$($p.ProcessId)|$($p.CommandLine)") }',
      '}',
    ].join('\n');
    return parse(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]));
  }

  const pids = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
    .split(/\s+/)
    .filter(Boolean);
  return parse(
    pids.map((pid) => `${pid}|${run('ps', ['-o', 'command=', '-p', pid]).trim()}`).join('\n'),
  );
}

function kill(pid) {
  if (process.platform === 'win32') run('taskkill', ['/PID', String(pid), '/T', '/F']);
  else run('kill', ['-9', String(pid)]);
}

let killed = 0;
let blocked = 0;

for (const port of PORTS) {
  const required = REQUIRED_PORTS.includes(port);

  for (const { pid, command } of listeners(port)) {
    if (pid === process.pid) continue;

    if (!toPosix(command).includes(repoRoot)) {
      const note = required ? 'not from this repo' : 'not from this repo, and not needed here';
      console.warn(`port ${port}: PID ${pid} is ${note} — left alone`);
      console.warn(`  ${command.trim()}`);
      if (required) blocked += 1;
      continue;
    }

    kill(pid);
    console.log(`port ${port}: killed stale PID ${pid}`);
    killed += 1;
  }
}

if (killed === 0 && blocked === 0) {
  console.log(`ports ${REQUIRED_PORTS.join(', ')} free`);
}
if (blocked > 0) {
  console.error(
    '\nPorts this checkout needs are held by processes outside this repo. Free them, or move' +
      '\nthis checkout: PORT in apps/api/.env and PLASTAGO_PORT_* in apps/web/.env.',
  );
  process.exitCode = 1;
}
