import { RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './button.js';
import { cn } from '../lib/utils.js';

export interface ErrorStateProps {
  title?: string;
  description?: ReactNode;
  /** Omit when nothing the user can do would help. */
  onRetry?: () => void;
  retryLabel?: string;
  /** Correlates with a server log line — the only clue we get (§6A.8). */
  requestId?: string | undefined;
  className?: string;
}

/**
 * A failed load, in place, with a way out.
 *
 * There is no error-tracking vendor on this project by decision (§6A.8), so a
 * failure the user cannot describe is a failure nobody hears about. That is why
 * `requestId` is surfaced rather than swallowed: it is the one string that maps
 * a user's complaint to a structured log line.
 */
export function ErrorState({
  title = 'Something went wrong',
  description,
  onRetry,
  retryLabel = 'Try again',
  requestId,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-14 text-center',
        className,
      )}
    >
      <span
        aria-hidden
        className="grid size-11 place-items-center rounded-full bg-destructive/10 text-destructive"
      >
        <TriangleAlertIcon className="size-5" />
      </span>

      <div className="space-y-1">
        <p className="font-display text-sm font-semibold tracking-tight">{title}</p>
        {description && (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">{description}</p>
        )}
      </div>

      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCwIcon aria-hidden />
          {retryLabel}
        </Button>
      )}

      {requestId && (
        <p className="text-xs text-muted-foreground">
          Reference <code className="font-mono">{requestId}</code>
        </p>
      )}
    </div>
  );
}
