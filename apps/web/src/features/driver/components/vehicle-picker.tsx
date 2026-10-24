import type { DriverVehicleOption } from '@plastago/shared';
import { Alert, Button, ErrorState, Skeleton, Spinner, buttonVariants, cn, useToast } from '@plastago/ui';
import { CheckIcon, TruckIcon } from 'lucide-react';
import { useState } from 'react';
import { describeError } from '@/lib/error-message';
import { useChooseVehicle, useDriverVehicles } from '../queries';

export interface VehiclePickerProps {
  /** The vehicle already chosen today, so it starts selected. */
  currentId: string | null;
  /** After a successful choice. */
  onChosen: () => void;
  /** Shown when changing an existing choice; omitted on the first pick of the day. */
  onCancel?: () => void;
}

/**
 * Today's vehicle, chosen before the pre-start.
 *
 * Matt, 21 Oct: *"Rather than assign vehicles, drivers should select the vehicle
 * they are driving that day and complete pre-start from there."* One driver per
 * vehicle per day, so a vehicle another driver chose shows "Taken by X" and
 * cannot be picked. Needs signal — the answer has to come from the office.
 */
export function VehiclePicker({ currentId, onChosen, onCancel }: VehiclePickerProps) {
  const toast = useToast();
  const vehicles = useDriverVehicles(true);
  const choose = useChooseVehicle();
  const [selected, setSelected] = useState<string | null>(currentId);

  const confirm = async () => {
    const vehicle = vehicles.data?.vehicles.find((option) => option.id === selected);
    if (!vehicle) return;

    try {
      await choose.mutateAsync({ vehicleId: vehicle.id });
      toast.success(`${vehicle.rego} is your vehicle today`, 'Now do its pre-start check.');
      onChosen();
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
      // Somebody may have just taken it — show who.
      void vehicles.refetch();
    }
  };

  if (vehicles.error) {
    const described = describeError(vehicles.error);
    return (
      <ErrorState
        title={described.title}
        description={`${described.detail ?? ''} Choosing a vehicle needs signal.`.trim()}
        onRetry={() => void vehicles.refetch()}
      />
    );
  }

  if (vehicles.isPending) {
    return (
      <div className="space-y-2" aria-busy="true">
        {[0, 1, 2].map((key) => (
          <Skeleton key={key} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (vehicles.data.vehicles.length === 0) {
    return (
      <Alert variant="warning" title="No vehicles are in service">
        Ring the office — every vehicle is marked out of service.
      </Alert>
    );
  }

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-labelledby="vehicle-picker-label" className="space-y-2">
        <p id="vehicle-picker-label" className="text-sm font-medium">
          Which vehicle are you driving today?
        </p>
        {vehicles.data.vehicles.map((vehicle) => (
          <VehicleOption
            key={vehicle.id}
            vehicle={vehicle}
            selected={selected === vehicle.id}
            onSelect={() => {
              setSelected(vehicle.id);
            }}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={() => void confirm()}
        disabled={selected === null || choose.isPending}
        className={`${buttonVariants({ size: 'lg' })} min-h-14 w-full text-base`}
      >
        {choose.isPending && <Spinner label="Saving" />}
        Use this vehicle
      </button>
      {onCancel && (
        <Button variant="outline" className="w-full" onClick={onCancel} disabled={choose.isPending}>
          Keep my current vehicle
        </Button>
      )}
    </div>
  );
}

function VehicleOption({
  vehicle,
  selected,
  onSelect,
}: {
  vehicle: DriverVehicleOption;
  selected: boolean;
  onSelect: () => void;
}) {
  const taken = vehicle.takenBy !== null;

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={taken}
      onClick={onSelect}
      className={cn(
        'focus-ring flex min-h-16 w-full items-center gap-3 rounded-xl border p-3 text-left',
        selected ? 'border-brand-600 bg-brand-600/10' : 'border-border bg-card',
        taken && 'cursor-not-allowed opacity-60',
      )}
    >
      <TruckIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold tabular-nums">{vehicle.rego}</span>
        <span className="block truncate text-xs text-muted-foreground">{vehicle.label}</span>
      </span>
      {taken ? (
        <span className="text-xs font-medium text-muted-foreground">Taken by {vehicle.takenBy}</span>
      ) : vehicle.mine ? (
        <span className="text-xs font-medium text-success">Your vehicle today</span>
      ) : null}
      {selected && <CheckIcon aria-hidden className="size-5 shrink-0 text-brand-600" />}
    </button>
  );
}
