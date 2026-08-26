import {
  Alert,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Skeleton,
  buttonVariants,
} from '@plastago/ui';
import {
  ArrowRightIcon,
  CalendarCheckIcon,
  ClipboardCheckIcon,
  PlusCircleIcon,
  RecycleIcon,
  TriangleAlertIcon,
  TruckIcon,
} from 'lucide-react';
import { Link } from 'react-router';
import { PickupStatusBadge } from '@/components/portal/pickup-status';
import { StatCard } from '@/components/stat-card';
import { usePortalDashboard, usePortalScope } from '@/features/portal/queries';
import { describeError } from '@/lib/error-message';
import { formatArea, formatDate, formatMoney, formatWeight } from '@/lib/format';

/**
 * The customer dashboard (M5.7 · F26).
 *
 * ── This screen has one job: stop the phone call ───────────────────────────
 * M5.7's stated purpose is replacing *"phoning the office to ask"*, and every
 * one of those calls is a self-inflicted cost. So the layout is ordered by which
 * call it prevents, not by which data is interesting:
 *
 *  1. **When are you coming?** — the next pickup, at the top, in full.
 *  2. **Is anything late?** — at-risk count, but only when it is not zero.
 *  3. **Have I confirmed my sites are ready?** — the futile-pickup prompt.
 *  4. **What have we diverted?** — the number they put in ESG reporting.
 *  5. **What do we owe?** — administrators only.
 *
 * ── Zero is not shown as a tile ───────────────────────────────────────────
 * The at-risk and unconfirmed panels appear only when they have something in
 * them. On a phone, four tiles reading "0" push the one useful thing below the
 * fold and teach the reader that this screen has nothing to say.
 */
