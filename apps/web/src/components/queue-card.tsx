import { Badge, Card, cn } from '@plastago/ui';
import { ArrowRightIcon, ClockIcon } from 'lucide-react';
import { Link } from 'react-router';
import { formatMoney, formatRelative } from '@/lib/format';
import { useNow } from '@/lib/use-now';

export interface QueueCardProps {
  label: string;
  count: number;
  /** The oldest unactioned item. Ageing is the whole point of these cards. */
  oldestAt: string | null;
  valueExGst: string | null;
  to: string;
  /** Days after which the queue is considered neglected. */
  ageWarningDays?: number;
}

/**
 * An actionable queue.
 *
 * ── Why ageing is as prominent as the count ────────────────────────────────
 * Because a count alone is what the current system shows, and it is why one
 * futile pickup has sat unactioned in TransVirtual since August 2025 — a year, at
 * $120. Nothing about "1" tells you it is a year old. So the oldest item's age
 * is on the card, and it escalates on its own once it crosses the threshold: the
 * system has to chase rather than wait to be asked.
 *
 * The money is shown where the queue holds charges, because that is the argument
 * for actioning it: ~2 contamination charges a week at $90 is ~$9k a year
 * sitting in the approvals queue.
 */
export function QueueCard({
  label,
  count,
  oldestAt,
  valueExGst,
  to,
  ageWarningDays = 3,
}: QueueCardProps) {
  const now = useNow();
  const ageDays =
    oldestAt === null ? 0 : Math.floor((now - new Date(oldestAt).getTime()) / 86400_000);
  const stale = count > 0 && ageDays >= ageWarningDays;
  const empty = count === 0;

  return (
    <Card
      className={cn(
        'transition-colors',
        stale ? 'border-warning/45' : empty ? 'border-border' : 'border-border',
      )}
    >
      <Link to={to} className="focus-ring group flex items-center gap-4 rounded-xl p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                'font-display text-2xl font-semibold tabular-nums',
                empty ? 'text-muted-foreground' : stale ? 'text-warning' : 'text-foreground',
              )}
            >
              {count}
            </span>
            <span className="truncate text-sm font-medium">{label}</span>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {empty ? (
              <span>Nothing waiting</span>
            ) : (
              <>
                {oldestAt !== null && (
                  <span className="flex items-center gap-1">
                    <ClockIcon aria-hidden className="size-3" />
                    Oldest {formatRelative(oldestAt)}
                  </span>
                )}
                {valueExGst !== null && Number(valueExGst) > 0 && (
                  <span>{formatMoney(valueExGst)} ex GST</span>
                )}
                {stale && <Badge variant="warning">Needs attention</Badge>}
              </>
            )}
          </div>
        </div>

        <ArrowRightIcon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
        />
      </Link>
    </Card>
  );
}
