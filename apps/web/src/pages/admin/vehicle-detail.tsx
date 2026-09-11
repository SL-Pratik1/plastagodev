import {
  VEHICLE_EXPENSE_KIND_LABELS,
  VEHICLE_TYPE_LABELS,
  type VehicleDefect,
} from '@plastago/shared';
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
  Menu,
  MenuItem,
  MenuSeparator,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTrigger,
  useToast,
} from '@plastago/ui';
import {
  BanIcon,
  CalendarClockIcon,
  CheckIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
  UserIcon,
  WrenchIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { DetailList } from '@/components/detail-list';
import { ExpiryBadge } from '@/components/domain-badges';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { RenewRegistrationDialog } from '@/features/fleet/components/renew-registration-dialog';
import { ScheduleServiceDialog } from '@/features/fleet/components/schedule-service-dialog';
import { VehicleExpenseDialog } from '@/features/fleet/components/vehicle-expense-dialog';
import { VehicleFormDialog } from '@/features/fleet/components/vehicle-form-dialog';
import { useDriverOptions } from '@/features/lookups/queries';
import {
  useAssignVehicleDriver,
  useSetDefectState,
  useSetVehicleActive,
  useVehicle,
} from '@/features/fleet/queries';
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
  const setDefectState = useSetDefectState();
  const setActive = useSetVehicleActive();
  const assignDriver = useAssignVehicleDriver();
  const drivers = useDriverOptions();

  const [renewOpen, setRenewOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [expenseKind, setExpenseKind] = useState<'service' | 'other'>('other');
  const [serviceOpen, setServiceOpen] = useState(false);
  const [offRoadOpen, setOffRoadOpen] = useState(false);

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

  const moveDefect = async (defect: VehicleDefect, state: VehicleDefect['state']) => {
    try {
      await setDefectState.mutateAsync({ vehicleId: vehicle.id, defectId: defect.id, state });
      toast.success(
        state === 'resolved' ? 'Defect marked resolved' : 'Defect booked in',
        state === 'scheduled' ? 'It stays on the open count until the work is done.' : undefined,
      );
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const changeActive = async (active: boolean) => {
    try {
      await setActive.mutateAsync({ id: vehicle.id, active });
      toast.success(
        active ? `${vehicle.rego} back in service` : `${vehicle.rego} taken off the road`,
        active
          ? 'It can be assigned work again.'
          : 'Its history stays intact and you can put it back at any time.',
      );
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    } finally {
      setOffRoadOpen(false);
    }
  };

  const changeDriver = async (driverName: string | null) => {
    try {
      await assignDriver.mutateAsync({ id: vehicle.id, driverName });
      toast.success(
        driverName === null ? `${vehicle.rego} unassigned` : `${vehicle.rego} → ${driverName}`,
        'The drivers list shows the same pairing from the other side.',
      );
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const openExpense = (kind: 'service' | 'other') => {
    setExpenseKind(kind);
    setExpenseOpen(true);
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
          <div className="flex flex-wrap items-center gap-2">
            {vehicle.registrationState !== 'valid' && (
              <Button
                onClick={() => {
                  setRenewOpen(true);
                }}
              >
                <RotateCcwIcon aria-hidden />
                Log renewal
              </Button>
            )}
            {seesPricing && (
              <Button
                variant="outline"
                onClick={() => {
                  openExpense('other');
                }}
              >
                <PlusIcon aria-hidden />
                Log expense
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => {
                setEditOpen(true);
              }}
            >
              <PencilIcon aria-hidden />
              Edit
            </Button>
            {/*
              ── Why assignment and off-the-road live on a menu ────────────────
              Both are one-click decisions taken on their own, and neither has
              anything to do with the make and model. Putting them in the edit
              form would mean opening a ten-field dialog to park a broken truck;
              putting them on the toolbar would give a read-mostly page five
              competing buttons. A menu is the honest middle.
            */}
            <Menu
              align="end"
              triggerLabel={`More actions for ${vehicle.rego}`}
              triggerClassName="grid size-9 place-items-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              trigger={<MoreHorizontalIcon aria-hidden className="size-4" />}
            >
              <MenuItem
                icon={CalendarClockIcon}
                onSelect={() => {
                  setServiceOpen(true);
                }}
              >
                {vehicle.nextServiceDueOn === null ? 'Book next service' : 'Change service date'}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={UserIcon}
                onSelect={() => {
                  void changeDriver(null);
                }}
                disabled={vehicle.assignedDriverName === null}
              >
                Unassign driver
              </MenuItem>
              {(drivers.data ?? [])
                .filter((option) => option.label !== vehicle.assignedDriverName)
                .map((option) => (
                  <MenuItem
                    key={option.value}
                    onSelect={() => {
                      void changeDriver(option.label);
                    }}
                  >
                    Assign to {option.label}
                  </MenuItem>
                ))}
              <MenuSeparator />
              {vehicle.active ? (
                <MenuItem
                  icon={BanIcon}
                  tone="destructive"
                  onSelect={() => {
                    setOffRoadOpen(true);
                  }}
                >
                  Take out of service
                </MenuItem>
              ) : (
                <MenuItem
                  icon={CheckIcon}
                  onSelect={() => {
                    void changeActive(true);
                  }}
                >
                  Put back in service
                </MenuItem>
              )}
            </Menu>
          </div>
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
                    {
                      label: 'Assigned driver',
                      value: vehicle.assignedDriverName ?? 'Unassigned',
                    },
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

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setServiceOpen(true);
                  }}
                >
                  <CalendarClockIcon aria-hidden />
                  {vehicle.nextServiceDueOn === null ? 'Book next service' : 'Change service date'}
                </Button>
                {seesPricing && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      openExpense('service');
                    }}
                  >
                    <PlusIcon aria-hidden />
                    Log a service
                  </Button>
                )}
              </div>

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
            <CardHeader className="flex-row items-start justify-between gap-3">
              <CardTitle>Expense log</CardTitle>
              <Button
                size="sm"
                onClick={() => {
                  openExpense('other');
                }}
              >
                <PlusIcon aria-hidden />
                Log expense
              </Button>
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
                      {/*
                        open → scheduled → resolved.
                        "Booked in for Thursday" was the state with nowhere to
                        live: the only button was Mark resolved, so a defect
                        jumped from broken straight to fixed and anyone looking
                        at the list could not tell the difference between "we
                        have a plan" and "nobody has touched it".
                      */}
                      {defect.state === 'open' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void moveDefect(defect, 'scheduled')}
                          disabled={setDefectState.isPending}
                        >
                          <CalendarClockIcon aria-hidden />
                          Book in
                        </Button>
                      )}
                      {defect.state !== 'resolved' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void moveDefect(defect, 'resolved')}
                          disabled={setDefectState.isPending}
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
              >
                <RotateCcwIcon aria-hidden />
                Log renewal
              </Button>
            </CardContent>
          </Card>
        </TabsPanel>
      </Tabs>

      <VehicleFormDialog
        open={editOpen}
        onClose={() => {
          setEditOpen(false);
        }}
        vehicle={vehicle}
      />

      <VehicleExpenseDialog
        open={expenseOpen}
        onClose={() => {
          setExpenseOpen(false);
        }}
        vehicle={vehicle}
        defaultKind={expenseKind}
      />

      <ScheduleServiceDialog
        open={serviceOpen}
        onClose={() => {
          setServiceOpen(false);
        }}
        vehicle={vehicle}
      />

      {/*
        A full dialog rather than a ConfirmDialog, because the renewal rule is
        invisible and counter-intuitive: it rolls forward from the OLD expiry,
        so a late renewal does not lose the days already paid for. A yes/no box
        would flip the badge to green and teach nobody why.
      */}
      <RenewRegistrationDialog
        open={renewOpen}
        onClose={() => {
          setRenewOpen(false);
        }}
        vehicle={vehicle}
      />

      <ConfirmDialog
        open={offRoadOpen}
        onCancel={() => {
          setOffRoadOpen(false);
        }}
        onConfirm={() => {
          void changeActive(false);
        }}
        title={`Take ${vehicle.rego} out of service?`}
        description="It stops being available for work. Its jobs, expenses and defects all stay, and you can put it back at any time."
        confirmLabel="Take out of service"
        tone="destructive"
        pending={setActive.isPending}
      />
    </div>
  );
}
