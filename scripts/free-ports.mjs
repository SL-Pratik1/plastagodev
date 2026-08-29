/**
 * Frees the dev ports pinned in vite.config.ts / apps/api/.env.
 *
 * Both Vite apps set `strictPort: true` because the API CORS allowlist and the
 * driver PWA manifest expect exactly these ports — so a stale server has to be
 * killed rather than worked around. Turbo does not always tear down its
 * grandchildren when a terminal is closed without Ctrl+C, which leaves the
 * ports held by orphaned vite/tsx processes.
 *
 * Only kills processes whose command line points back into this repo.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PORTS = [5173, 5174, 4000];
const repoRoot = toPosix(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

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
  return parse(pids.map((pid) => `${pid}|${run('ps', ['-o', 'command=', '-p', pid]).trim()}`).join('\n'));
}

function kill(pid) {
  if (process.platform === 'win32') run('taskkill', ['/PID', String(pid), '/T', '/F']);
  else run('kill', ['-9', String(pid)]);
}

let killed = 0;
let skipped = 0;

for (const port of PORTS) {
  for (const { pid, command } of listeners(port)) {
    if (pid === process.pid) continue;

    if (!toPosix(command).includes(repoRoot)) {
      console.warn(`port ${port}: PID ${pid} is not from this repo — left alone`);
      console.warn(`  ${command.trim()}`);
      skipped += 1;
      continue;
    }

    kill(pid);
    console.log(`port ${port}: killed stale PID ${pid}`);
    killed += 1;
  }
}

if (killed === 0 && skipped === 0) {
  console.log(`ports ${PORTS.join(', ')} already free`);
}
if (skipped > 0) {
  console.error('\nSome ports are held by processes outside this repo. Free them, then retry.');
  process.exitCode = 1;
}
