import {
  Checkbox,
  cn,
  EmptyState,
  ErrorState,
  Skeleton,
  Spinner,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  type EmptyStateProps,
} from '@plastago/ui';
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon, SearchIcon } from 'lucide-react';
import { Link } from 'react-router';
import { describeError } from '@/lib/error-message';
import type { DataTableColumn } from './types';

export interface DataTableProps<TRow> {
  columns: readonly DataTableColumn<TRow>[];
  rows: readonly TRow[];
  getRowId: (row: TRow) => string;
  /** Describes the table for screen readers, e.g. "Users and roles". */
  caption: string;

  /** First load — no data has arrived yet. Renders skeleton rows. */
  isPending?: boolean;
  /** A background refresh with data already on screen. Keeps the rows visible. */
  isFetching?: boolean;
  error?: unknown;
  onRetry?: () => void;

  sort?: string | undefined;
  onToggleSort?: (sortKey: string) => void;

  /** Row link. Rendered as a real anchor so middle-click and Cmd-click work. */
  rowHref?: (row: TRow) => string;

  /** Shown when the unfiltered list is genuinely empty. */
  empty: Omit<EmptyStateProps, 'variant'>;
  /** True when a search or filter is active — changes the empty message. */
  isFiltered?: boolean;
  onClearFilters?: () => void;

  /**
   * Row selection, for the screens with documented bulk actions (M7.7).
   *
   * Opt-in: a checkbox column on a list with nothing to do in bulk is a control
   * that leads nowhere. Passing `selectedIds` turns it on.
   *
   * `selectableRow` lets a screen exclude rows a bulk action cannot apply to —
   * an invoice already sent, say — so the user cannot select something that will
   * then be silently skipped.
   */
  selectedIds?: readonly string[];
  onSelectionChange?: (ids: string[]) => void;
  selectableRow?: (row: TRow) => boolean;
}

/**
 * Server-driven data table with a card layout on small screens.
 *
 * ── Why not `@tanstack/react-table` ────────────────────────────────────────
 * It is installed and it is the stack's documented choice (§6A.1), but v9.1.2 is
 * a ground-up rewrite: an atom store, explicit `features: {}` opt-in, and
 * `Subscribe`/`FlexRender` render plumbing. Nearly all of that value is in
 * CLIENT-side row models — sorting, filtering, pagination over rows already in
 * memory. Our lists are paginated, sorted and filtered by the SERVER, matching
 * `PageQuerySchema`, so those row models would sit unused while their generics
 * shaped every column definition in the app.
 *
 * What is here instead is a typed column contract, one table, one card layout,
 * and all five states. If a screen later needs client-side column ops — grouping
 * on the allocation board, say — introducing TanStack there is a contained
 * change, because `DataTableColumn` is deliberately close to its `ColumnDef`.
 *
 * ── The five states, all handled here ──────────────────────────────────────
 * error · first load · empty · filtered-to-nothing · loaded. Screens get all of
 * them by using this component, rather than each one remembering four of the
 * five.
 */
