import type { ListQuery, ListResult } from '../types';

export interface ListOptions<TRow> {
  /** Fields free-text search looks at. Nulls are skipped. */
  search?: (row: TRow) => ReadonlyArray<string | number | null | undefined>;
  /** One predicate per filter key. A key with no predicate is ignored. */
  filters?: Record<string, (row: TRow, value: string) => boolean>;
  /** One comparator per sortable field, ascending. Descending is derived. */
  sorters?: Record<string, (a: TRow, b: TRow) => number>;
  /** Order when no sort is requested. */
  defaultSort?: (a: TRow, b: TRow) => number;
}

/**
 * Filter → search → sort → paginate, once.
 *
 * Every mock list goes through this. Reimplementing pagination per domain is how
 * you end up with one grid that resets to page 1 on sort and another that does
 * not, and the drift is invisible until someone notices the totals disagree.
 *
 * Semantics deliberately mirror what the server will do, so screens do not have
 * to change when the real endpoints arrive: `sort` is a field name with a `-`
 * prefix for descending (matching `PageQuerySchema`), unknown filter keys and
 * unknown sort fields are ignored rather than throwing, and `meta.total` is the
 * count AFTER filtering — that is what "Showing 1–25 of 312" has to mean.
 */
export function applyListQuery<TRow>(
  rows: readonly TRow[],
  query: ListQuery,
  options: ListOptions<TRow> = {},
): ListResult<TRow> {
  let result = [...rows];

  // ── Filters ────────────────────────────────────────────────────────────
  for (const [key, value] of Object.entries(query.filters ?? {})) {
    if (!value) continue;
    const predicate = options.filters?.[key];
    if (!predicate) continue;
    result = result.filter((row) => predicate(row, value));
  }

  // ── Search ─────────────────────────────────────────────────────────────
  const needle = query.q?.trim().toLowerCase();
  if (needle && options.search) {
    result = result.filter((row) =>
      options
        .search?.(row)
        .some(
          (field) =>
            field !== null && field !== undefined && String(field).toLowerCase().includes(needle),
        ),
    );
  }

  // ── Sort ───────────────────────────────────────────────────────────────
  const sort = query.sort;
  if (sort) {
    const descending = sort.startsWith('-');
    const field = descending ? sort.slice(1) : sort;
    const comparator = options.sorters?.[field];
    if (comparator) {
      result.sort((a, b) => (descending ? -comparator(a, b) : comparator(a, b)));
    } else if (options.defaultSort) {
      result.sort(options.defaultSort);
    }
  } else if (options.defaultSort) {
    result.sort(options.defaultSort);
  }

  // ── Paginate ───────────────────────────────────────────────────────────
  const total = result.length;
  const pageSize = Math.max(1, query.pageSize);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // Clamp rather than return an empty page: a filter that shrinks the result set
  // while the user sits on page 4 should show them rows, not a blank grid.
  const page = Math.min(Math.max(1, query.page), totalPages);
  const start = (page - 1) * pageSize;

  return {
    data: result.slice(start, start + pageSize),
    meta: { page, pageSize, total, totalPages },
  };
}

/** Ascending comparator for possibly-null strings; nulls sort last. */
export function byText<TRow>(get: (row: TRow) => string | null | undefined) {
  return (a: TRow, b: TRow): number => {
    const left = get(a);
    const right = get(b);
    if (!left && !right) return 0;
    if (!left) return 1;
    if (!right) return -1;
    return left.localeCompare(right);
  };
}

/** Ascending comparator for possibly-null numbers; nulls sort last. */
export function byNumber<TRow>(get: (row: TRow) => number | null | undefined) {
  return (a: TRow, b: TRow): number => {
    const left = get(a);
    const right = get(b);
    if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
    if (right === null || right === undefined) return -1;
    return left - right;
  };
}

/** Ascending comparator for ISO date or date-time strings; nulls sort last. */
export function byDate<TRow>(get: (row: TRow) => string | null | undefined) {
  return (a: TRow, b: TRow): number => {
    const left = get(a);
    const right = get(b);
    if (!left && !right) return 0;
    if (!left) return 1;
    if (!right) return -1;
    return left.localeCompare(right);
  };
}
