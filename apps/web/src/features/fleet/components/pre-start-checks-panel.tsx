import type { VehiclePreStart } from '@plastago/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DatePicker,
  EmptyState,
  ErrorState,
  Pagination,
  Skeleton,
} from '@plastago/ui';
import { ClipboardCheckIcon } from 'lucide-react';
import { useListQuery } from '@/components/data-table/use-list-query';
import { describeError } from '@/lib/error-message';
import { formatDate, formatDateTime } from '@/lib/format';
import { useVehiclePreStarts } from '../queries';

const HEADINGS = ['Date', 'Driver', 'Odometer', 'Failed items', ''] as const;

/**
 * A vehicle's pre-start checks (Matt, 21 Oct), a page at a time (23 Oct).
 *
 * All dates by default — this is the vehicle's history, which is what the
 * office audits — with a date to narrow it to one day. Paged on the server: a
 * check a day per truck grows without end. The page and the date sit in the
 * URL, like every other list, so a reload or a pasted link lands in place.
 */
export function PreStartChecksPanel({
  vehicleId,
  rego,
  active,
  onOpen,
}: {
  vehicleId: string;
  rego: string;
  /** Only fetched while its tab is open. */
  active: boolean;
  onOpen: (check: VehiclePreStart) => void;
}) {
  const listQuery = useListQuery({ paramPrefix: 'pre', filterKeys: ['date'], defaultPageSize: 10 });
  const date = listQuery.filters.date ?? '';
  const checks = useVehiclePreStarts(vehicleId, listQuery.query, active);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle>Pre-start checks</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <DatePicker
            aria-label="Show the checks for one date"
            className="w-44"
            value={date}
            placeholder="All dates"
            onValueChange={(value) => {
              listQuery.setFilter('date', value || undefined);
            }}
          />
          {date && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                listQuery.setFilter('date', undefined);
              }}
            >
              All dates
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {checks.error ? (
          <ErrorState
            title={describeError(checks.error).title}
            description={describeError(checks.error).detail}
            onRetry={() => void checks.refetch()}
          />
        ) : checks.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : checks.data.data.length === 0 ? (
          <EmptyState
            icon={ClipboardCheckIcon}
            title={date ? `No pre-start check on ${formatDate(date)}` : 'No pre-start checks yet'}
            description={
              date
                ? 'Pick another date, or show all dates.'
                : 'Drivers choose this vehicle in the driver app and complete the pre-start there; each check lands here.'
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Pre-start checks for {rego}</caption>
                <thead>
                  <tr className="border-b border-border">
                    {HEADINGS.map((heading, index) => (
                      <th
                        key={heading || 'open'}
                        scope="col"
                        // Padded on both sides: the right-aligned odometer sat
                        // flush against "Failed items" and read as one word.
                        className={`px-3 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase first:pl-0 last:pr-0 ${index === 2 ? 'text-right' : 'text-left'}`}
                      >
                        {heading === '' ? <span className="sr-only">Open</span> : heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {checks.data.data.map((check) => (
                    <tr key={check.id} className="border-b border-border [&>td]:px-3 [&>td:first-child]:pl-0 [&>td:last-child]:pr-0">
                      <td className="py-2.5 tabular-nums">{formatDateTime(check.completedAt)}</td>
                      <td className="py-2.5">{check.driverName}</td>
                      <td className="py-2.5 text-right tabular-nums">
                        {check.odometerKm.toLocaleString('en-AU')} km
                      </td>
                      <td className="py-2.5">
                        {check.failedItems.length === 0 ? (
                          <Badge variant="success">None</Badge>
                        ) : (
                          <span className="text-destructive">
                            {check.failedItems.map((item) => item.label).join(', ')}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            onOpen(check);
                          }}
                        >
                          Open
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={checks.data.meta.page}
              pageSize={checks.data.meta.pageSize}
              total={checks.data.meta.total}
              onPageChange={listQuery.setPage}
              onPageSizeChange={listQuery.setPageSize}
              pageSizeOptions={[10, 20, 50]}
              disabled={checks.isFetching}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
