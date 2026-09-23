import { CHARGE_CODE_LABELS, type ChargeCode } from '@plastago/shared';

/**
 * TransVirtual's 9 "Additional Services" → this system's `CHARGE_CODES`.
 *
 * ⚠️ `CHARGE_CODE_LABELS` (packages/shared/src/schemas/jobs.ts) already reads
 * almost verbatim as TransVirtual's own service names — "Fuel levy — Wisdom",
 * "Tipping fuel levy (7.5%)" — because these codes were designed against this
 * same TransVirtual catalog. The 3 codes with no TransVirtual counterpart
 * (`service-fee`, `area-charge`, `extra-bags`) are this system's own and are
 * untouched by this migration.
 *
 * `driverRaisable`/`systemGenerated` are application-behaviour flags (which
 * screen may raise a charge) that TransVirtual's export has no equivalent
 * column for — sourced from `seed-settings.ts`'s own already-correct table,
 * not invented here.
 */
export const CHARGE_CODE_MAP: Record<string, ChargeCode> = {
  'contamination charge': 'contamination',
  'extra load time': 'extra-load-time',
  'fuel levy': 'fuel-levy',
  'fuel levy - wisdom': 'fuel-levy-wisdom',
  'fuel levy (10%)': 'fuel-levy-percent',
  'futile pickup': 'futile-pickup',
  'out of area': 'out-of-area',
  'recycling bags': 'recycling-bags',
  'tipping fuel levy (7.5%)': 'tipping-fuel-levy-percent',
};

/** Matches `seed-settings.ts`'s own values — not TransVirtual-sourced, TV has no such columns. */
const BEHAVIOUR_DEFAULTS: Record<ChargeCode, { requiresApproval: boolean; driverRaisable: boolean }> = {
  'service-fee': { requiresApproval: false, driverRaisable: false },
  'area-charge': { requiresApproval: false, driverRaisable: false },
  'recycling-bags': { requiresApproval: false, driverRaisable: false },
  'extra-bags': { requiresApproval: true, driverRaisable: true },
  contamination: { requiresApproval: true, driverRaisable: true },
  'extra-load-time': { requiresApproval: true, driverRaisable: true },
  'futile-pickup': { requiresApproval: true, driverRaisable: true },
  'fuel-levy': { requiresApproval: false, driverRaisable: false },
  'fuel-levy-wisdom': { requiresApproval: false, driverRaisable: false },
  'fuel-levy-percent': { requiresApproval: false, driverRaisable: false },
  'tipping-fuel-levy-percent': { requiresApproval: false, driverRaisable: false },
  'out-of-area': { requiresApproval: true, driverRaisable: true },
};

export interface ResolvedCharge {
  code: ChargeCode;
  label: string;
  requiresApproval: boolean;
  driverRaisable: boolean;
}

export function resolveChargeCode(tvServiceName: string): ResolvedCharge | null {
  const code = CHARGE_CODE_MAP[tvServiceName.trim().toLowerCase()];
  if (!code) return null;
  return { code, label: CHARGE_CODE_LABELS[code], ...BEHAVIOUR_DEFAULTS[code] };
}
