import { Badge, Menu, MenuItem, MenuLabel, MenuSeparator, cn } from '@plastago/ui';
import { BellIcon } from 'lucide-react';
import { useNavigate } from 'react-router';
import {
  useMarkNotificationsRead,
  useNotificationList,
  useNotificationSummary,
} from '@/features/notifications/queries';
import { formatRelative } from '@/lib/format';

/**
 * The shell's notification bell.
 *
 * ── Derived, not invented ──────────────────────────────────────────────────
 * There is no separate notification store here, and deliberately so. The things
 * the office needs to be told about are already modelled: the four queues that
 * hold work, and the driver devices that have stopped syncing. Inventing a
 * parallel feed would create a second source of truth that could disagree with
 * the dashboard.
 *
 * So the bell counts *unactioned work*, not messages. The badge only appears when
 * something is genuinely waiting, and it disappears when the queues are clear —
 * which is what makes it worth looking at. A bell that always shows a number is
 * a bell nobody reads.
 */
export function NotificationsMenu({ tone = 'default' }: { tone?: 'default' | 'sidebar' }) {
  const navigate = useNavigate();
  const summary = useNotificationSummary();
  const markRead = useMarkNotificationsRead();

  // Only the unread head of the list — the bell is a prompt to open the centre,
  // not a replacement for it.
  const { data } = useNotificationList({ page: 1, pageSize: 6, filters: { read: 'unread' } });

  const items = data?.data ?? [];
  const unread = summary.data?.unread ?? 0;
  const urgent = summary.data?.urgent ?? 0;

  const open = (id: string, href: string) => {
    void markRead.mutateAsync([id]);
    void navigate(href);
  };

  return (
    <Menu
      align="end"
      triggerLabel={unread > 0 ? `Notifications — ${String(unread)} unread` : 'Notifications'}
      triggerClassName={cn(
        'relative grid size-9 place-items-center rounded-md transition-colors',
        tone === 'sidebar'
          ? 'text-sidebar-foreground hover:bg-sidebar-accent'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
      trigger={
        <>
          <BellIcon aria-hidden className="size-4" />
          {unread > 0 && (
            <span
              aria-hidden
              className={cn(
                'absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold',
                urgent > 0
                  ? 'bg-destructive text-destructive-foreground'
                  : 'bg-warning text-warning-foreground',
              )}
            >
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </>
      }
      className="w-80"
    >
      <MenuLabel>Needs attention</MenuLabel>

      {unread === 0 && (
        <p className="px-2.5 py-3 text-sm text-muted-foreground">
          Nothing waiting. Every queue is clear.
        </p>
      )}

      {items.map((item) => (
        <MenuItem
          key={item.id}
          onSelect={() => {
            open(item.id, item.href);
          }}
        >
          <span className="flex w-full items-start gap-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate">{item.title}</span>
              <span className="block text-xs text-muted-foreground">{formatRelative(item.at)}</span>
            </span>
            {item.severity === 'urgent' && <Badge variant="destructive">Urgent</Badge>}
          </span>
        </MenuItem>
      ))}

      <MenuSeparator />
      <MenuItem
        onSelect={() => {
          void navigate('/admin/notifications');
        }}
      >
        Open the notification centre
      </MenuItem>
    </Menu>
  );
}
