import type { UserDraft, UserStatus } from '@plastago/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { useServices } from '@/services/services-context';
import type { ListQuery } from '@/services/types';

export function useUserList(query: ListQuery) {
  const { users } = useServices();
  return useQuery({
    queryKey: queryKeys.users.list(query),
    queryFn: () => users.list(query),
    // Keeps the previous page on screen while the next one loads, so paging
    // does not flash an empty grid. The spinner in the toolbar says it is busy.
    placeholderData: (previous) => previous,
  });
}

export function useUser(id: string | undefined) {
  const { users } = useServices();
  return useQuery({
    queryKey: queryKeys.users.detail(id ?? 'none'),
    queryFn: () => users.get(id ?? ''),
    enabled: Boolean(id),
  });
}

/**
 * Mutations invalidate the whole `users` domain rather than patching the cache.
 *
 * A surgical cache update is tempting and usually wrong here: creating a user
 * changes counts, ordering and which page a row lands on, so the correct patch
 * is "refetch". The list is small and the request is cheap.
 */
export function useCreateUser() {
  const { users } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (draft: UserDraft) => users.create(draft),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.users.all }),
  });
}

export function useUpdateUser() {
  const { users } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, draft }: { id: string; draft: UserDraft }) => users.update(id, draft),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.users.all }),
  });
}

export function useSetUserStatus() {
  const { users } = useServices();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: UserStatus }) => users.setStatus(id, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.users.all }),
  });
}

export function useResendInvite() {
  const { users } = useServices();
  return useMutation({ mutationFn: (id: string) => users.resendInvite(id) });
}
