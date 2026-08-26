import {
  JOB_STATUS_LABELS,
  type DailyVolumePoint,
  type ExceptionRatePoint,
  type StatusCount,
} from '@plastago/shared';
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';
import { formatDay } from '@/lib/format';
import { ChartFrame, ChartTooltip } from './chart-frame';

/**
 * The three dashboard charts.
 *
 * ── Colour, decided by the job each chart does ─────────────────────────────
 * Two of these carry a single measure, so they use the one-hue slot and take
 * their identity from the axis labels and the title — a legend for one series is
 * noise. Only the exception-rate chart plots two measures against each other, so
 * only it is a categorical palette, and it uses the blue/orange pair rather than
 * anything involving the brand green: green↔orange separate by ΔE 6.9 under
 * deuteranopia, which is inside the warn band. The pair here clears every gate
 * in both light and dark mode (worst ΔE 25.1).
 *
 * ── One axis, always ───────────────────────────────────────────────────────
 * Jobs and m² are both interesting per day and are NOT plotted together: they
 * are different scales, and a second y-axis is the single most misleading thing
 * a chart can do. Jobs are the line; m² lives in the tooltip and the table.
 *
 * Marks follow the spec: 2px strokes, 4px rounded bar ends anchored to the
 * baseline, ≥8px hover targets, recessive grid, and selective direct labels —
 * a number on the end of each bar, never on every point of a line.
 */

const AXIS_STYLE = { fontSize: 11, fill: 'var(--color-chart-axis)' } as const;
const GRID = 'var(--color-chart-grid)';

/**
 * Recharts' own tooltip-content props, narrowed to what we read.
 *
 * `payload[0].payload` is the original datum, which is why every tooltip below
 * pulls the whole row from it rather than reading the formatted series values —
 * the row carries fields the chart does not plot (square metres, for instance)
 * and the tooltip is the right place to surface them.
 */
type TooltipProps = TooltipContentProps;

function datum<TRow>(payload: TooltipProps['payload']): TRow | undefined {
  return payload?.[0]?.payload as TRow | undefined;
}

/* ── Jobs by status ─────────────────────────────────────────────────────── */

export function JobsByStatusChart({ data }: { data: readonly StatusCount[] }) {
  const rows = data.map((entry) => ({
    status: entry.status,
    label: JOB_STATUS_LABELS[entry.status],
    count: entry.count,
  }));

  return (
    <ChartFrame
      title="Jobs by status"
      description="Every job on the system, by where it has reached."
      tableHead={['Status', 'Jobs']}
      tableRows={rows.map((row) => [row.label, row.count])}
      height={Math.max(200, rows.length * 30)}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 44, bottom: 4, left: 4 }}>
          {/* Only the value axis gets grid lines — lines along the category axis
              add ink without helping anyone read a bar length. */}
          <CartesianGrid horizontal={false} stroke={GRID} />
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="label"
            width={110}
            tickLine={false}
            axisLine={false}
            tick={AXIS_STYLE}
          />
          <Tooltip
            cursor={{ fill: 'var(--color-muted)' }}
            content={({ active, payload }: TooltipProps) => {
              if (!active) return null;
              const row = datum<(typeof rows)[number]>(payload);
              if (!row) return null;
              return (
                <ChartTooltip
                  label={row.label}
                  rows={[{ label: 'Jobs', value: String(row.count) }]}
                />
              );
            }}
          />
          <Bar
            dataKey="count"
            fill="var(--color-chart-primary)"
            // Rounded on the data end only, so the bar stays anchored to zero.
            radius={[0, 4, 4, 0]}
            barSize={14}
            isAnimationActive={false}
          >
            <LabelList
              dataKey="count"
              position="right"
              offset={8}
              // Text wears text ink, never the series colour.
              style={{ fontSize: 11, fontWeight: 600, fill: 'var(--color-foreground)' }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/* ── Daily volume ───────────────────────────────────────────────────────── */

export function DailyVolumeChart({ data }: { data: readonly DailyVolumePoint[] }) {
  const rows = data.map((point) => ({ ...point, label: formatDay(point.date) }));

  return (
    <ChartFrame
      title="Jobs per day"
      description="Ready dates over the last fortnight. Square metres are in the tooltip and the data view."
      tableHead={['Day', 'Jobs', 'm²']}
      tableRows={rows.map((row) => [row.label, row.jobs, row.areaM2.toLocaleString('en-AU')])}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
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
            width={44}
          />
          <Tooltip
            cursor={{ stroke: GRID, strokeWidth: 1 }}
            content={({ active, payload }: TooltipProps) => {
              if (!active) return null;
              const row = datum<(typeof rows)[number]>(payload);
              if (!row) return null;
              return (
                <ChartTooltip
                  label={row.label}
                  rows={[
                    { label: 'Jobs', value: String(row.jobs) },
                    { label: 'Square metres', value: `${row.areaM2.toLocaleString('en-AU')} m²` },
                  ]}
                />
              );
            }}
          />
          <Line
            type="monotone"
            dataKey="jobs"
            stroke="var(--color-chart-primary)"
            strokeWidth={2}
            dot={false}
            // Hit target larger than the mark, per the interaction spec.
            activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--color-card)' }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/* ── Exception rates ────────────────────────────────────────────────────── */

export function ExceptionRateChart({ data }: { data: readonly ExceptionRatePoint[] }) {
  const rows = data.map((point) => ({ ...point, label: formatDay(point.weekStarting) }));

  return (
    <ChartFrame
      title="Futile and contamination rate"
      description="Share of jobs each week. Both carry a charge, so both are money as well as friction."
      series={[
        { label: 'Futile', color: 'var(--color-chart-series-1)' },
        { label: 'Contamination', color: 'var(--color-chart-series-2)' },
      ]}
      tableHead={['Week starting', 'Futile %', 'Contamination %']}
      tableRows={rows.map((row) => [row.label, row.futilePercent, row.contaminationPercent])}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={AXIS_STYLE} />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={AXIS_STYLE}
            width={44}
            unit="%"
            allowDecimals={false}
          />
          <Tooltip
            cursor={{ stroke: GRID, strokeWidth: 1 }}
            content={({ active, payload }: TooltipProps) => {
              if (!active) return null;
              const row = datum<(typeof rows)[number]>(payload);
              if (!row) return null;
              return (
                <ChartTooltip
                  label={`Week of ${row.label}`}
                  rows={[
                    {
                      label: 'Futile',
                      value: `${String(row.futilePercent)}%`,
                      color: 'var(--color-chart-series-1)',
                    },
                    {
                      label: 'Contamination',
                      value: `${String(row.contaminationPercent)}%`,
                      color: 'var(--color-chart-series-2)',
                    },
                  ]}
                />
              );
            }}
          />
          <Line
            type="monotone"
            dataKey="futilePercent"
            stroke="var(--color-chart-series-1)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--color-card)' }}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="contaminationPercent"
            stroke="var(--color-chart-series-2)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--color-card)' }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
