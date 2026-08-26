import { VEHICLE_EXPENSE_KIND_LABELS, VEHICLE_TYPE_LABELS } from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Skeleton,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTrigger,
  useToast,
} from '@plastago/ui';
import { RotateCcwIcon, TriangleAlertIcon, WrenchIcon } from 'lucide-react';
import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { DetailList } from '@/components/detail-list';
import { ExpiryBadge } from '@/components/domain-badges';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { useRenewRegistration, useResolveDefect, useVehicle } from '@/features/fleet/queries';
import { describeError } from '@/lib/error-message';
import { useAuth } from '@/features/auth/auth-context';
import { formatDate, formatMoney } from '@/lib/format';

const TABS = ['overview', 'maintenance', 'expenses', 'defects', 'registration'] as const;
type TabKey = (typeof TABS)[number];

/**
 * One vehicle (M9.7 · F43).
 */
export function AdminVehicleDetailPage() {
  const { vehicleId } = useParams();
  const [params, setParams] = useSearchParams();
  const toast = useToast();

  const { can } = useAuth();
  const { data: vehicle, error, isPending, refetch } = useVehicle(vehicleId);
  const renewRegistration = useRenewRegistration();
  const resolveDefect = useResolveDefect();

  const [renewOpen, setRenewOpen] = useState(false);

  const visibleTabs: readonly TabKey[] = can('pricing:view')
    ? TABS
    : TABS.filter((key) => key !== 'expenses');

  const rawTab = params.get('tab');
  const tab: TabKey = (visibleTabs as readonly string[]).includes(rawTab ?? '')
    ? (rawTab as TabKey)
    : 'overview';

  const setTab = (next: string) => {
    setParams(
      (current) => {
        const nextParams = new URLSearchParams(current);
        if (next === 'overview') nextParams.delete('tab');
        else nextParams.set('tab', next);
        return nextParams;
      },
      { replace: true },
    );
  };

  const breadcrumbs = [{ label: 'Vehicles', to: '/admin/vehicles' }];

  if (error) {
    const described = describeError(error);
    return (
      <div className="space-y-6">
        <PageHeader title="Vehicle" breadcrumbs={breadcrumbs} />
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

  if (isPending || !vehicle) {
    return (
      <div className="space-y-6">
        <PageHeader title="Loading…" breadcrumbs={breadcrumbs} />
        <Card className="p-5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-4 h-40 w-full" />
        </Card>
      </div>
    );
  }

  const renew = async () => {
    try {
      const updated = await renewRegistration.mutateAsync(vehicle.id);
      toast.success(
        'Registration renewed',
        `Now expires ${formatDate(updated.registrationExpiresOn)} — rolled forward ${String(vehicle.registrationPeriodMonths)} months.`,
      );
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    } finally {
      setRenewOpen(false);
    }
  };

  const resolve = async (defectId: string) => {
    try {
      await resolveDefect.mutateAsync({ vehicleId: vehicle.id, defectId });
      toast.success('Defect marked resolved');
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const openDefects = vehicle.defects.filter((defect) => defect.state !== 'resolved');
  const serviceExpenses = vehicle.expenses.filter((expense) => expense.kind === 'service');

  /*
   * ── The Allocator gets maintenance, not cost (M1.5, W113) ─────────────────
   * W113 is "manage and schedule vehicle maintenance": registration expiry,
   * services due, driver-reported defects. Cost per km and the expense ledger
   * are the *commercial* half of F43 — they exist to improve the margin figure
   * (M6.8), which is not the driver manager's question.
   */
  const seesPricing = can('pricing:view');

  return (
    <div className="space-y-6">
      <PageHeader
        title={vehicle.rego}
        breadcrumbs={breadcrumbs}
        description={`${vehicle.label} · ${VEHICLE_TYPE_LABELS[vehicle.type]}`}
        badge={
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge variant={vehicle.active ? 'success' : 'outline'}>
              {vehicle.active ? 'In service' : 'Out of service'}
            </Badge>
            <ExpiryBadge state={vehicle.registrationState} />
          </span>
        }
        actions={
          vehicle.registrationState !== 'valid' ? (
            <Button
              onClick={() => {
                setRenewOpen(true);
              }}
            >
              <RotateCcwIcon aria-hidden />
              Log renewal
            </Button>
          ) : undefined
        }
      />

      {vehicle.registrationState === 'expired' && (
        <Alert variant="destructive" title="Registration has expired">
          This vehicle should not be on the road. Logging the renewal rolls the expiry forward by
          the registered period.
        </Alert>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList label="Vehicle sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="maintenance" badge={serviceExpenses.length || undefined}>
            Maintenance
          </TabsTrigger>
          {seesPricing && (
            <TabsTrigger value="expenses" badge={vehicle.expenses.length || undefined}>
              Expenses
            </TabsTrigger>
          )}
          <TabsTrigger value="defects" badge={openDefects.length || undefined}>
            Defects
          </TabsTrigger>
          <TabsTrigger value="registration">Registration</TabsTrigger>
        </TabsList>

        {/* ── Overview ─────────────────────────────────────────────────── */}
        <TabsPanel value="overview">
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label="Odometer"
                value={`${vehicle.odometerKm.toLocaleString('en-AU')} km`}
                hint="Latest reading"
              />
              {seesPricing && (
                <>
                  <StatCard
                    label="Cost per km"
                    value={vehicle.costPerKm === null ? '—' : formatMoney(vehicle.costPerKm)}
                    hint="Expenses ÷ distance covered"
                  />
                  <StatCard
                    label="Total expenses"
                    value={formatMoney(vehicle.totalExpensesExGst)}
                    hint={`${String(vehicle.expenses.length)} entries, ex GST`}
                  />
                </>
              )}
              <StatCard
                label="Open defects"
                value={openDefects.length}
                tone={openDefects.length > 0 ? 'attention' : 'positive'}
                hint="Reported by drivers"
              />
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Details</CardTitle>
              </CardHeader>
              <CardContent>
                <DetailList
                  columns={3}
                  items={[
                    { label: 'Registration', value: vehicle.rego },
                    { label: 'Make and model', value: `${vehicle.make} ${vehicle.model}` },
                    { label: 'Year', value: vehicle.year ?? '—' },
                    { label: 'Type', value: VEHICLE_TYPE_LABELS[vehicle.type] },
                    { label: 'Assigned driver', value: vehicle.assignedDriverName ?? 'Unassigned' },
                    { label: 'Purchased', value: formatDate(vehicle.purchasedOn) },
                    {
                      label: 'Distance covered by expense log',
                      value:
                        vehicle.distanceSinceFirstExpenseKm === null
                          ? '—'
                          : `${vehicle.distanceSinceFirstExpenseKm.toLocaleString('en-AU')} km`,
                    },
                    { label: 'Notes', value: vehicle.notes || '—', wide: true },
                  ]}
                />
              </CardContent>
            </Card>
          </div>
        </TabsPanel>

        {/* ── Maintenance ──────────────────────────────────────────────── */}
        <TabsPanel value="maintenance">
          <Card>
            <CardHeader>
              <CardTitle>Service history</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <DetailList
                columns={3}
                items={[
                  { label: 'Last service', value: formatDate(vehicle.lastServiceOn) },
                  {
                    label: 'Next service due',
                    value: (
                      <span className="flex items-center gap-2">
                        {formatDate(vehicle.nextServiceDueOn)}
                        <ExpiryBadge state={vehicle.serviceState} />
                      </span>
                    ),
                  },
                  { label: 'Services logged', value: serviceExpenses.length },
                ]}
              />

              {serviceExpenses.length === 0 ? (
                <EmptyState
                  icon={WrenchIcon}
                  title="No services logged"
                  description="Log a service as an expense with its odometer reading."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {serviceExpenses.map((expense) => (
                    <li key={expense.id} className="flex flex-wrap items-center gap-3 py-3">
                      <WrenchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{expense.description}</p>
                        <p className="text-xs text-muted-foreground tabular-nums">
                          {formatDate(expense.incurredOn)} ·{' '}
                          {expense.odometerKm.toLocaleString('en-AU')} km
                          {expense.supplier ? ` · ${expense.supplier}` : ''}
                        </p>
                      </div>
                      <span className="font-medium tabular-nums">
                        {formatMoney(expense.amountExGst)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsPanel>

        {/* ── Expenses ─────────────────────────────────────────────────── */}
        <TabsPanel value="expenses">
          <Card>
            <CardHeader>
              <CardTitle>Expense log</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">Expenses for {vehicle.rego}</caption>
                  <thead>
                    <tr className="border-b border-border">
                      {['Date', 'Kind', 'Description', 'Odometer', 'Amount ex GST'].map(
                        (heading, index) => (
                          <th
                            key={heading}
                            scope="col"
                            className={`py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase ${index > 2 ? 'text-right' : 'text-left'}`}
                          >
                            {heading}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {vehicle.expenses.map((expense) => (
                      <tr key={expense.id} className="border-b border-border">
                        <td className="py-2.5 tabular-nums">{formatDate(expense.incurredOn)}</td>
                        <td className="py-2.5">
                          <Badge variant="outline">
                            {VEHICLE_EXPENSE_KIND_LABELS[expense.kind]}
                          </Badge>
                        </td>
                        <td className="py-2.5">
                          <span className="block">{expense.description}</span>
                          {expense.supplier && (
                            <span className="block text-xs text-muted-foreground">
                              {expense.supplier}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 text-right tabular-nums">
                          {expense.odometerKm.toLocaleString('en-AU')} km
                        </td>
                        <td className="py-2.5 text-right font-medium tabular-nums">
                          {formatMoney(expense.amountExGst)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4} className="py-2.5 text-right font-medium">
                        Total ex GST
                      </td>
                      <td className="py-2.5 text-right font-display font-semibold tabular-nums">
                        {formatMoney(vehicle.totalExpensesExGst)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              <p className="mt-4 text-xs text-muted-foreground">
                The odometer reading on each entry is what makes cost per kilometre computable — it
                is not optional detail.
              </p>
            </CardContent>
          </Card>
        </TabsPanel>

        {/* ── Defects ──────────────────────────────────────────────────── */}
        <TabsPanel value="defects">
          <Card>
            <CardHeader>
              <CardTitle>Driver-reported defects</CardTitle>
            </CardHeader>
            <CardContent>
              {vehicle.defects.length === 0 ? (
                <EmptyState
                  icon={TriangleAlertIcon}
                  title="No defects reported"
                  description="Drivers log vehicle problems with a photo from the driver app; they arrive here."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {vehicle.defects.map((defect) => (
                    <li key={defect.id} className="flex flex-wrap items-center gap-3 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{defect.summary}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatDate(defect.reportedOn)} · {defect.reportedBy}
                          {defect.photoCount > 0
                            ? ` · ${String(defect.photoCount)} photo${defect.photoCount === 1 ? '' : 's'}`
                            : ''}
                        </p>
                      </div>
                      <Badge
                        variant={
                          defect.severity === 'high'
                            ? 'destructive'
                            : defect.severity === 'medium'
                              ? 'warning'
                              : 'outline'
                        }
                      >
                        {defect.severity}
                      </Badge>
                      <Badge variant={defect.state === 'resolved' ? 'success' : 'secondary'}>
                        {defect.state}
                      </Badge>
                      {defect.state !== 'resolved' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void resolve(defect.id)}
                          disabled={resolveDefect.isPending}
                        >
                          Mark resolved
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsPanel>

        {/* ── Registration ─────────────────────────────────────────────── */}
        <TabsPanel value="registration">
          <Card>
            <CardHeader>
              <CardTitle>Registration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <DetailList
                columns={2}
                items={[
                  {
                    label: 'Expires',
                    value: (
                      <span className="flex items-center gap-2">
                        {formatDate(vehicle.registrationExpiresOn)}
                        <ExpiryBadge state={vehicle.registrationState} />
                      </span>
                    ),
                  },
                  {
                    label: 'Registered period',
                    value: `${String(vehicle.registrationPeriodMonths)} months`,
                  },
                ]}
              />

              <Alert variant="info" title="How the reminder works">
                A notification goes out two weeks before expiry. Logging the renewal rolls the
                expiry forward by the registered period — 12, 6 or 3 months — from the current
                expiry date, so a late renewal does not quietly shorten the next one.
              </Alert>

              <Button
                onClick={() => {
                  setRenewOpen(true);
                }}
                disabled={renewRegistration.isPending}
              >
                <RotateCcwIcon aria-hidden />
                Log renewal
              </Button>
            </CardContent>
          </Card>
        </TabsPanel>
      </Tabs>

      <ConfirmDialog
        open={renewOpen}
        onCancel={() => {
          setRenewOpen(false);
        }}
        onConfirm={() => void renew()}
        title="Log the registration renewal?"
        description={`The expiry will roll forward ${String(vehicle.registrationPeriodMonths)} months from ${formatDate(vehicle.registrationExpiresOn)}.`}
        confirmLabel="Log renewal"
        pending={renewRegistration.isPending}
      />
    </div>
  );
}
