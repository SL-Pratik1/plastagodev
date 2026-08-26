import type { ComponentProps } from 'react';
import { cn } from '../lib/utils.js';

/**
 * Presentational table primitives.
 *
 * The office is coming from jqGrid and lives in grids all day (§6A.1), so
 * density and scan-ability matter more than decoration: tight rows, a sticky
 * header, right-aligned numerics, and a horizontal scroll container so a wide
 * grid never pushes the page sideways.
 */
export function TableContainer({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('relative w-full overflow-x-auto overscroll-x-contain', className)}
      {...props}
    />
  );
}

export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <table
      className={cn('w-full caption-bottom border-separate border-spacing-0 text-sm', className)}
      {...props}
    />
  );
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return <thead className={cn('[&_th]:bg-muted', className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody className={className} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return (
    <tr
      className={cn(
        'transition-colors hover:bg-muted/60 data-[interactive=true]:cursor-pointer',
        className,
      )}
      {...props}
    />
  );
}

/**
 * `numeric` rather than an `align` prop: `align` is a real (deprecated) HTML
 * attribute on `<th>`/`<td>` with a different value set, so reusing the name
 * fights the DOM types. It also says the useful thing — a numeric column wants
 * right alignment AND tabular figures, so the digits line up down the column.
 */
export interface TableHeadProps extends ComponentProps<'th'> {
  numeric?: boolean;
}

export function TableHead({ className, numeric = false, ...props }: TableHeadProps) {
  return (
    <th
      scope="col"
      className={cn(
        'sticky top-0 z-10 whitespace-nowrap border-b border-border px-3 py-2.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase',
        numeric ? 'text-right' : 'text-left',
        className,
      )}
      {...props}
    />
  );
}

export interface TableCellProps extends ComponentProps<'td'> {
  numeric?: boolean;
}

export function TableCell({ className, numeric = false, ...props }: TableCellProps) {
  return (
    <td
      className={cn(
        'border-b border-border px-3 py-2.5 align-middle',
        numeric ? 'text-right tabular-nums' : 'text-left',
        className,
      )}
      {...props}
    />
  );
}

export function TableCaption({ className, ...props }: ComponentProps<'caption'>) {
  return <caption className={cn('sr-only', className)} {...props} />;
}
