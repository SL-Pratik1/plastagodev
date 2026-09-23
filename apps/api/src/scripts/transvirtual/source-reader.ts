import { readFileSync } from 'node:fs';

/**
 * One TransVirtual grid, read straight off the live page rather than through
 * TransVirtual's own "Export" feature (see the migration report/plan for why
 * — Export triggers a server-side action there and was deliberately avoided;
 * this is the DOM already rendered by an ordinary, read-only page view,
 * written to a plain JSON file by the same session that read it).
 *
 * Shape matches exactly what the read-only capture tool wrote: the grid's own
 * internal column ids (e.g. `gridtable_Customer_CustomerCode`) as headers,
 * and every row's cells in that same order.
 */
interface RawGridDump {
  headerCells: string[];
  rowCount: number;
  rows: string[][];
  pager?: string;
}

/** One source row, keyed by TransVirtual's own field name with the grid-id prefix stripped. */
export type SourceRow = Record<string, string>;

/**
 * Strips a jqGrid column id down to the field TransVirtual itself uses —
 * `gridtable_Customer_CustomerCode` → `CustomerCode`, `GridRules_Name` →
 * `Name`. Kept as a single, visible rule rather than one-off renames per
 * entity, so a transform's key names are traceable back to the raw export.
 */
function shortKey(headerCell: string): string {
  const parts = headerCell.split('_');
  return parts.length > 1 ? (parts.at(-1) ?? headerCell) : headerCell;
}

/**
 * Reads one grid dump and turns it into row objects. Throws immediately on a
 * missing/unreadable file or a header row with no columns — those are
 * structural problems that should stop the whole phase, not surface as 60
 * confusing per-row errors downstream.
 */
export function readGridDump(filePath: string): SourceRow[] {
  let raw: RawGridDump;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8')) as RawGridDump;
  } catch (error) {
    throw new Error(
      `Could not read TransVirtual data file "${filePath}": ${(error as Error).message}. ` +
        'Was it captured and copied into apps/api/migration-data/transvirtual/ before running this script?',
      { cause: error },
    );
  }

  if (!Array.isArray(raw.headerCells) || raw.headerCells.length === 0) {
    throw new Error(`"${filePath}" has no header columns — is this a valid capture file?`);
  }

  const keys = raw.headerCells.map(shortKey);

  return raw.rows.map((cells) => {
    const row: SourceRow = {};
    keys.forEach((key, i) => {
      row[key] = (cells[i] ?? '').trim();
    });
    return row;
  });
}

/**
 * Confirms every column a transform is about to rely on is actually present
 * in the file — a missing/renamed source column is a structural problem
 * (the export changed shape), not a per-row data problem, so it fails the
 * whole phase immediately with a clear message rather than 60 confusing
 * "undefined" values.
 */
export function assertColumns(rows: SourceRow[], required: string[], filePath: string): void {
  if (rows.length === 0) return;
  const present = new Set(Object.keys(rows[0] ?? {}));
  const missing = required.filter((c) => !present.has(c));
  if (missing.length > 0) {
    throw new Error(
      `"${filePath}" is missing expected column(s): ${missing.join(', ')}. ` +
        `Columns present: ${[...present].join(', ')}.`,
    );
  }
}
