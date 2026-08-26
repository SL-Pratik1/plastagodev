import { Card, CardContent, CardDescription, CardHeader, CardTitle, cn } from '@plastago/ui';
import { TableIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';

export interface ChartSeries {
  label: string;
  /** A CSS colour — always a `--color-chart-*` token, never a raw hex. */
  color: string;
}

export interface ChartFrameProps {
  title: string;
  description?: string;
  /** Rendered as a legend. Omit for a single series — the title names it. */
  series?: readonly ChartSeries[];
  /** Column headings for the table view. */
  tableHead: readonly string[];
  /** Rows for the table view, already formatted. */
  tableRows: ReadonlyArray<readonly (string | number)[]>;
  /** Toolbar slot — a range selector, usually. */
  action?: ReactNode;
  height?: number;
  children: ReactNode;
  className?: string;
}

/**
 * The frame every chart sits in: title, legend, and a table view.
 *
 * ── Why the table view is not optional ─────────────────────────────────────
 * A chart encodes numbers in geometry and colour, and both are lossy for some
 * readers: a screen reader gets nothing from an SVG path, and two of our series
 * colours are distinguishable but not equally so under every kind of colour
 * vision. The table is the same data in a form that never fails, and it is one
 * click away rather than a separate page — which is the only reason people use
 * it. It also makes "what was Tuesday's number exactly?" answerable, which a
 * line chart genuinely cannot do.
 *
 * The legend renders a coloured mark beside text in the normal ink colour. Text
 * never wears the series colour: coloured labels lose contrast against the card
 * and stop reading as text.
 */
export function ChartFrame({
  title,
  description,
  series,
  tableHead,
  tableRows,
  action,
  height = 240,
  children,
  className,
}: ChartFrameProps) {
  const [showTable, setShowTable] = useState(false);

  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle>{title}</CardTitle>
            {description && <CardDescription className="mt-1">{description}</CardDescription>}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {action}
            <button
              type="button"
              onClick={() => {
                setShowTable((current) => !current);
              }}
              aria-pressed={showTable}
              className="focus-ring flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <TableIcon aria-hidden className="size-3.5" />
              {showTable ? 'Chart' : 'Data'}
            </button>
          </div>
        </div>

        {series && series.length > 1 && (
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {series.map((entry) => (
              <li
                key={entry.label}
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: entry.color }}
                />
                {entry.label}
              </li>
            ))}
          </ul>
        )}
      </CardHeader>

      <CardContent className="min-w-0 flex-1">
        {showTable ? (
          <div className="max-h-60 overflow-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">{title}</caption>
              <thead>
                <tr>
                  {tableHead.map((heading, index) => (
                    <th
                      key={heading}
                      scope="col"
                      className={cn(
                        'sticky top-0 border-b border-border bg-card py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase',
                        index === 0 ? 'text-left' : 'text-right',
                      )}
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableRows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td
                        key={cellIndex}
                        className={cn(
                          'border-b border-border py-1.5',
                          cellIndex === 0 ? 'text-left' : 'text-right tabular-nums',
                        )}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ height }} className="w-full">
            {children}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Shared tooltip body.
 *
 * Recharts' default tooltip is a white box with inline styles that ignores the
 * theme entirely — in dark mode it is a glaring white rectangle. This one wears
 * the popover tokens like every other floating surface in the console.
 */
export function ChartTooltip({
  label,
  rows,
}: {
  label: ReactNode;
  rows: ReadonlyArray<{ label: string; value: string; color?: string }>;
}) {
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-medium text-popover-foreground">{label}</p>
      <ul className="space-y-0.5">
        {rows.map((row) => (
          <li key={row.label} className="flex items-center gap-2 text-muted-foreground">
            {row.color && (
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-[2px]"
                style={{ backgroundColor: row.color }}
              />
            )}
            <span>{row.label}</span>
            <span className="ml-auto font-medium tabular-nums text-popover-foreground">
              {row.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
