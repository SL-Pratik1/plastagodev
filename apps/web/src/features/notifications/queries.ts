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
