import type { VehicleType } from '@plastago/shared';

/**
 * TransVirtual's "Vehicle Type" tag → this system's `VEHICLE_TYPES`
 * (`crane-truck` | `hooklift` | `ute` | `tipper`).
 *
 * 3 of the 5 vehicles seen during the audit are tagged "14T Tipper"/
 * "11T Tipper" in TransVirtual — confirmed with the client these are a real,
 * distinct vehicle type (not a crane-truck or hooklift), so `tipper` was
 * added to `VEHICLE_TYPES` rather than guessed into an existing category.
 */
export const VEHICLE_TYPE_MAP: Record<string, VehicleType> = {
  utility: 'ute',
  'hooklift truck': 'hooklift',
  '14t tipper': 'tipper',
  '11t tipper': 'tipper',
};

export function resolveVehicleType(tvTypeTag: string): VehicleType | null {
  return VEHICLE_TYPE_MAP[tvTypeTag.trim().toLowerCase()] ?? null;
}
