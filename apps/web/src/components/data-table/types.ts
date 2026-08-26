import type { ReactNode } from 'react';

/**
 * What a column becomes when the table collapses to cards below `md`.
 *
 * A twelve-column grid cannot shrink to a 360px phone — horizontal scrolling a
 * wide grid on a touch screen is miserable, and hiding columns silently loses
 * data. So every column declares its importance and the same definition renders
 * two layouts:
 *
 *  • `primary`   — the card's title. Usually one per table.
 *  • `secondary` — under the title: status, key dates. Shown without labels.
 *  • `detail`    — label/value rows in the card body.
 *
 * Nothing is dropped; only its position changes.
 */
export type ColumnPriority = 'primary' | 'secondary' | 'detail';

export interface DataTableColumn<TRow> {
  /** Stable key, also the React key for the cell. */
  id: string;
  header: string;
  cell: (row: TRow) => ReactNode;
  /**
   * Field name the service sorts on. Omit for a column that cannot be sorted —
   * a computed or composite cell usually cannot.
   */
  sortKey?: string;
  /** Right-aligns and applies tabular figures, so digits line up. */
  numeric?: boolean;
  priority?: ColumnPriority;
  /** Fixed width, e.g. `'w-32'`. Useful for action and status columns. */
  className?: string;
}

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterDefinition {
  /** URL query key, also the key in `ListQuery.filters`. */
  key: string;
  label: string;
  options: readonly FilterOption[];
  /** Label for the "no filter" option, e.g. "All roles". */
  allLabel?: string;
}
