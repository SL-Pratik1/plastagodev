import { Card, Skeleton, cn } from '@plastago/ui';
import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import type { ReactNode } from 'react';

export interface StatCardProps {
  label: string;
  value: ReactNode;
  /** One short line saying what the number means or where it came from. */
  hint?: ReactNode;
  icon?: LucideIcon;
  /**
   * `attention` and `alert` are for a number that means someone has to act.
   * They are not decoration: a page where three tiles are red teaches people to
   * ignore red, so a tile only escalates when its own threshold is crossed.
   */
  tone?: 'default' | 'attention' | 'alert' | 'positive';
  /** Makes the whole tile a link — usually to the filtered list behind it. */
  to?: string;
  isPending?: boolean;
}

const TONE_RING: Record<NonNullable<StatCardProps['tone']>, string> = {
  default: 'border-border',
  attention: 'border-warning/40',
  alert: 'border-destructive/40',
  positive: 'border-success/40',
};

const TONE_ICON: Record<NonNullable<StatCardProps['tone']>, string> = {
  default: 'bg-accent text-accent-foreground',
  attention: 'bg-warning/12 text-warning',
  alert: 'bg-destructive/12 text-destructive',
  positive: 'bg-success/12 text-success',
};

/**
 * A single headline number.
 *
 * The form is chosen deliberately: one number with no trend to show is not a
 * chart, and drawing a one-bar bar chart around it makes it harder to read, not
 * easier. A large figure with a label beside it is the right encoding.
 *
 * The value is `tabular-nums` so a row of tiles does not jitter as the numbers
 * refresh on the dashboard's interval.
 */
export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'default',
  to,
  isPending = false,
}: StatCardProps) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
        {Icon && (
          <span
            aria-hidden
            className={cn('grid size-8 shrink-0 place-items-center rounded-lg', TONE_ICON[tone])}
          >
            <Icon className="size-4" />
          </span>
        )}
      </div>

      <div className="mt-2">
        {isPending ? (
          <Skeleton className="h-8 w-20" />
        ) : (
          <p className="font-display text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
        )}
        {hint !== undefined && hint !== null && (
          <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
        )}
      </div>
    </>
  );

  if (to) {
    return (
      <Link
        to={to}
        className={cn(
          'focus-ring block rounded-xl border bg-card p-4 transition-colors hover:bg-muted/40',
          TONE_RING[tone],
        )}
      >
        {body}
      </Link>
    );
  }

  return <Card className={cn('p-4', TONE_RING[tone])}>{body}</Card>;
}
