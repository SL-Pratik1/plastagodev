import { cn } from '@plastago/ui';
import type { ReactNode } from 'react';

export interface DetailItem {
  label: string;
  value: ReactNode;
  /** Spans both columns — for notes and addresses. */
  wide?: boolean;
}

export interface DetailListProps {
  items: readonly DetailItem[];
  /** `2` for a side panel, `3` for a full-width tab. */
  columns?: 1 | 2 | 3;
  className?: string;
}

/**
 * Label/value pairs, as a real description list.
 *
 * `<dl>` rather than a two-column grid of divs, so a screen reader announces
 * "Rate card, Tier 1" as a pair instead of reading two unrelated strings. Every
 * detail tab in the console uses this, which is also what keeps the label
 * treatment identical across twenty of them.
 *
 * `grid-cols-subgrid` lets each pair align to the parent's columns, so labels
 * line up down the page even when their text lengths differ.
 */
export function DetailList({ items, columns = 2, className }: DetailListProps) {
  return (
    <dl
      className={cn(
        'grid gap-x-8 gap-y-4',
        columns === 1 && 'grid-cols-1',
        columns === 2 && 'sm:grid-cols-2',
        columns === 3 && 'sm:grid-cols-2 lg:grid-cols-3',
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.label} className={cn('min-w-0', item.wide && 'sm:col-span-full')}>
          <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {item.label}
          </dt>
          <dd className="mt-1 text-sm break-words">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
