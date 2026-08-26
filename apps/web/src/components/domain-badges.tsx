import {
  EXPIRY_STATE_LABELS,
  INVOICE_STATUS_LABELS,
  JOB_STATUS_LABELS,
  USER_STATUS_LABELS,
  type ExpiryState,
  type InvoiceStatus,
  type JobStatus,
  type UserStatus,
} from '@plastago/shared';
import { Badge, type BadgeProps } from '@plastago/ui';
import { ClockIcon, TriangleAlertIcon, ZapIcon } from 'lucide-react';

/**
 * Status badges, mapped once.
 *
 * ── Why these live in one file ─────────────────────────────────────────────
 * A job's status appears on the jobs grid, the job detail header, the account's
 * jobs tab, the allocation board, the run sheet and the dashboard's activity
 * feed. If each screen picked its own colour, "Futile" would be amber in one
 * place and red in another, and the reader would have to re-learn the code on
 * every page. Mapping status → variant once makes that impossible.
 *
 * Status colour is never the only signal: the label is always present, so a
 * colour-blind reader and a greyscale printout both work.
 */
const JOB_STATUS_VARIANT: Record<JobStatus, BadgeProps['variant']> = {
  booked: 'outline',
  assigned: 'secondary',
  acknowledged: 'secondary',
  'in-transit': 'default',
  arrived: 'default',
  completed: 'success',
  'admin-complete': 'success',
  futile: 'destructive',
  cancelled: 'outline',
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return <Badge variant={JOB_STATUS_VARIANT[status]}>{JOB_STATUS_LABELS[status]}</Badge>;
}

const INVOICE_STATUS_VARIANT: Record<InvoiceStatus, BadgeProps['variant']> = {
  draft: 'outline',
  'awaiting-po': 'warning',
  sent: 'secondary',
  paid: 'success',
  overdue: 'destructive',
  // Their current invoice list genuinely shows "Unknown" because the Xero sync
  // only partly works. Showing it as a real state is what makes it fixable.
  unknown: 'outline',
};

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  return <Badge variant={INVOICE_STATUS_VARIANT[status]}>{INVOICE_STATUS_LABELS[status]}</Badge>;
}

/** The job-level invoice rollup shown on the jobs grid. */
const JOB_INVOICE_LABELS = {
  'not-invoiced': 'Not invoiced',
  'awaiting-po': 'Awaiting PO',
  invoiced: 'Invoiced',
  paid: 'Paid',
} as const;

export function JobInvoiceBadge({ status }: { status: keyof typeof JOB_INVOICE_LABELS }) {
  const variant: BadgeProps['variant'] =
    status === 'paid'
      ? 'success'
      : status === 'awaiting-po'
        ? 'warning'
        : status === 'invoiced'
          ? 'secondary'
          : 'outline';
  return <Badge variant={variant}>{JOB_INVOICE_LABELS[status]}</Badge>;
}

const USER_STATUS_VARIANT: Record<UserStatus, BadgeProps['variant']> = {
  active: 'success',
  invited: 'warning',
  suspended: 'destructive',
};

export function UserStatusBadge({ status }: { status: UserStatus }) {
  return <Badge variant={USER_STATUS_VARIANT[status]}>{USER_STATUS_LABELS[status]}</Badge>;
}

/** Urgent is a customer-set flag (F28), so it earns its own mark. */
export function UrgentBadge() {
  return (
    <Badge variant="warning">
      <ZapIcon aria-hidden className="size-3" />
      Urgent
    </Badge>
  );
}

/**
 * M2.4a — past, or about to pass, ready date + 5 business days.
 *
 * Carries an icon as well as colour because this is the badge that decides what
 * the office does next, and it must survive a colour-blind reader.
 */
export function AtRiskBadge({ label = 'At risk' }: { label?: string }) {
  return (
    <Badge variant="destructive">
      <TriangleAlertIcon aria-hidden className="size-3" />
      {label}
    </Badge>
  );
}

const EXPIRY_VARIANT: Record<ExpiryState, BadgeProps['variant']> = {
  valid: 'success',
  'due-soon': 'warning',
  expired: 'destructive',
};

/**
 * Licence, ticket, service and registration expiry (F43, F53).
 *
 * Carries an icon as well as colour on the two states that need action, because
 * this badge is the entire reminder mechanism — they already have a maintenance
 * register they do not maintain, so the state has to be impossible to skim past.
 */
export function ExpiryBadge({ state }: { state: ExpiryState }) {
  return (
    <Badge variant={EXPIRY_VARIANT[state]}>
      {state === 'expired' && <TriangleAlertIcon aria-hidden className="size-3" />}
      {state === 'due-soon' && <ClockIcon aria-hidden className="size-3" />}
      {EXPIRY_STATE_LABELS[state]}
    </Badge>
  );
}
