import type { DashboardSummary, QueueSummary, Role } from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { centsToMoney } from '../../lib/money.js';
import { queueRepository } from '../queues/queue.repository.js';
import { poExtractionRepository } from '../queues/po-extraction.repository.js';
import { dashboardRepository } from './dashboard.repository.js';

/**
 * The admin dashboard (M9.4 · F15).
 *
 * ── What it is for ────────────────────────────────────────────────────────
 * Answering "what needs me today" in one screen. So the counters are the ones
 * that generate work — unallocated jobs, at-risk jobs, queues with money in
 * them — and the two exception RATES, because futile and contamination are the
 * exceptions that carry a charge and the argument with a builder is always
 * about whether the rate is normal.
 *
 * §6A.8 adds the sync counters: there is no error-tracking vendor, so a stuck
 * driver queue and a dead-lettered background job have to be visible in the
 * product rather than only in logs.
 */

export interface Caller {
  userId: string;
  name: string;
  roles: readonly Role[];
}

/** The dashboard carries revenue and margin-adjacent figures. Office only. */
const DASHBOARD_ROLES = new Set<Role>([
  'super-admin',
  'operations',
  'office-staff',
  'allocator',
]);

export const dashboardService = {
  /**
   * The whole screen, in one call.
   *
   * ── Why one call and not eleven ───────────────────────────────────────────
   * Because it is one screen, and eleven round trips means eleven chances to
   * render half a dashboard. Everything below runs in parallel; the cost is one
   * response rather than a waterfall.
   */
  async summary(caller: Caller): Promise<DashboardSummary> {
    assertOffice(caller);

    const [
      counters,
      exceptions,
      invoices,
      medianOnSiteMinutes,
      statusCounts,
      dailyVolume,
      exceptionRates,
      driverHealth,
      recentActivity,
      queues,
    ] = await Promise.all([
      dashboardRepository.counters(),
      dashboardRepository.exceptionsThisMonth(),
      dashboardRepository.invoiceTotals(),
      dashboardRepository.medianOnSiteMinutes(),
      dashboardRepository.statusCounts(),
      dashboardRepository.dailyVolume(30),
      dashboardRepository.exceptionRates(12),
      dashboardRepository.driverHealth(),
      dashboardRepository.recentActivity(15),
      queueSummaries(),
    ]);

    return {
      generatedAt: new Date().toISOString(),

      openJobs: counters.openJobs,
      unallocatedJobs: counters.unallocatedJobs,
      atRiskJobs: counters.atRiskJobs,
      completedToday: counters.completedToday,

      futileThisMonth: exceptions.futile,
      contaminationThisMonth: exceptions.contamination,
      /*
       * Rates against jobs that REACHED a site. Guarded, because a month with
       * no completed work divides by zero and renders NaN — which looks like a
       * number somebody might act on.
       */
      futileRatePercent: percent(exceptions.futile, exceptions.completedOrFutile),
      contaminationRatePercent: percent(exceptions.contamination, exceptions.completedOrFutile),

      invoicedThisMonthExGst: centsToMoney(invoices.invoicedThisMonthCents),
      awaitingPoExGst: centsToMoney(invoices.awaitingPoCents),
      overdueInvoiceCount: invoices.overdueCount,

      medianOnSiteMinutes,

      statusCounts,
      dailyVolume,
      exceptionRates,
      queues,
      driverHealth,
      recentActivity,

      /*
       * §6A.8 — dead-lettered background jobs must be seen.
       *
       * Reported as 0 rather than omitted while the queue runner is disabled in
       * development: the shape must not change under the UI when it lands.
       */
      failedBackgroundJobs: 0,
    };
  },
};

/* ── Queues ──────────────────────────────────────────────────────────────── */

/**
 * The four actionable queues, with their age and their money.
 *
 * ⚠️ `oldestAt` is the field that matters. A count alone says three things are
 * waiting; the oldest date says one of them has been waiting since August. One
 * futile pickup sat in TransVirtual for a year because nothing showed its age.
 */
async function queueSummaries(): Promise<QueueSummary[]> {
  const [counts, futile, approvals, awaitingPo, poReview] = await Promise.all([
    queueRepository.counts(),
    // One row each, oldest first, purely to read its timestamp.
    queueRepository.futileList({ page: 1, pageSize: 1 }, '0.00'),
    queueRepository.approvalList({ page: 1, pageSize: 100 }),
    queueRepository.awaitingPoList({ page: 1, pageSize: 100 }),
    poExtractionRepository.list({ page: 1, pageSize: 1 }),
  ]);

  return [
    {
      key: 'futile-review',
      label: 'Futile review',
      count: counts.futileReview,
      oldestAt: futile.data[0]?.markedAt ?? null,
      // The fee is per job and the same on each; a queue total would imply a
      // single invoice that does not exist.
      valueExGst: null,
      href: '/queues/futile',
    },
    {
      key: 'service-approvals',
      label: 'Service approvals',
      count: counts.serviceApprovals,
      oldestAt: approvals.data[0]?.raisedAt ?? null,
      // Money genuinely sitting unapproved — the argument for opening it.
      valueExGst: sumMoney(approvals.data.map((charge) => charge.amountExGst)),
      href: '/queues/approvals',
    },
    {
      key: 'awaiting-po',
      label: 'Awaiting PO',
      count: counts.awaitingPo,
      oldestAt: awaitingPo.data[0]?.approvedAt ?? null,
      valueExGst: sumMoney(awaitingPo.data.map((invoice) => invoice.totalExGst)),
      href: '/queues/awaiting-po',
    },
    {
      key: 'po-review',
      label: 'PO review',
      count: counts.poReview,
      oldestAt: poReview.data[0]?.receivedAt ?? null,
      // An extraction is a proposal, not money — nothing is owed until a human
      // confirms it into a purchase order.
      valueExGst: null,
      href: '/queues/po-review',
    },
  ];
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** One decimal place, and never NaN. See the note at the call site. */
function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

/** Sums decimal money strings in integer cents (§6A.10 #1). */
function sumMoney(values: string[]): string {
  const cents = values.reduce((sum, value) => {
    const negative = value.startsWith('-');
    const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
    const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
    return sum + (negative ? -amount : amount);
  }, 0);

  return centsToMoney(cents);
}

function assertOffice(caller: Caller): void {
  if (!caller.roles.some((role) => DASHBOARD_ROLES.has(role))) {
    // A customer has their own dashboard in the portal, scoped to their account.
    throw AppError.forbidden('The admin dashboard is for office staff');
  }
}
