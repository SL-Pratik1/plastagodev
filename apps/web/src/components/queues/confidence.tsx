import { Badge, cn, type BadgeProps } from '@plastago/ui';
import { BAND_LABEL, bandOf, percent, type ConfidenceBand } from './confidence-bands';

/**
 * Confidence, rendered two ways.
 *
 * The thresholds and the band names live in `confidence-bands.ts` — see the note
 * there for why the split exists and why the numbers match the pipeline's own.
 */
const BAND_VARIANT: Record<ConfidenceBand, BadgeProps['variant']> = {
  high: 'success',
  medium: 'warning',
  low: 'destructive',
};

export function ConfidenceBadge({ confidence }: { confidence: number }) {
  const band = bandOf(confidence);
  return (
    <Badge variant={BAND_VARIANT[band]} title={BAND_LABEL[band]}>
      <span className="tabular-nums">{percent(confidence)}</span>
    </Badge>
  );
}

/**
 * A bar as well as a number, because eight fields down a column the eye reads
 * length far faster than it reads two digits.
 */
export function ConfidenceBar({
  confidence,
  className,
}: {
  confidence: number;
  className?: string;
}) {
  const band = bandOf(confidence);

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${BAND_LABEL[band]}, ${percent(confidence)}`}
      >
        <div
          className={cn(
            'h-full rounded-full',
            band === 'high' ? 'bg-success' : band === 'medium' ? 'bg-warning' : 'bg-destructive',
          )}
          style={{ width: `${String(Math.max(4, Math.round(confidence * 100)))}%` }}
        />
      </div>
      <span aria-hidden className="text-xs text-muted-foreground tabular-nums">
        {percent(confidence)}
      </span>
    </div>
  );
}
