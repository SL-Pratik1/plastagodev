import mongoose from 'mongoose';

/**
 * Parsed flags for a TransVirtual migration script.
 *
 * Deliberately not the existing seed scripts' `NODE_ENV==='production'`
 * refusal — those scripts never need to touch production; these ones must,
 * eventually, on purpose. So the gate is explicit opt-in flags instead of an
 * environment check, checked against the ACTUAL connected database name/host
 * rather than trusted blindly.
 */
export interface MigrationCli {
  target: 'local-test' | 'production';
  dryRun: boolean;
  /** Required alongside `target: 'production'`. Ignored otherwise. */
  productionConfirmed: boolean;
  /** Required alongside `target: 'production'` — must equal the connected db name exactly. */
  confirmDbName: string | null;
  inputDir: string | null;
}

export class MigrationCliError extends Error {}

export function parseMigrationCli(argv: string[]): MigrationCli {
  const flags = new Map<string, string | true>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) flags.set(arg.slice(2), true);
    else flags.set(arg.slice(2, eq), arg.slice(eq + 1));
  }

  const targetRaw = flags.get('target');
  if (targetRaw !== 'local-test' && targetRaw !== 'production') {
    throw new MigrationCliError(
      "Pass --target=local-test or --target=production explicitly — there is no default. " +
        'This script writes real data; which database it touches must never be implicit.',
    );
  }

  const dryRun = flags.get('dry-run') === true;
  const productionConfirmed = flags.get('i-know-this-is-production') === true;
  const confirmDbNameRaw = flags.get('confirm-db');
  const confirmDbName = typeof confirmDbNameRaw === 'string' ? confirmDbNameRaw : null;
  const inputDirRaw = flags.get('input-dir');
  const inputDir = typeof inputDirRaw === 'string' ? inputDirRaw : null;

  if (targetRaw === 'production') {
    if (!productionConfirmed) {
      throw new MigrationCliError(
        '--target=production also requires --i-know-this-is-production. ' +
          'Two separate flags on purpose, so a copy-pasted local-test command line ' +
          'cannot silently carry into production.',
      );
    }
    if (!confirmDbName) {
      throw new MigrationCliError(
        '--target=production also requires --confirm-db=<exact database name>. ' +
          'Type the real production database name — this is the last human checkpoint ' +
          'before anything is written.',
      );
    }
  }

  return { target: targetRaw, dryRun, productionConfirmed, confirmDbName, inputDir };
}

/**
 * The one human checkpoint before any write: assert the ACTUALLY-connected
 * database matches what `--target` claims, then print it so it is the last
 * thing visible before writes start.
 *
 * Call this AFTER `connectMongo()`.
 */
export function assertTargetMatchesConnection(cli: MigrationCli): void {
  const conn = mongoose.connection;
  const dbName = conn.name;
  const host = conn.host;

  if (cli.target === 'local-test') {
    const isLocal = /^(127\.0\.0\.1|localhost|::1)$/i.test(host ?? '');
    if (!isLocal) {
      throw new MigrationCliError(
        `--target=local-test was passed, but the connected host is "${host}", not localhost. ` +
          'Refusing to proceed — this usually means MONGODB_URI in .env still points somewhere else.',
      );
    }
  }

  if (cli.target === 'production' && cli.confirmDbName !== dbName) {
    throw new MigrationCliError(
      `--confirm-db="${cli.confirmDbName}" does not match the connected database "${dbName}". ` +
        'Refusing to proceed — type the exact database name you intend to write to.',
    );
  }

  console.log(
    `[target] ${cli.target}${cli.dryRun ? ' (DRY RUN — no writes)' : ''} — database "${dbName}" on ${host}`,
  );
}
