import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Select } from './select.js';
import { cn } from '../lib/utils.js';

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: readonly number[];
  /** Dims the controls during a background refetch without hiding the counts. */
  disabled?: boolean;
  className?: string;
}

/**
 * Page navigation for a server-paginated list.
 *
 * Deliberately shows "Showing 26–50 of 312" rather than only "Page 2 of 13".
 * The office reconciles counts against TransVirtual reports; a row range and a
 * total are answers, a page number is not.
 *
 * Page numbers are hidden below `sm` — on a phone, prev/next plus the count is
 * enough, and eleven tap targets in a row is not.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [5, 10, 15, 20],
  disabled = false,
  className,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, totalPages);
  const firstRow = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const lastRow = Math.min(current * pageSize, total);

  return (
    <div
      className={cn(
        'flex flex-col gap-3 border-t border-border px-3 py-3 sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {total === 0 ? (
          'No results'
        ) : (
          <>
            Showing <span className="font-medium text-foreground tabular-nums">{firstRow}</span>–
            <span className="font-medium text-foreground tabular-nums">{lastRow}</span> of{' '}
            <span className="font-medium text-foreground tabular-nums">{total}</span>
          </>
        )}
      </p>

      <div className="flex items-center justify-between gap-3 sm:justify-end">
        {onPageSizeChange && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="hidden sm:inline">Rows</span>
            <Select
              value={String(pageSize)}
              disabled={disabled}
              onChange={(event) => {
                onPageSizeChange(Number(event.target.value));
              }}
              className="h-8 w-auto text-xs"
            >
              {pageSizeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </label>
        )}

        <nav aria-label="Pagination" className="flex items-center gap-1">
          <PageButton
            label="Previous page"
            disabled={disabled || current <= 1}
            onClick={() => {
              onPageChange(current - 1);
            }}
          >
            <ChevronLeftIcon aria-hidden className="size-4" />
          </PageButton>

          <span className="px-2 text-xs text-muted-foreground tabular-nums sm:hidden">
            {current} / {totalPages}
          </span>

          <span className="hidden items-center gap-1 sm:flex">
            {pageWindow(current, totalPages).map((entry, index) =>
              entry === null ? (
                <span
                  key={`gap-${String(index)}`}
                  aria-hidden
                  className="px-1 text-muted-foreground"
                >
                  …
                </span>
              ) : (
                <button
                  key={entry}
                  type="button"
                  disabled={disabled}
                  aria-current={entry === current ? 'page' : undefined}
                  onClick={() => {
                    onPageChange(entry);
                  }}
                  className={cn(
                    'focus-ring grid size-8 place-items-center rounded-md text-xs font-medium tabular-nums transition-colors',
                    entry === current
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    disabled && 'pointer-events-none opacity-50',
                  )}
                >
                  {entry}
                </button>
              ),
            )}
          </span>

          <PageButton
            label="Next page"
            disabled={disabled || current >= totalPages}
            onClick={() => {
              onPageChange(current + 1);
            }}
          >
            <ChevronRightIcon aria-hidden className="size-4" />
          </PageButton>
        </nav>
      </div>
    </div>
  );
}

function PageButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="focus-ring grid size-8 place-items-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  );
}

/**
 * First, last, and a window around the current page — `null` marks an ellipsis.
 * Keeps the control a fixed width whether there are 3 pages or 300.
 */
function pageWindow(current: number, totalPages: number): Array<number | null> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);

  const pages = new Set<number>([1, totalPages, current]);
  if (current - 1 > 1) pages.add(current - 1);
  if (current + 1 < totalPages) pages.add(current + 1);
  if (current <= 3) pages.add(2).add(3).add(4);
  if (current >= totalPages - 2)
    pages
      .add(totalPages - 1)
      .add(totalPages - 2)
      .add(totalPages - 3);

  const sorted = [...pages].filter((page) => page >= 1 && page <= totalPages).sort((a, b) => a - b);

  const result: Array<number | null> = [];
  let previous = 0;
  for (const page of sorted) {
    if (previous && page - previous > 1) result.push(null);
    result.push(page);
    previous = page;
  }
  return result;
}
