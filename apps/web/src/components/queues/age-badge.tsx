import { Badge, type BadgeProps } from '@plastago/ui';
import { ClockIcon, TriangleAlertIcon } from 'lucide-react';
import { formatDateTime } from '@/lib/format';
import { useNow } from '@/lib/use-now';

export interface AgeBadgeProps {
  /** When the item entered the queue. */
  since: string;
  /** Amber from here. */
  warnDays?: number;
  /** Red from here. */
  alarmDays?: number;
  /** Hidden entirely once the item has been actioned. */
  muted?: boolean;
}

/**
 * How long this has been waiting — the field these queues exist for.
 *
 * ── Why it escalates on its own ────────────────────────────────────────────
 * TransVirtual shows the futile queue today, and one entry has sat in it since
 * 28 August 2025. Nothing on that screen is *wrong*; it simply never got louder.
 * So the badge changes colour and gains an icon at three days and again at
 * seven, without anyone configuring a rule — the system chases, or it is the
 * same system with a new coat of paint.
 *
 * The exact timestamp lives in the `title`, because "6 days" is the number you
 * act on but "which Tuesday?" is the one you need on the phone.
 */
export function AgeBadge({ since, warnDays = 3, alarmDays = 7, muted = false }: AgeBadgeProps) {
  // `useNow` rather than `Date.now()` in render: an impure read in a render body
  // is not React-Compiler safe, and this badge must also tick over midnight.
  const now = useNow();
  const days = Math.floor((now - new Date(since).getTime()) / 86_400_000);
  const hours = Math.floor((now - new Date(since).getTime()) / 3_600_000);

  const label = days >= 1 ? `${String(days)}d` : hours >= 1 ? `${String(hours)}h` : 'New';

  if (muted) {
    return (
      <span className="text-xs text-muted-foreground tabular-nums" title={formatDateTime(since)}>
        {label}
      </span>
    );
  }

  const variant: BadgeProps['variant'] =
    days >= alarmDays ? 'destructive' : days >= warnDays ? 'warning' : 'outline';

  return (
    <Badge variant={variant} title={`Waiting since ${formatDateTime(since)}`}>
      {days >= alarmDays ? (
        <TriangleAlertIcon aria-hidden className="size-3" />
      ) : days >= warnDays ? (
        <ClockIcon aria-hidden className="size-3" />
      ) : null}
      <span className="tabular-nums">{label}</span>
      <span className="sr-only">
        {' '}
        waiting{days >= alarmDays ? ' — overdue' : days >= warnDays ? ' — needs attention' : ''}
      </span>
    </Badge>
  );
}
