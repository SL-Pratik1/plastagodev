import { JOB_STATUS_LABELS, type RunStop } from '@plastago/shared';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  ErrorState,
  Skeleton,
  buttonVariants,
  cn,
} from '@plastago/ui';
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  ClipboardCheckIcon,
  CloudUploadIcon,
  ScaleIcon,
  ShieldAlertIcon,
  TruckIcon,
  ZapIcon,
} from 'lucide-react';
import { Link } from 'react-router';
import { RUN_DATE } from '@/services/mock/fixtures/driver-run';
import { useRunSheet } from '@/features/driver/queries';

/**
 * Today's run (M4.1 · W35, W31, W38).
 *
 * ── Ordered by the run, never by anything else ────────────────────────────
 * No sorting, no filtering, no search. The allocator decided the order and the
 * driver works down it — "job 3 of 7" is how they think and how they talk to the
 * office. A sortable list would be a way to lose your place.
 *
 * ── The pre-start comes first because the law says so ─────────────────────
 * M4.8a: Chain of Responsibility under the Heavy Vehicle National Law makes the
 * pre-start an *operator* obligation, not just the driver's. So it is not a
 * checklist item buried in a menu — it sits above the run and stays there until
 * it is done.
 */
export function DriverRunSheetPage() {
  const { data, error, isPending, refetch } = useRunSheet(RUN_DATE);

  if (error) {
    return (
      <ErrorState
        title="Could not load your run"
        description="You may be out of coverage. Anything you have already done is saved on this phone."
        onRetry={() => void refetch()}
      />
    );
  }

  if (isPending || !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-40" />
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  const done = data.stops.filter((stop) =>
    ['completed', 'admin-complete', 'futile', 'cancelled'].includes(stop.status),
  );
  const remaining = data.stops.filter((stop) => !done.includes(stop));
  const next = remaining[0];

  return (
    <div className="space-y-4">
      <header>
        <h1 className="font-display text-lg font-semibold tracking-tight">Today&rsquo;s run</h1>
        <p className="text-sm text-muted-foreground">
          {done.length} of {data.stops.length} done
          {data.vehicleRego !== null && ` · ${data.vehicleRego}`}
        </p>
      </header>

      {/* ── M4.8a — the pre-start blocks the run ──────────────────────── */}
      {data.preStartCompletedAt === null ? (
        <Link
          to="/driver/pre-start"
          className="focus-ring block rounded-xl border border-warning/50 bg-warning/10 p-4"
        >
          <p className="flex items-center gap-2 text-sm font-semibold">
            <ClipboardCheckIcon aria-hidden className="size-5 shrink-0 text-warning" />
            Pre-start check not done
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Do this before you drive. It is a legal requirement on the operator as well as on you.
          </p>
        </Link>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2Icon aria-hidden className="size-3.5 shrink-0 text-success" />
          Pre-start done at{' '}
          {new Date(data.preStartCompletedAt).toLocaleTimeString('en-AU', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })}
        </p>
      )}

      {/* ── The next stop, called out ─────────────────────────────────── */}
      {next !== undefined && (
        <section aria-labelledby="next-stop" className="space-y-2">
          <h2
            id="next-stop"
            className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
          >
            Next stop
          </h2>
          <StopCard stop={next} emphasis />
        </section>
      )}

      {remaining.length > 1 && (
        <section aria-labelledby="later-stops" className="space-y-2">
          <h2
            id="later-stops"
            className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
          >
            Later today
          </h2>
          <ul className="space-y-2">
            {remaining.slice(1).map((stop) => (
              <li key={stop.jobId}>
                <StopCard stop={stop} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {done.length > 0 && (
        <section aria-labelledby="done-stops" className="space-y-2">
          <h2
            id="done-stops"
            className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
          >
            Finished
          </h2>
          <ul className="space-y-2">
            {done.map((stop) => (
              <li key={stop.jobId}>
                <StopCard stop={stop} muted />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/*
        ── M4.4 — the tip-off, per RUN ──────────────────────────────────
        A driver tips off between runs, not once at the end of the day (Matt,
        43:50), so each run prompts for its own docket as soon as its own stops
        are done — the afternoon run being untouched must not hold up recording
        the morning's weighbridge figure.
      */}
      {data.runs.map((run) => {
        const runDone = run.stops.every(
          (stop) => stop.status === 'completed' || stop.status === 'admin-complete',
        );
        if (run.stops.length === 0) return null;

        if (run.tipOffRecordedAt !== null) {
          return (
            <Card key={run.runId}>
              <CardContent className="flex items-center gap-2 py-4 text-sm">
                <CheckCircle2Icon aria-hidden className="size-4 shrink-0 text-success" />
                {run.runName} tipped off
                {run.tipOffKg !== null && ` at ${run.tipOffKg.toLocaleString('en-AU')} kg`}.
              </CardContent>
            </Card>
          );
        }

        if (!runDone) return null;

        return (
          <Alert
            key={run.runId}
            variant="info"
            title={`${run.runName} finished — record the tip-off`}
          >
            <p>
              Weigh this run&rsquo;s load off at the facility and enter the weighbridge figure. It
              is what the diversion certificates are built from.
            </p>
            <Link to="/driver/tip-off" className={buttonVariants({ size: 'sm' })}>
              <ScaleIcon aria-hidden />
              Record the tip-off
            </Link>
          </Alert>
        );
      })}
    </div>
  );
}

/**
 * One stop.
 *
 * The lot number is as prominent as the street number, and that is not a style
 * choice: their booking form literally pleads *"Please use both Lot and Street
 * Number where possible"*, because drivers get lost in greenfield estates where
 * street numbers do not exist yet.
 */
function StopCard({
  stop,
  emphasis = false,
  muted = false,
}: {
  stop: RunStop;
  emphasis?: boolean;
  muted?: boolean;
}) {
  const finished = ['completed', 'admin-complete'].includes(stop.status);
  const failed = stop.status === 'futile' || stop.status === 'cancelled';

  return (
    <Link
      to={`/driver/jobs/${stop.jobId}`}
      className={cn(
        'focus-ring flex items-center gap-3 rounded-xl border p-4',
        emphasis ? 'border-primary/45 bg-primary/[0.05]' : 'border-border bg-card',
        muted && 'opacity-75',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'grid size-9 shrink-0 place-items-center rounded-full text-sm font-bold',
          finished
            ? 'bg-success/15 text-success'
            : failed
              ? 'bg-destructive/15 text-destructive'
              : 'bg-primary/12 text-primary',
        )}
      >
        {stop.sequence}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-semibold">{stop.siteName}</span>
          {stop.urgent && (
            <Badge variant="warning">
              <ZapIcon aria-hidden className="size-3" />
              Urgent
            </Badge>
          )}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {stop.suburb} · {stop.accountName}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>{JOB_STATUS_LABELS[stop.status]}</span>
          <span aria-hidden>·</span>
          <span>{stop.expectedAreaM2.toLocaleString('en-AU')} m²</span>
          <span aria-hidden>·</span>
          <span>{stop.loadType === 'bagged' ? `${String(stop.bagCount)} bags` : 'hand load'}</span>
          {/* M4.8b — some builders will not let the driver start without it. */}
          {stop.riskAssessmentRequired && stop.riskAssessmentDoneAt === null && (
            <Badge variant="warning">
              <ShieldAlertIcon aria-hidden className="size-3" />
              Risk form
            </Badge>
          )}
          {/* M4.12 — the driver has to be able to see what is still only local. */}
          {stop.hasQueuedActions && (
            <Badge variant="secondary">
              <CloudUploadIcon aria-hidden className="size-3" />
              Queued
            </Badge>
          )}
        </span>
      </span>

      {emphasis ? (
        <TruckIcon aria-hidden className="size-5 shrink-0 text-primary" />
      ) : (
        <ChevronRightIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
      )}
    </Link>
  );
}
