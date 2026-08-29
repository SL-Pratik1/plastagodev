import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_LABELS,
  type Notification,
} from '@plastago/shared';
import {
  Alert,
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
import {
  BellIcon,
  CheckIcon,
  CircleDollarSignIcon,
  ReceiptIcon,
  RefreshCwIcon,
  SettingsIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { Link } from 'react-router';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import { useListQuery } from '@/components/data-table/use-list-query';
import { PageHeader } from '@/components/page-header';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationsRead,
  useNotificationList,
  useNotificationSummary,
} from '@/features/notifications/queries';
import { describeError } from '@/lib/error-message';
import { formatMoney, formatRelative } from '@/lib/format';

/**
 * The notification centre (M8.7).
 *
 * ── What earns a place here ────────────────────────────────────────────────
 * Only things that need someone to act: the futile review, approvals and
 * awaiting-PO queues (M8.7), plus driver sync and background-job health because
 * this project has no error-tracking vendor (§6A.8) and fleet expiry reminders
 * (F43, F53).
 *
 * It is **not** a chat system — office↔driver chat is v1.1 and job-scoped
 * comments already cover that need. It is also not the customer SMS/email
 * stream: those go out to customers, they do not land in an office inbox.
 *
 * ── Why this screen exists at all ─────────────────────────────────────────
 * A futile pickup has sat unactioned in TransVirtual since 28 August 2025 — a
 * year, at $120, because nothing ever chased it. Ageing is therefore shown on
 * every row, and the list is a feed rather than a table: these are read
 * top-to-bottom and acted on, not sorted and compared.
 */
const FILTER_KEYS = ['category', 'read', 'severity'] as const;

const CATEGORY_ICON = {
  queue: CircleDollarSignIcon,
  exception: TriangleAlertIcon,
  invoice: ReceiptIcon,
  sync: RefreshCwIcon,
  system: SettingsIcon,
} as const;

export function AdminNotificationsPage() {
  const toast = useToast();
  const controller = useListQuery({ filterKeys: FILTER_KEYS, defaultPageSize: 20 });
  const { data, error, isPending, isFetching, refetch } = useNotificationList(controller.query);
  const summary = useNotificationSummary();

  const markRead = useMarkNotificationsRead();
  const markAllRead = useMarkAllNotificationsRead();

  const openOne = async (item: Notification) => {
    if (item.readAt !== null) return;
    try {
      await markRead.mutateAsync([item.id]);
    } catch {
      // Marking read is a convenience — failing it must not block navigation.
    }
  };

  const clearAll = async () => {
    try {
      await markAllRead.mutateAsync();
      toast.success('All notifications marked read');
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const unread = summary.data?.unread ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        description="Work that needs a decision, and anything quietly going wrong."
        badge={
          unread > 0 ? (
            <Badge variant="warning">{unread} unread</Badge>
          ) : (
            <Badge variant="success">All read</Badge>
          )
        }
        actions={
          unread > 0 ? (
            <Button
              variant="outline"
              onClick={() => void clearAll()}
              disabled={markAllRead.isPending}
            >
              {markAllRead.isPending && <Spinner className="text-current" />}
              <CheckIcon aria-hidden />
              Mark all read
            </Button>
          ) : undefined
        }
      />

      <Card className="overflow-hidden p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search notifications…"
          filters={[
            {
              key: 'read',
              label: 'Read',
              allLabel: 'Read and unread',
              options: [
                { value: 'unread', label: 'Unread only' },
                { value: 'read', label: 'Read only' },
              ],
            },
            {
              key: 'category',
              label: 'Category',
              allLabel: 'All categories',
              options: NOTIFICATION_CATEGORIES.map((category) => ({
                value: category,
                label: NOTIFICATION_CATEGORY_LABELS[category],
              })),
            },
            {
              key: 'severity',
              label: 'Severity',
              allLabel: 'Any severity',
              options: [
                { value: 'urgent', label: 'Urgent' },
                { value: 'action', label: 'Needs action' },
                { value: 'info', label: 'Information' },
              ],
            },
          ]}
        />

        {error ? (
          <ErrorState
            title={describeError(error).title}
            description={describeError(error).detail}
            onRetry={() => void refetch()}
          />
        ) : isPending ? (
          <ul className="divide-y divide-border" aria-busy>
            {[0, 1, 2, 3, 4].map((index) => (
              <li key={index} className="space-y-2 p-4">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-2/3" />
              </li>
            ))}
          </ul>
        ) : (data?.data.length ?? 0) === 0 ? (
          controller.isFiltered ? (
            <EmptyState
              variant="search"
              title="No matching notifications"
              description="Nothing matches these filters."
              action={
                <button
                  type="button"
                  onClick={controller.clearFilters}
                  className="focus-ring rounded text-sm font-medium text-primary underline-offset-4 hover:underline"
                >
                  Clear filters
                </button>
              }
            />
          ) : (
            <EmptyState
              icon={BellIcon}
              title="Nothing waiting"
              description="Every queue is clear and all devices are in sync."
            />
          )
        ) : (
          <ul className="divide-y divide-border">
            {(data?.data ?? []).map((item) => {
              const Icon = CATEGORY_ICON[item.category];
              const isUnread = item.readAt === null;

              return (
                <li
                  key={item.id}
                  className={cn('transition-colors', isUnread ? 'bg-accent/25' : undefined)}
                >
                  <div className="flex items-start gap-3 p-4">
                    <span
                      aria-hidden
                      className={cn(
                        'mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg',
                        item.severity === 'urgent'
                          ? 'bg-destructive/12 text-destructive'
                          : item.severity === 'action'
                            ? 'bg-warning/12 text-warning'
                            : 'bg-muted text-muted-foreground',
                      )}
                    >
                      <Icon className="size-4" />
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          to={item.href}
                          onClick={() => void openOne(item)}
                          className={cn(
                            'focus-ring rounded text-sm underline-offset-4 hover:underline',
                            isUnread ? 'font-semibold' : 'font-medium',
                          )}
                        >
                          {item.title}
                        </Link>
                        {item.severity === 'urgent' && <Badge variant="destructive">Urgent</Badge>}
                        {isUnread && (
                          <span aria-label="Unread" className="size-2 rounded-full bg-primary" />
                        )}
                      </div>

                      <p className="mt-0.5 text-sm text-muted-foreground">{item.body}</p>

                      <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                        <span>{NOTIFICATION_CATEGORY_LABELS[item.category]}</span>
                        <span>{formatRelative(item.at)}</span>
                        {item.valueExGst !== null && Number(item.valueExGst) > 0 && (
                          <span>{formatMoney(item.valueExGst)} ex GST</span>
                        )}
                      </p>
                    </div>

                    {isUnread && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void markRead.mutateAsync([item.id])}
                        disabled={markRead.isPending}
                      >
                        Mark read
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {data && data.data.length > 0 && (
          <Pagination
            page={data.meta.page}
            pageSize={data.meta.pageSize}
            total={data.meta.total}
            onPageChange={controller.setPage}
            onPageSizeChange={controller.setPageSize}
            pageSizeOptions={[5, 10, 15, 20]}
            disabled={isFetching}
          />
        )}
      </Card>

      <Alert variant="neutral" title="What lands here, and what does not">
        Queue depth, exceptions, invoicing blocks, fleet expiry and driver sync health. Customer SMS
        and email go out to customers rather than arriving here, and office↔driver conversation
        lives on the job it is about.
      </Alert>
    </div>
  );
}
