import { lazy } from 'react';

/**
 * Lazily-loaded page components, split by nav group.
 *
 * ── Why they live here and not in `router.tsx` ─────────────────────────────
 * Two reasons, both practical. Fast refresh only works in a module that exports
 * components and nothing else — `router.tsx` exports the route table, so
 * defining components there disables HMR for the whole routing layer. And this
 * file is a single readable inventory of what is code-split, which is easier to
 * audit than the same declarations threaded through a nested route tree.
 *
 * ── What is NOT here ──────────────────────────────────────────────────────
 * The auth screens, the shells and the guards load eagerly. They are on the
 * critical path to first paint, and splitting them would put a loading state in
 * front of the very first interaction — the worst possible place for one.
 *
 * The `{ default: … }` shape is React's own `lazy` contract. It is easy to reach
 * for `{ Component }` here — that is React Router's *route-level* `lazy`, a
 * different API — and the two are not interchangeable.
 */

// ── Operations ──────────────────────────────────────────────────────────────
export const DashboardPage = lazy(async () => ({
  default: (await import('@/pages/admin/dashboard')).AdminDashboardPage,
}));

export const JobsPage = lazy(async () => ({
  default: (await import('@/pages/admin/jobs')).AdminJobsPage,
}));

export const JobCreatePage = lazy(async () => ({
  default: (await import('@/pages/admin/job-create')).AdminJobCreatePage,
}));

export const JobDetailPage = lazy(async () => ({
  default: (await import('@/pages/admin/job-detail')).AdminJobDetailPage,
}));

export const DispatchPage = lazy(async () => ({
  default: (await import('@/pages/admin/dispatch')).AdminDispatchPage,
}));

// ── Queues ──────────────────────────────────────────────────────────────────
export const QueueFutilePage = lazy(async () => ({
  default: (await import('@/pages/admin/queue-futile')).AdminQueueFutilePage,
}));

export const QueueApprovalsPage = lazy(async () => ({
  default: (await import('@/pages/admin/queue-approvals')).AdminQueueApprovalsPage,
}));

export const QueueAwaitingPoPage = lazy(async () => ({
  default: (await import('@/pages/admin/queue-awaiting-po')).AdminQueueAwaitingPoPage,
}));

export const QueuePoReviewPage = lazy(async () => ({
  default: (await import('@/pages/admin/queue-po-review')).AdminQueuePoReviewPage,
}));

export const QueuePoReviewDetailPage = lazy(async () => ({
  default: (await import('@/pages/admin/queue-po-review-detail')).AdminQueuePoReviewDetailPage,
}));

export const QueueLeadsPage = lazy(async () => ({
  default: (await import('@/pages/admin/queue-leads')).AdminQueueLeadsPage,
}));

export const QueueLeadDetailPage = lazy(async () => ({
  default: (await import('@/pages/admin/queue-lead-detail')).AdminQueueLeadDetailPage,
}));

// ── Commercial ──────────────────────────────────────────────────────────────
export const CustomersPage = lazy(async () => ({
  default: (await import('@/pages/admin/customers')).AdminCustomersPage,
}));

export const CustomerDetailPage = lazy(async () => ({
  default: (await import('@/pages/admin/customer-detail')).AdminCustomerDetailPage,
}));

export const InvoicesPage = lazy(async () => ({
  default: (await import('@/pages/admin/invoices')).AdminInvoicesPage,
}));

export const InvoiceDetailPage = lazy(async () => ({
  default: (await import('@/pages/admin/invoice-detail')).AdminInvoiceDetailPage,
}));

export const ReportsPage = lazy(async () => ({
  default: (await import('@/pages/admin/reports')).AdminReportsPage,
}));

// ── People & fleet ──────────────────────────────────────────────────────────
export const UsersPage = lazy(async () => ({
  default: (await import('@/pages/admin/users')).AdminUsersPage,
}));

export const UserDetailPage = lazy(async () => ({
  default: (await import('@/pages/admin/user-detail')).AdminUserDetailPage,
}));

export const DriversPage = lazy(async () => ({
  default: (await import('@/pages/admin/drivers')).AdminDriversPage,
}));

export const DriverDetailPage = lazy(async () => ({
  default: (await import('@/pages/admin/driver-detail')).AdminDriverDetailPage,
}));

export const VehiclesPage = lazy(async () => ({
  default: (await import('@/pages/admin/vehicles')).AdminVehiclesPage,
}));

export const VehicleDetailPage = lazy(async () => ({
  default: (await import('@/pages/admin/vehicle-detail')).AdminVehicleDetailPage,
}));

// ── Configuration & system ──────────────────────────────────────────────────
export const NotificationsPage = lazy(async () => ({
  default: (await import('@/pages/admin/notifications')).AdminNotificationsPage,
}));

export const SettingsPage = lazy(async () => ({
  default: (await import('@/pages/admin/settings')).AdminSettingsPage,
}));

export const AuditLogPage = lazy(async () => ({
  default: (await import('@/pages/admin/audit-log')).AdminAuditLogPage,
}));

export const FoundationPage = lazy(async () => ({
  default: (await import('@/pages/admin/foundation')).AdminFoundationPage,
}));

// ── Customer portal (M5 Part 1) ─────────────────────────────────────────────
export const PortalDashboardPage = lazy(async () => ({
  default: (await import('@/pages/portal/dashboard')).PortalDashboardPage,
}));

export const PortalBookPage = lazy(async () => ({
  default: (await import('@/pages/portal/book')).PortalBookPage,
}));

export const PortalJobsPage = lazy(async () => ({
  default: (await import('@/pages/portal/jobs')).PortalJobsPage,
}));

export const PortalJobDetailPage = lazy(async () => ({
  default: (await import('@/pages/portal/job-detail')).PortalJobDetailPage,
}));

export const PortalJobEditPage = lazy(async () => ({
  default: (await import('@/pages/portal/job-edit')).PortalJobEditPage,
}));

export const PortalSitesPage = lazy(async () => ({
  default: (await import('@/pages/portal/sites')).PortalSitesPage,
}));

export const PortalSiteDetailPage = lazy(async () => ({
  default: (await import('@/pages/portal/site-detail')).PortalSiteDetailPage,
}));

export const PortalInvoicesPage = lazy(async () => ({
  default: (await import('@/pages/portal/invoices')).PortalInvoicesPage,
}));

export const PortalReportsPage = lazy(async () => ({
  default: (await import('@/pages/portal/reports')).PortalReportsPage,
}));

export const PortalCertificatesPage = lazy(async () => ({
  default: (await import('@/pages/portal/certificates')).PortalCertificatesPage,
}));

export const PortalSupervisorsPage = lazy(async () => ({
  default: (await import('@/pages/portal/supervisors')).PortalSupervisorsPage,
}));

export const PortalAccountPage = lazy(async () => ({
  default: (await import('@/pages/portal/account')).PortalAccountPage,
}));
