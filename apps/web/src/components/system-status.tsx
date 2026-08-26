import { ReadinessSchema, type DependencyCheck, type DependencyState } from '@plastago/shared';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Spinner,
} from '@plastago/ui';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { describeError } from '@/lib/error-message';
import { queryKeys } from '@/lib/query-keys';

const BADGE_VARIANT: Record<DependencyState, 'success' | 'destructive' | 'secondary'> = {
  up: 'success',
  down: 'destructive',
  disabled: 'secondary',
};

/**
 * Live readiness panel.
 *
 * This is not decoration — it is the scaffold's proof of life. It exercises the
 * whole vertical slice in one component: TanStack Query → typed api client →
 * dev proxy → Express → the shared Zod contract, and back.
 *
 * The pattern it demonstrates is the one to copy: fetch with a schema, render
 * the loading and error states explicitly, and never assume the happy path.
 */
export function SystemStatus() {
  const { data, error, isPending, isFetching, refetch } = useQuery({
    queryKey: queryKeys.health.readiness(),
    queryFn: ({ signal }) =>
      api.request('/readyz', {
        schema: ReadinessSchema,
        signal,
        // Degraded is a legitimate answer, not a request failure.
        acceptStatuses: [503],
      }),
    refetchInterval: 15_000,
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>API status</CardTitle>
          {isFetching && <Spinner />}
        </div>
        <CardDescription>
          Live <code className="text-xs">GET /readyz</code> through the Vite dev proxy, parsed
          against the shared contract.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3 text-sm">
        {isPending && <p className="text-muted-foreground">Checking…</p>}

        {/*
          Routed through `describeError` rather than rendering `error.message`.
          The raw message here is a transport fact — "Request failed with status
          502" — which is exactly what the error-copy standard forbids showing a
          user. One mapper, so this panel and every future screen say the same
          thing about the same failure.
        */}
        {error && (
          <div className="space-y-2">
            <p className="font-medium text-destructive">{describeError(error).title}</p>
            {describeError(error).detail && (
              <p className="text-xs text-muted-foreground">{describeError(error).detail}</p>
            )}
            <button
              type="button"
              onClick={() => void refetch()}
              className="focus-ring rounded text-xs underline underline-offset-4"
            >
              Retry
            </button>
          </div>
        )}

        {data && (
          <>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Overall</span>
              <Badge variant={data.status === 'ready' ? 'success' : 'warning'}>{data.status}</Badge>
            </div>
            <DependencyRow name="MongoDB" check={data.dependencies.mongo} />
            <DependencyRow name="Redis (BullMQ)" check={data.dependencies.redis} />
            <p className="pt-1 text-xs text-muted-foreground">
              {data.service} · v{data.version}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DependencyRow({ name, check }: { name: string; check: DependencyCheck }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{name}</span>
      <span className="flex items-center gap-2">
        {check.latencyMs !== undefined && (
          <span className="text-xs text-muted-foreground">{check.latencyMs} ms</span>
        )}
        {check.detail && check.state !== 'up' && (
          <span
            className="max-w-[16rem] truncate text-xs text-muted-foreground"
            title={check.detail}
          >
            {check.detail}
          </span>
        )}
        <Badge variant={BADGE_VARIANT[check.state]}>{check.state}</Badge>
      </span>
    </div>
  );
}
