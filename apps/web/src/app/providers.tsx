import { ToastProvider } from '@plastago/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { AuthProvider } from '@/features/auth/auth-provider';
import { describeError } from '@/lib/error-message';
import { ServicesProvider } from '@/services/services-provider';
import type { Services } from '@/services/types';

export interface AppProvidersProps {
  /**
   * Injected rather than constructed here, so the choice of implementation
   * (mock today, HTTP later) lives at the entry point where it is visible — and
   * so a test can mount the real tree with stub services.
   */
  services: Services;
  children: ReactNode;
}

/**
 * App-wide providers. Kept separate from the router so tests can mount a tree
 * with real providers and a stub route.
 *
 * ── Order matters ─────────────────────────────────────────────────────────
 *   ThemeProvider      paints first, so there is no flash of the wrong theme
 *     ServicesProvider the data seam — everything below can call services
 *       QueryClient    server-state cache
 *         ToastProvider must be ABOVE anything that reports an outcome
 *           AuthProvider calls the auth service, and can raise a toast
 *
 * `AuthProvider` sits innermost of the four because it depends on all of them:
 * it reads a service, and signing out reports through a toast. Putting it above
 * `ToastProvider` would make that impossible.
 */
export function AppProviders({ services, children }: AppProvidersProps) {
  // Created in state, not at module scope: a module-level client is shared
  // between tests and leaks cache across them.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            /*
             * ── Retry only what retrying can fix ──────────────────────────
             * `describeError` already classifies every failure the app can
             * produce, and its `retryable` flag is the same judgement this
             * needs — so it is the single source of truth rather than a second
             * list that drifts from the first.
             *
             * This previously tested only `ApiRequestError`, which meant every
             * `ServiceError` — the type the entire service layer throws — was
             * retried twice with backoff. A 404 took about seven seconds to stop
             * showing a skeleton and start saying "Not found", which reads as a
             * hung screen rather than a missing record.
             */
            retry(failureCount, error) {
              if (!describeError(error).retryable) return false;
              return failureCount < 2;
            },
            refetchOnWindowFocus: false,
          },
          mutations: {
            retry: false,
          },
        },
      }),
  );

  return (
    <ThemeProvider>
      <ServicesProvider services={services}>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <AuthProvider>{children}</AuthProvider>
          </ToastProvider>
        </QueryClientProvider>
      </ServicesProvider>
    </ThemeProvider>
  );
}
