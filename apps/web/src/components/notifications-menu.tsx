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
/**
 * Which product the bell is hanging in.
 *
 * ── Why the surface is a prop and not read from the URL ────────────────────
 * The two inboxes are the same feed with different audiences, and the only
 * things that differ are where "open the centre" goes and what an empty inbox
 * should say. Reading `location.pathname` to work that out would make the
 * component behave differently on a route it happens to be rendered under,
 * which is the kind of implicit coupling that breaks when a screen moves. The
 * shell knows which product it is; it says so.
 */
const SURFACE = {
  admin: {
    centre: '/admin/notifications',
    label: 'Needs attention',
    /* The office bell counts unactioned work, so an empty one is a real fact. */
    empty: 'Nothing waiting. Every queue is clear.',
  },
  portal: {
    centre: '/portal/notifications',
    label: 'Recent updates',
    empty: 'Nothing new. Updates about your pickups and invoices appear here.',
  },
} as const;

export function NotificationsMenu({
  tone = 'default',
  surface = 'admin',
}: {
  tone?: 'default' | 'sidebar';
  surface?: keyof typeof SURFACE;
}) {
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
      <MenuLabel>{SURFACE[surface].label}</MenuLabel>

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
          void navigate(SURFACE[surface].centre);
        }}
      >
        Open the notification centre
      </MenuItem>
    </Menu>
  );
}
