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

export const QueueLeadCreatePage = lazy(async () => ({
  default: (await import('@/pages/admin/queue-lead-create')).AdminQueueLeadCreatePage,
}));

export const QueueLeadDetailPage = lazy(async () => ({
  default: (await import('@/pages/admin/queue-lead-detail')).AdminQueueLeadDetailPage,
}));

// ── Commercial ──────────────────────────────────────────────────────────────
export const CustomersPage = lazy(async () => ({
  default: (await import('@/pages/admin/customers')).AdminCustomersPage,
}));

export const CustomerCreatePage = lazy(async () => ({
  default: (await import('@/pages/admin/customer-create')).AdminCustomerCreatePage,
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

export const ExtractorPage = lazy(async () => ({
  default: (await import('@/pages/admin/extractor')).AdminExtractorPage,
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

export const PortalInvoicesPage = lazy(async () => ({
  default: (await import('@/pages/portal/invoices')).PortalInvoicesPage,
}));

export const PortalReportsPage = lazy(async () => ({
  default: (await import('@/pages/portal/reports')).PortalReportsPage,
}));

export const PortalNotificationsPage = lazy(async () => ({
  default: (await import('@/pages/portal/notifications')).PortalNotificationsPage,
}));

export const PortalCertificatesPage = lazy(async () => ({
  default: (await import('@/pages/portal/certificates')).PortalCertificatesPage,
}));

export const PortalSupervisorsPage = lazy(async () => ({
  default: (await import('@/pages/portal/supervisors')).PortalSupervisorsPage,
}));

/** Journey A.4 — shown once, before the account is active. */
export const PortalWelcomePage = lazy(async () => ({
  default: (await import('@/pages/portal/welcome')).PortalWelcomePage,
}));

export const PortalAccountPage = lazy(async () => ({
  default: (await import('@/pages/portal/account')).PortalAccountPage,
}));

/*
 * ── The driver surface (M4) ────────────────────────────────────────────────
 *
 * Split like everything else, but for the opposite reason and with an extra
 * guarantee behind it.
 *
 * The office never opens these, so lazy keeps eleven screens out of the
 * console's bundle. The driver, however, may open ANY of them for the first
 * time standing in a greenfield estate with no coverage — and a lazily-loaded
 * chunk that has never been fetched is a blank screen at the exact moment the
 * app is supposed to prove itself.
 *
 * What reconciles the two is the service worker: `vite.config.ts` precaches
 * these chunks at install time, so they are on the phone before the driver ever
 * navigates. Lazy on the network, eager on disk.
 *
 * ⚠️ That guarantee lives in the workbox `globIgnores` list. If a driver screen
 * ever starts pulling in a charting or table library, it will land in a chunk
 * that is deliberately NOT precached and the offline promise quietly breaks.
 */
export const DriverRunSheetPage = lazy(async () => ({
  default: (await import('@/pages/driver/run-sheet')).DriverRunSheetPage,
}));

export const DriverPreStartPage = lazy(async () => ({
  default: (await import('@/pages/driver/pre-start')).DriverPreStartPage,
}));

export const DriverJobDetailPage = lazy(async () => ({
  default: (await import('@/pages/driver/job-detail')).DriverJobDetailPage,
}));

/** I3 — navigation inside the app, so the run is never handed to another one. */
export const DriverNavigatePage = lazy(async () => ({
  default: (await import('@/pages/driver/navigate')).DriverNavigatePage,
}));

export const DriverJobPhotosPage = lazy(async () => ({
  default: (await import('@/pages/driver/job-photos')).DriverJobPhotosPage,
}));

export const DriverJobWeightsPage = lazy(async () => ({
  default: (await import('@/pages/driver/job-weights')).DriverJobWeightsPage,
}));

export const DriverJobFutilePage = lazy(async () => ({
  default: (await import('@/pages/driver/job-futile')).DriverJobFutilePage,
}));

export const DriverJobContaminationPage = lazy(async () => ({
  default: (await import('@/pages/driver/job-contamination')).DriverJobContaminationPage,
}));

export const DriverJobRiskAssessmentPage = lazy(async () => ({
  default: (await import('@/pages/driver/job-risk-assessment')).DriverJobRiskAssessmentPage,
}));

export const DriverTipOffPage = lazy(async () => ({
  default: (await import('@/pages/driver/tip-off')).DriverTipOffPage,
}));

export const DriverReportDefectPage = lazy(async () => ({
  default: (await import('@/pages/driver/report-defect')).DriverReportDefectPage,
}));