export function DataTable<TRow>({
  columns,
  rows,
  getRowId,
  caption,
  isPending = false,
  isFetching = false,
  error,
  onRetry,
  sort,
  onToggleSort,
  rowHref,
  empty,
  isFiltered = false,
  onClearFilters,
  selectedIds,
  onSelectionChange,
  selectableRow,
}: DataTableProps<TRow>) {
  const selectable = selectedIds !== undefined && onSelectionChange !== undefined;
  const selected = new Set(selectedIds ?? []);

  const eligible = rows.filter((row) => selectableRow?.(row) ?? true);
  const eligibleIds = eligible.map(getRowId);
  const allSelected = eligibleIds.length > 0 && eligibleIds.every((id) => selected.has(id));
  const someSelected = eligibleIds.some((id) => selected.has(id));

  const toggleRow = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectionChange?.([...next]);
  };

  const toggleAll = () => {
    // Select-all applies to THIS page only, and the toolbar says so. Silently
    // acting on 300 filtered rows the user cannot see is how bulk actions go
    // wrong.
    onSelectionChange?.(allSelected ? [] : eligibleIds);
  };
  if (error) {
    const described = describeError(error);
    return (
      <ErrorState
        title={described.title}
        description={described.detail}
        requestId={described.requestId}
        {...(described.retryable && onRetry ? { onRetry } : {})}
      />
    );
  }

  if (isPending) {
    return <LoadingRows columns={columns} caption={caption} />;
  }

  if (rows.length === 0) {
    // Nothing found vs nothing exists — different problems, different actions.
    return isFiltered ? (
      <EmptyState
        variant="search"
        icon={SearchIcon}
        title="No matches"
        description="No records match your current search and filters."
        action={
          onClearFilters ? (
            <button
              type="button"
              onClick={onClearFilters}
              className="focus-ring rounded text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              Clear search and filters
            </button>
          ) : undefined
        }
      />
    ) : (
      <EmptyState {...empty} />
    );
  }

  return (
    <div className={cn('relative', isFetching && 'opacity-70 transition-opacity')}>
      {isFetching && (
        <div className="absolute top-2 right-3 z-20">
          <Spinner label="Refreshing" />
        </div>
      )}

      {/* Desktop: the grid the office expects. */}
      <TableContainer className="hidden md:block">
        <Table>
          <TableCaption>{caption}</TableCaption>
          <TableHeader>
            <TableRow>
              {selectable && (
                <TableHead className="w-10">
                  <Checkbox
                    checked={allSelected}
                    indeterminate={!allSelected && someSelected}
                    onChange={toggleAll}
                    aria-label={allSelected ? 'Clear selection' : 'Select all rows on this page'}
                  />
                </TableHead>
              )}
              {columns.map((column) => (
                <TableHead key={column.id} numeric={column.numeric} className={column.className}>
                  {column.sortKey && onToggleSort ? (
                    <SortButton
                      label={column.header}
                      sortKey={column.sortKey}
                      sort={sort}
                      numeric={column.numeric}
                      onToggle={onToggleSort}
                    />
                  ) : (
                    column.header
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>

          <TableBody>
            {rows.map((row) => {
              const id = getRowId(row);
              const href = rowHref?.(row);

              const isSelectable = selectableRow?.(row) ?? true;

              return (
                <TableRow key={id} className={selected.has(id) ? 'bg-accent/40' : undefined}>
                  {selectable && (
                    <TableCell className="w-10">
                      <Checkbox
                        checked={selected.has(id)}
                        disabled={!isSelectable}
                        onChange={() => {
                          toggleRow(id);
                        }}
                        aria-label={`Select row ${id}`}
                      />
                    </TableCell>
                  )}
                  {columns.map((column, index) => (
                    <TableCell
                      key={column.id}
                      numeric={column.numeric}
                      className={column.className}
                    >
                      {/*
                        The link goes on the first cell rather than the whole row:
                        a `<tr>` cannot contain an anchor that wraps its cells, and
                        a row-level onClick is invisible to the keyboard. This way
                        the row has one real, focusable, Cmd-clickable link.
                      */}
                      {href && index === 0 ? (
                        <Link
                          to={href}
                          className="focus-ring rounded font-medium text-foreground underline-offset-4 hover:underline"
                        >
                          {column.cell(row)}
                        </Link>
                      ) : (
                        column.cell(row)
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Phone: the same columns, restacked by priority. */}
      <ul className="divide-y divide-border md:hidden">
        {rows.map((row) => (
          <li key={getRowId(row)}>
            <RowCard row={row} columns={columns} href={rowHref?.(row)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function SortButton({
  label,
  sortKey,
  sort,
  numeric,
  onToggle,
}: {
  label: string;
  sortKey: string;
  sort: string | undefined;
  numeric?: boolean;
  onToggle: (sortKey: string) => void;
}) {
  const ascending = sort === sortKey;
  const descending = sort === `-${sortKey}`;
  const Icon = ascending ? ArrowUpIcon : descending ? ArrowDownIcon : ChevronsUpDownIcon;

  return (
    <button
      type="button"
      onClick={() => {
        onToggle(sortKey);
      }}
      // Announced by screen readers as the column's sort state, per the ARIA
      // grid pattern — an arrow glyph alone conveys nothing to a screen reader.
      aria-sort={ascending ? 'ascending' : descending ? 'descending' : 'none'}
      className={cn(
        'focus-ring group inline-flex items-center gap-1 rounded text-xs font-semibold tracking-wide uppercase transition-colors hover:text-foreground',
        numeric && 'flex-row-reverse',
      )}
    >
      {label}
      <Icon
        aria-hidden
        className={cn(
          'size-3.5 transition-opacity',
          ascending || descending ? 'opacity-100' : 'opacity-40 group-hover:opacity-80',
        )}
      />
    </button>
  );
}

function RowCard<TRow>({
  row,
  columns,
  href,
}: {
  row: TRow;
  columns: readonly DataTableColumn<TRow>[];
  href: string | undefined;
}) {
  const primary = columns.filter((column) => column.priority === 'primary');
  const secondary = columns.filter((column) => column.priority === 'secondary');
  // Anything unclassified falls to the detail list rather than being dropped.
  const detail = columns.filter(
    (column) => column.priority === 'detail' || column.priority === undefined,
  );

  return (
    <div className="space-y-2.5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          {primary.map((column) => (
            <div key={column.id} className="font-medium">
              {href ? (
                <Link to={href} className="focus-ring rounded underline-offset-4 hover:underline">
                  {column.cell(row)}
                </Link>
              ) : (
                column.cell(row)
              )}
            </div>
          ))}
        </div>

        {secondary.length > 0 && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {secondary.map((column) => (
              <div key={column.id}>{column.cell(row)}</div>
            ))}
          </div>
        )}
      </div>

      {detail.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {detail.map((column) => (
            <div key={column.id} className="col-span-2 grid grid-cols-subgrid">
              <dt className="text-muted-foreground">{column.header}</dt>
              <dd className={cn('min-w-0', column.numeric && 'tabular-nums')}>
                {column.cell(row)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function LoadingRows<TRow>({
  columns,
  caption,
}: {
  columns: readonly DataTableColumn<TRow>[];
  caption: string;
}) {
  const placeholderRows = Array.from({ length: 6 }, (_, index) => index);

  return (
    // One announcement for the whole block; the skeleton shapes are aria-hidden.
    <div role="status" aria-live="polite" aria-busy>
      <span className="sr-only">Loading {caption}</span>

      <TableContainer className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((column) => (
                <TableHead key={column.id} numeric={column.numeric} className={column.className}>
                  {column.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {placeholderRows.map((index) => (
              <TableRow key={index}>
                {columns.map((column) => (
                  <TableCell key={column.id}>
                    <Skeleton
                      className="h-4"
                      style={{ width: `${String(45 + ((index * 13) % 40))}%` }}
                    />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <ul className="divide-y divide-border md:hidden">
        {placeholderRows.slice(0, 4).map((index) => (
          <li key={index} className="space-y-2 p-4">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </li>
        ))}
      </ul>
    </div>
  );
}
