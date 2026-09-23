import type { JobStatus } from '@plastago/shared';

/**
 * TransVirtual consignment status → this system's `JOB_STATUSES`.
 *
 * ⚠️ Grounded in the REAL distinct values across all 5,280 historical
 * consignments (2026-09-22 capture) — not the ~70-value vocabulary the
 * platform's status-configuration screen lists as *possible*. Only 7 values
 * are ever actually used:
 *
 *   Completed 5049, AdministrationComplete 183, Assigned 30,
 *   DriverPickupAcknowledge 13, PickupFutileCompleted 3,
 *   PendingPickupAcknowledge 1, InTransit 1
 *
 * Every one of those 7 has a confident, direct mapping — there is no
 * "NEEDS_HUMAN_DECISION" bucket in the observed data. The fallback below
 * exists only for a genuinely new status TransVirtual might introduce after
 * this table was written, not because the historical data was ambiguous.
 */
export const STATUS_MAP: Record<string, JobStatus> = {
  pendingpickupacknowledge: 'booked',
  assigned: 'assigned',
  driverpickupacknowledge: 'assigned',
  intransit: 'in-transit',
  completed: 'completed',
  administrationcomplete: 'admin-complete',
  pickupfutilecompleted: 'futile',
};

export interface StatusResolution {
  status: JobStatus;
  confident: boolean;
}

/**
 * Resolves a TV status. An unrecognised value still gets a status — never
 * drops the job — derived from other signals on the row where possible;
 * `confident: false` means it should be flagged for a human to check rather
 * than trusted silently.
 */
export function resolveStatus(tvStatus: string, hasCompletionDate: boolean): StatusResolution {
  const known = STATUS_MAP[tvStatus.trim().toLowerCase()];
  if (known) return { status: known, confident: true };
  return { status: hasCompletionDate ? 'completed' : 'booked', confident: false };
}
