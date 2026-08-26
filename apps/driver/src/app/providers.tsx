import { ApiRequestError } from '@plastago/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { startOutboxSync } from '@/offline/outbox';

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Longer than the web app: a driver on a weak cell should reuse what
            // is already on screen rather than spin on a refetch.
            staleTime: 60_000,
            gcTime: 24 * 60 * 60 * 1_000,
            networkMode: 'offlineFirst',
            retry(failureCount, error) {
              if (error instanceof ApiRequestError && !error.isRetryable) return false;
              return failureCount < 3;
            },
            refetchOnWindowFocus: true,
          },
          mutations: {
            // Mutations do NOT go through TanStack Query on this app — every
            // write goes through the outbox so it survives a dead cell.
            retry: false,
          },
        },
      }),
  );

  useEffect(() => startOutboxSync(), []);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
