import type { JobStatus, PortalJobListItem } from '@plastago/shared';
import { Badge, type BadgeProps } from '@plastago/ui';
import { CheckCircle2Icon, ClockIcon, TriangleAlertIcon, TruckIcon } from 'lucide-react';

/**
 * Job status, in the customer's words (M5.7).
 *
 * ── Why not reuse `JobStatusBadge` ────────────────────────────────────────
 * Because the office and the customer are asking different questions of the same
 * field. "Acknowledged" and "Admin complete" are internal workflow states that
 * mean nothing to a site supervisor, and "Futile" is a term from PlastaGo's cost
 * model, not from the customer's day. The office needs the precise state; the
 * customer needs to know whether a truck is coming.
 *
 * So the nine statuses collapse to six sentences, and two of them merge
 * deliberately: `acknowledged` reads the same as `assigned` (the customer does
 * not care that the driver tapped a button), and `admin-complete` reads the same
 * as `completed` (invoicing is not their milestone).
 */
const PORTAL_STATUS: Record<JobStatus, { label: string; variant: BadgeProps['variant'] }> = {
  booked: { label: 'Booked', variant: 'outline' },
  assigned: { label: 'Scheduled', variant: 'secondary' },
  acknowledged: { label: 'Scheduled', variant: 'secondary' },
  'in-transit': { label: 'Driver on the way', variant: 'default' },
  arrived: { label: 'Driver on site', variant: 'default' },
  completed: { label: 'Completed', variant: 'success' },
  'admin-complete': { label: 'Completed', variant: 'success' },
  // Named plainly rather than softened. The customer is charged for it, so
  // dressing it up as "attempted" would be the wrong kind of kindness.
  futile: { label: 'Could not collect', variant: 'destructive' },
  cancelled: { label: 'Cancelled', variant: 'outline' },
};

export function PickupStatusBadge({ status }: { status: JobStatus }) {
  const { label, variant } = PORTAL_STATUS[status];
  return (
    <Badge variant={variant}>
      {status === 'in-transit' || status === 'arrived' ? (
        <TruckIcon aria-hidden className="size-3" />
      ) : status === 'completed' || status === 'admin-complete' ? (
        <CheckCircle2Icon aria-hidden className="size-3" />
      ) : status === 'futile' ? (
        <TriangleAlertIcon aria-hidden className="size-3" />
      ) : null}
      {label}
    </Badge>
  );
}

/**
 * M5.2 · W86 — whether anyone has certified this pickup ready.
 *
 * Shown as a *prompt* when it is missing, not just a label, because this is the
 * single cheapest way to prevent a futile pickup: the truck is dispatched on the
 * strength of this promise, and an uncertified job is the one most likely to
 * waste it.
 *
 * Which statuses this is asked about lives in the contract as
 * `PENDING_READINESS_STATUSES` — see the note there for why.
 */
export function ReadinessBadge({ job }: { job: Pick<PortalJobListItem, 'readinessCertifiedAt'> }) {
  if (job.readinessCertifiedAt === null) {
    return (
      <Badge variant="warning">
        <ClockIcon aria-hidden className="size-3" />
        Not yet confirmed ready
      </Badge>
    );
  }
  return (
    <Badge variant="success">
      <CheckCircle2Icon aria-hidden className="size-3" />
      Confirmed ready
    </Badge>
  );
}
