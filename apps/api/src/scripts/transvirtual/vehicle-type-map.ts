import type { VehicleType } from '@plastago/shared';

/**
 * TransVirtual's "Vehicle Type" tag → this system's `VEHICLE_TYPES`
 * (`crane-truck` | `hooklift` | `ute`).
 *
 * ⚠️ Deliberately incomplete. 3 of the 5 vehicles seen during the audit are
 * tagged "14T Tipper"/"11T Tipper" in TransVirtual, and neither reads
 * confidently as any of the 3 categories here — a tipper isn't obviously a
 * crane-truck or a hooklift, and guessing wrong has real consequences (which
 * jobs this vehicle can legally be assigned to). Unmapped tags are a hard
 * block for that one vehicle, not a guess.
 */
export const VEHICLE_TYPE_MAP: Record<string, VehicleType> = {
  utility: 'ute',
  'hooklift truck': 'hooklift',
};

export function resolveVehicleType(tvTypeTag: string): VehicleType | null {
  return VEHICLE_TYPE_MAP[tvTypeTag.trim().toLowerCase()] ?? null;
}