export function PortalDashboardPage() {
  const scope = usePortalScope();
  const { data, error, isPending, refetch } = usePortalDashboard();

  if (error && !data) {
    const described = describeError(error);
    return (
      <div className="space-y-5">
        <h1 className="font-display text-xl font-semibold tracking-tight">Your pickups</h1>
        <Card>
          <ErrorState
            title={described.title}
            description={described.detail}
            onRetry={() => void refetch()}
          />
        </Card>
      </div>
    );
  }

  const canSeePricing = scope.data?.canSeePricing ?? false;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-xl font-semibold tracking-tight">
            {scope.data ? scope.data.accountName : 'Your pickups'}
          </h1>
          <p className="text-sm text-muted-foreground">
            Everything booked, on the way and completed — without ringing the office.
          </p>
        </div>

        {/* The most valuable action in the product, so it is a real button in
            the header on every screen size, not only in the tab bar. */}
        <Link to="/portal/book" className={buttonVariants()}>
          <PlusCircleIcon aria-hidden />
          Book a pickup
        </Link>
      </header>

      {/* ── The next pickup ─────────────────────────────────────────────── */}
      {isPending ? (
        <Card className="p-5">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-3 h-7 w-56" />
          <Skeleton className="mt-2 h-4 w-40" />
        </Card>
      ) : data?.nextPickup ? (
        <Card className="border-primary/35 bg-primary/[0.04]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <CalendarCheckIcon aria-hidden className="size-4 text-primary" />
              Your next pickup
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="font-display text-lg font-semibold">
                  {formatDate(data.nextPickup.readyDate)}
                </p>
                <p className="truncate text-sm">{data.nextPickup.siteName}</p>
                <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <PickupStatusBadge status={data.nextPickup.status} />
                  {data.nextPickup.driverName !== null && (
                    <span className="flex items-center gap-1">
                      <TruckIcon aria-hidden className="size-3" />
                      {data.nextPickup.driverName}
                    </span>
                  )}
                  <span className="font-mono">#{data.nextPickup.jobNumber}</span>
                </p>
              </div>

              <Link
                to={`/portal/jobs/${data.nextPickup.jobId}`}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                View
                <ArrowRightIcon aria-hidden />
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-5">
            <div>
              <p className="text-sm font-medium">Nothing booked</p>
              <p className="text-sm text-muted-foreground">
                Book a pickup and it appears here with live status.
              </p>
            </div>
            <Link to="/portal/book" className={buttonVariants({ size: 'sm' })}>
              <PlusCircleIcon aria-hidden />
              Book a pickup
            </Link>
          </CardContent>
        </Card>
      )}

      {/* ── Only-when-it-matters prompts ────────────────────────────────── */}
      {(data?.awaitingReadinessConfirmation ?? 0) > 0 && (
        <Alert variant="warning" title="Confirm your sites are ready">
          <p>
            {data?.awaitingReadinessConfirmation} booked pickup
            {data?.awaitingReadinessConfirmation === 1 ? '' : 's'} have not been confirmed ready. If
            the driver arrives and the board is not accessible, a $120 futile fee applies — a
            30-second confirmation is the cheapest way to avoid it.
          </p>
          <Link
            to="/portal/jobs?readiness=unconfirmed"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <ClipboardCheckIcon aria-hidden />
            Review them
          </Link>
        </Alert>
      )}

      {(data?.atRiskJobs ?? 0) > 0 && (
        <Alert variant="info" title="Pickups nearing their target date">
          <p>
            {data?.atRiskJobs} pickup{data?.atRiskJobs === 1 ? '' : 's'} are at or past five
            business days from the ready date you gave us. We will be in touch — or call the office
            on 1300 395 438 if it has become urgent.
          </p>
        </Alert>
      )}

      {/* ── The numbers ─────────────────────────────────────────────────── */}
      <section aria-labelledby="portal-month" className="space-y-3">
        <h2 id="portal-month" className="text-sm font-semibold tracking-tight">
          This month
        </h2>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Open pickups"
            value={data?.openJobs ?? 0}
            hint="Booked through to on site"
            icon={TruckIcon}
            to="/portal/jobs?state=open"
            isPending={isPending}
          />
          <StatCard
            label="Completed"
            value={data?.completedThisMonth ?? 0}
            hint="This calendar month"
            icon={RecycleIcon}
            tone="positive"
            to="/portal/jobs?state=completed"
            isPending={isPending}
          />
          <StatCard
            label="Plasterboard collected"
            value={formatArea(data?.areaThisMonthM2)}
            hint="Square metres, completed pickups"
            isPending={isPending}
          />
          {/* Weight only where the account records it. A zero would read as
              "nothing was recovered", which is a different claim (M2.3). */}
          {scope.data?.capturesWeight === true ? (
            <StatCard
              label="Diverted from landfill"
              value={
                data?.tonnesThisMonth === null || data?.tonnesThisMonth === undefined
                  ? '—'
                  : formatWeight(data.tonnesThisMonth * 1000)
              }
              hint="Recovered weight, measured at the tip"
              tone="positive"
              isPending={isPending}
            />
          ) : (
            <StatCard
              label="Recycling bags"
              value={data === undefined ? '—' : 'Included'}
              hint="Supplied and collected with every pickup"
              isPending={isPending}
            />
          )}
        </div>
      </section>

      {/* ── Money, administrators only (M1.5) ──────────────────────────── */}
      {canSeePricing && (data?.outstandingInvoiceCount ?? 0) > 0 && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-4 py-5">
            <div>
              <p className="text-sm font-medium">
                {data?.outstandingInvoiceCount} outstanding invoice
                {data?.outstandingInvoiceCount === 1 ? '' : 's'}
              </p>
              <p className="font-display text-lg font-semibold tabular-nums">
                {formatMoney(data?.outstandingInvoiceTotalIncGst)}
                <span className="ml-1 text-xs font-normal text-muted-foreground">inc GST</span>
              </p>
            </div>
            <Link
              to="/portal/invoices?status=outstanding"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              View invoices
              <ArrowRightIcon aria-hidden />
            </Link>
          </CardContent>
        </Card>
      )}

      {!canSeePricing && (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          Pricing and invoices are managed by your account administrator. You can book, track and
          confirm pickups for your sites.
        </p>
      )}
    </div>
  );
}
