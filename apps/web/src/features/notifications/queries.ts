import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { useServices } from '@/services/services-context';
import type { ListQuery } from '@/services/types';

export function useNotificationList(query: ListQuery) {
  const { notifications } = useServices();
  return useQuery({
    queryKey: queryKeys.notifications.list(query),
    queryFn: () => notifications.list(query),
    placeholderData: (previous) => previous,
  });
}

/**
 * The unread count for the shell's bell.
 *
 * Polled on the same interval as the dashboard, because it is answering the same
 * question — what needs attention right now — and a badge that only updates on
 * navigation is a badge that is usually wrong.
 */
export function useNotificationSummary() {
  const { notifications } = useServices();
  return useQuery({
    queryKey: queryKeys.notifications.summary(),
    queryFn: () => notifications.summary(),
    refetchInterval: 60_000,
  });
}

/** Unread driver messages, newest first — what the console's pop-up shows. */
const DRIVER_MESSAGES: ListQuery = {
  page: 1,
  pageSize: 20,
  filters: { category: 'message', unreadOnly: 'true' },
};

/**
 * Driver messages nobody has opened yet (Matt, 21 Oct: *"a message bubble down
 * the bottom … because otherwise they'll never know it's there"*).
 *
 * Every 20 seconds rather than the bell's minute: a driver asking a question
 * is usually standing on a site waiting for the answer. Customer messages share
 * the category, so the driver thread is picked out by where it links.
 */
export function useUnreadDriverMessages() {
  const { notifications } = useServices();
  return useQuery({
    queryKey: queryKeys.notifications.list(DRIVER_MESSAGES),
    queryFn: () => notifications.list(DRIVER_MESSAGES),
    refetchInterval: 20_000,
    select: (page) =>
      page.data.filter((item) => item.readAt === null && item.href.includes('thread=driver')),
  });
}

function useNotificationMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all }),
  });
}

export function useMarkNotificationsRead() {
  const { notifications } = useServices();
  return useNotificationMutation((ids: readonly string[]) => notifications.markRead(ids));
}

export function useMarkAllNotificationsRead() {
  const { notifications } = useServices();
  return useNotificationMutation(() => notifications.markAllRead());
}
