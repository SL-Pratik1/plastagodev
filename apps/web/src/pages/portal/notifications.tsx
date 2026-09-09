import type { Notification } from '@plastago/shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Pagination,
  Skeleton,
  Spinner,
  cn,
  useToast,
} from '@plastago/ui';
import { BellIcon, CheckIcon } from 'lucide-react';
import { Link } from 'react-router';
import { PageHeader } from '@/components/page-header';
import { useListQuery } from '@/components/data-table/use-list-query';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationsRead,
  useNotificationList,
  useNotificationSummary,
} from '@/features/notifications/queries';
import { describeError } from '@/lib/error-message';
import { formatRelative } from '@/lib/format';

/**
 * The customer's updates (M8.1 · M8.2 · M8.3).
 *
 * ── Why the portal has its own screen and not the office one ───────────────
 * Same feed, different audience, and the differences are not cosmetic. The
 * office centre is a work queue: it filters by category and severity, shows
 * ageing on every row because a futile review sitting for a year is the reason
 * it exists, and offers a sweep. None of that means anything to a builder's
 * site supervisor, who wants to know whether yesterday's pickup happened and
 * whether an invoice is waiting on a PO.
 *
 * So this is a plain, chronological feed with one action — open the thing it is
 * about. Filters were deliberately left out: the volume is a handful of rows per
 * site per month, and a filter bar over ten rows is furniture.
 *
 * ── Why it exists at all, when the same news is emailed ───────────────────
 * Because email is where a pickup update goes to die, and because the person who
 * can supply a purchase order is rarely the person the email reached. Anyone who
 * opens the portal to book the next job sees what happened to the last one.
 */
export function PortalNotificationsPage() {
  const toast = useToast();
  const controller = useListQuery({ defaultPageSize: 20 });
  const summary = useNotificationSummary();
  const { data, error, isPending, isFetching, refetch } = useNotificationList(controller.query);

  const markRead = useMarkNotificationsRead();
  const markAllRead = useMarkAllNotificationsRead();

  const unread = summary.data?.unread ?? 0;
  const items = data?.data ?? [];

  const clearAll = async () => {
    try {
      await markAllRead.mutateAsync();
      toast.success('All marked as read');
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Updates"
        description="Your pickups, reminders and invoices. The same news we email you."
        actions={
          unread > 0 && (
            <Button variant="outline" onClick={() => void clearAll()} disabled={markAllRead.isPending}>
              {markAllRead.isPending ? <Spinner className="text-current" /> : <CheckIcon aria-hidden />}
              Mark all as read
            </Button>
          )
        }
      />

      {error && (
        <ErrorState
          title="Your updates could not be loaded"
          description={describeError(error).detail}
          onRetry={() => void refetch()}
        />
      )}

      {isPending && (
        <Card className="divide-y divide-border p-0">
          {[0, 1, 2].map((row) => (
            <div key={row} className="space-y-2 p-4">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          ))}
        </Card>
      )}

      {!isPending && !error && items.length === 0 && (
        <EmptyState
          icon={BellIcon}
          title="Nothing here yet"
          description="When a pickup is booked, a driver is on the way, or an invoice is raised, it appears here."
        />
      )}

      {items.length > 0 && (
        <Card className={cn('divide-y divide-border p-0', isFetching && 'opacity-60')}>
          {items.map((item) => (
            <UpdateRow
              key={item.id}
              item={item}
              onOpen={() => {
                // Opening it IS reading it — a row you have acted on should not
                // still be counted as waiting.
                if (item.readAt === null) void markRead.mutateAsync([item.id]);
              }}
            />
          ))}
        </Card>
      )}

      {data && items.length > 0 && (
        <Pagination
          page={data.meta.page}
          pageSize={data.meta.pageSize}
          total={data.meta.total}
          onPageChange={controller.setPage}
          onPageSizeChange={controller.setPageSize}
          disabled={isFetching}
        />
      )}
    </div>
  );
}

/**
 * One update.
 *
 * The whole row is the link, because on a phone — where a supervisor reads this,
 * standing on a slab — a tap target the width of the screen is the difference
 * between an update that gets opened and one that gets scrolled past.
 */
function UpdateRow({ item, onOpen }: { item: Notification; onOpen: () => void }) {
  return (
    <Link
      to={item.href}
      onClick={onOpen}
      className={cn(
        'focus-ring flex items-start gap-3 p-4 transition-colors hover:bg-muted/60',
        // Unread is carried by weight and a dot, not by a coloured background:
        // a feed of tinted rows reads as a feed of warnings.
        item.readAt === null && 'bg-muted/30',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'mt-1.5 size-2 shrink-0 rounded-full',
          item.readAt === null ? 'bg-primary' : 'bg-transparent',
        )}
      />

      <span className="min-w-0 flex-1">
        <span className={cn('block text-sm', item.readAt === null && 'font-medium')}>
          {item.title}
        </span>
        <span className="mt-0.5 block text-sm text-muted-foreground">{item.body}</span>
        <span className="mt-1 block text-xs text-muted-foreground">{formatRelative(item.at)}</span>
      </span>

      {item.severity === 'action' && <Badge variant="warning">Needs you</Badge>}
    </Link>
  );
}
