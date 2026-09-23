import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * One migration run's findings, in four distinct buckets so "did this
 * actually happen" is never ambiguous:
 *
 *  - `excludedTestRows` — looked like TransVirtual test/dummy data, skipped.
 *  - `parseErrors` — a source row didn't parse; the row is still shown.
 *  - `blocked` — a real record that could NOT be written (a hard requirement
 *    had no source value, e.g. no zone match). Nothing was created for it.
 *  - `flagged` — a real record WAS written, but with a placeholder or a
 *    lossy default that a human should look at and correct.
 */
export interface MigrationNote {
  entity: string;
  key: string;
  code: string;
  message: string;
  rawRow?: Record<string, string> | undefined;
}

export interface EntityCounts {
  read: number;
  excludedTestRows: number;
  parseErrors: number;
  created: number;
  updated: number;
  blocked: number;
  flagged: number;
}

function emptyCounts(): EntityCounts {
  return { read: 0, excludedTestRows: 0, parseErrors: 0, created: 0, updated: 0, blocked: 0, flagged: 0 };
}

export class MigrationReport {
  readonly script: string;
  readonly target: string;
  readonly database: string;
  readonly dryRun: boolean;
  readonly startedAt: string;
  private readonly summary = new Map<string, EntityCounts>();
  private readonly excludedTestRows: MigrationNote[] = [];
  private readonly parseErrors: MigrationNote[] = [];
  private readonly blocked: MigrationNote[] = [];
  private readonly flagged: MigrationNote[] = [];

  constructor(args: { script: string; target: string; database: string; dryRun: boolean }) {
    this.script = args.script;
    this.target = args.target;
    this.database = args.database;
    this.dryRun = args.dryRun;
    this.startedAt = new Date().toISOString();
  }

  private counts(entity: string): EntityCounts {
    let c = this.summary.get(entity);
    if (!c) {
      c = emptyCounts();
      this.summary.set(entity, c);
    }
    return c;
  }

  read(entity: string, n = 1): void {
    this.counts(entity).read += n;
  }

  created(entity: string): void {
    this.counts(entity).created += 1;
  }

  updated(entity: string): void {
    this.counts(entity).updated += 1;
  }

  excludeTestRow(note: MigrationNote): void {
    this.counts(note.entity).excludedTestRows += 1;
    this.excludedTestRows.push(note);
  }

  parseError(note: MigrationNote): void {
    this.counts(note.entity).parseErrors += 1;
    this.parseErrors.push(note);
  }

  block(note: MigrationNote): void {
    this.counts(note.entity).blocked += 1;
    this.blocked.push(note);
  }

  flag(note: MigrationNote): void {
    this.counts(note.entity).flagged += 1;
    this.flagged.push(note);
  }

  /** Console summary — the operator's "did this look sane" glance. */
  printSummary(): void {
    console.log(`\n[${this.script}] summary — target=${this.target} db=${this.database}${this.dryRun ? ' (dry run)' : ''}`);
    for (const [entity, c] of this.summary) {
      console.log(
        `  ${entity}: read=${c.read} created=${c.created} updated=${c.updated} ` +
          `excludedTestRows=${c.excludedTestRows} parseErrors=${c.parseErrors} blocked=${c.blocked} flagged=${c.flagged}`,
      );
    }
    if (this.blocked.length > 0) {
      console.log(`\n  BLOCKED (not written — see the report file for detail):`);
      for (const b of this.blocked.slice(0, 20)) console.log(`    - [${b.entity}] ${b.key}: ${b.message}`);
      if (this.blocked.length > 20) console.log(`    ...and ${String(this.blocked.length - 20)} more`);
    }
    if (this.flagged.length > 0) {
      console.log(`\n  FLAGGED (written, but needs a human to fix something — see the report file):`);
      for (const f of this.flagged.slice(0, 20)) console.log(`    - [${f.entity}] ${f.key}: ${f.message}`);
      if (this.flagged.length > 20) console.log(`    ...and ${String(this.flagged.length - 20)} more`);
    }
  }

  /** Writes the full structured report to apps/api/migration-data/reports/. */
  writeToDisk(reportsDir: string): string {
    const finishedAt = new Date().toISOString();
    const stamp = finishedAt.replace(/[:.]/g, '-');
    const outPath = join(reportsDir, `${this.script}-${stamp}.json`);
    mkdirSync(dirname(outPath), { recursive: true });

    const summaryObj: Record<string, EntityCounts> = {};
    for (const [entity, c] of this.summary) summaryObj[entity] = c;

    writeFileSync(
      outPath,
      JSON.stringify(
        {
          script: this.script,
          target: this.target,
          database: this.database,
          dryRun: this.dryRun,
          startedAt: this.startedAt,
          finishedAt,
          summary: summaryObj,
          blocked: this.blocked,
          flagged: this.flagged,
          parseErrors: this.parseErrors,
          excludedTestRows: this.excludedTestRows,
        },
        null,
        2,
      ),
    );

    console.log(`\n[${this.script}] full report written to ${outPath}`);
    return outPath;
  }
}
