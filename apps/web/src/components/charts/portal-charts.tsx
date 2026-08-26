import type { MonthlyVolumePoint } from '@plastago/shared';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';
import { ChartFrame, ChartTooltip } from './chart-frame';

const AXIS_STYLE = { fill: 'var(--color-muted-foreground)', fontSize: 11 } as const;
const GRID = 'var(--color-border)';

// Recharts' own exported prop type, with its default generics — hand-rolling
// this shape is how the tooltip typing drifted last time.
type TooltipProps = TooltipContentProps;

function datum<TRow>(payload: TooltipProps['payload']): TRow | undefined {
  return payload?.[0]?.payload as TRow | undefined;
}

/**
 * The customer's monthly volume, by month (M5.11 · F1).
 *
 * ── Bars, not a line ──────────────────────────────────────────────────────
 * A line implies a continuous quantity sampled over time; monthly totals are
 * discrete buckets, and reading "how much did we do in March" off a line means
 * tracing to an axis. Bars answer that directly, which is the only question this
 * chart is asked.
 *
 * The palette token is `--color-chart-primary`, never a raw hex — those tokens
 * were validated for contrast and colour-vision safety in both themes, and a
 * hard-coded colour silently opts out of that.
 */
export function MonthlyVolumeChart({ data }: { data: readonly MonthlyVolumePoint[] }) {
  const rows = data.map((point) => ({
    ...point,
    label: new Intl.DateTimeFormat('en-AU', { month: 'short', year: '2-digit' }).format(
      new Date(`${point.month}-01T00:00:00Z`),
    ),
  }));

  return (
    <ChartFrame
      title="Plasterboard collected by month"
      description="Completed pickups only. Square metres are in the tooltip and the data view."
      tableHead={['Month', 'Pickups', 'm²']}
      tableRows={rows.map((row) => [row.label, row.jobs, row.areaM2.toLocaleString('en-AU')])}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={AXIS_STYLE}
            interval="preserveStartEnd"
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={AXIS_STYLE}
            allowDecimals={false}
            width={52}
          />
          <Tooltip
            cursor={{ fill: 'var(--color-muted)', opacity: 0.5 }}
            content={({ active, payload }: TooltipProps) => {
              if (!active) return null;
              const row = datum<(typeof rows)[number]>(payload);
              if (!row) return null;
              return (
                <ChartTooltip
                  label={row.label}
                  rows={[
                    { label: 'Pickups', value: String(row.jobs) },
                    { label: 'Square metres', value: `${row.areaM2.toLocaleString('en-AU')} m²` },
                  ]}
                />
              );
            }}
          />
          <Bar
            dataKey="areaM2"
            fill="var(--color-chart-primary)"
            radius={[4, 4, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
