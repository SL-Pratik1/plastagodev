import { InboxIcon, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/utils.js';

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  /** Primary action — creating the missing thing, or clearing the filters. */
  action?: ReactNode;
  /** `search` is the "no results for your filters" case, which is NOT empty. */
  variant?: 'empty' | 'search';
  className?: string;
}

/**
 * The "nothing here" state.
 *
 * Two variants because they are different problems and merging them makes both
 * worse. "You have no accounts yet" invites the user to create one. "No jobs
 * match these filters" means the data exists and the filters are wrong — so the
 * useful action is *clear the filters*, not *create a job*. Showing the first
 * message when the second is true makes a filtered grid look broken.
 */
export function EmptyState({
  icon: Icon = InboxIcon,
  title,
  description,
  action,
  variant = 'empty',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-14 text-center',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'grid size-11 place-items-center rounded-full',
          variant === 'search'
            ? 'bg-muted text-muted-foreground'
            : 'bg-accent text-accent-foreground',
        )}
      >
        <Icon className="size-5" />
      </span>

      <div className="space-y-1">
        <p className="font-display text-sm font-semibold tracking-tight">{title}</p>
        {description && (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">{description}</p>
        )}
      </div>

      {action}
    </div>
  );
}
