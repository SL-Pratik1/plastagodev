import {
  JOB_STATUS_LABELS,
  type DashboardSummary,
  type ExceptionRatePoint,
  type JobStatus,
  type QueueSummary,
  type RecentActivity,
} from '@plastago/shared';
import type { DashboardService } from '../types';
import { ACTIVE_DRIVERS } from './fixtures/reference';
import { latency } from './mock-transport';
import { isAtRisk, store, todayIso } from './store';

/**
 * The operations dashboard (M9.4 / F15).
 *
 * Everything is computed from the same store the grids read, so the dashboard
 * and the lists can never disagree — a headline that says 14 unallocated while
 * the board shows 11 destroys confidence in every other number on the page.
 */
const OPEN: readonly JobStatus[] = ['booked', 'assigned', 'in-transit', 'arrived'];

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function money(cents: number): string {
  return `${String(Math.floor(cents / 100))}.${String(Math.abs(cents % 100)).padStart(2, '0')}`;
}

export function createMockDashboardService(): DashboardService {
  return {
    async summary() {
      await latency(420, 200);

      const today = todayIso();
      const jobs = store.jobs;
      const open = jobs.filter((job) => OPEN.includes(job.status));

      // ── Status distribution ───────────────────────────────────────────
      const statusCounts = (Object.keys(JOB_STATUS_LABELS) as JobStatus[])
        .map((status) => ({ status, count: jobs.filter((job) => job.status === status).length }))
        .filter((entry) => entry.count > 0);

      // ── Daily volume, last 14 days ────────────────────────────────────
      const dailyVolume = Array.from({ length: 14 }, (_, index) => {
        const date = isoDaysAgo(13 - index);
        const onDate = jobs.filter((job) => job.readyDate === date);
        return {
          date,
          jobs: onDate.length,
          areaM2: onDate.reduce((sum, job) => sum + (job.expectedAreaM2 ?? 0), 0),
        };
      });

      // ── Exception rates, by week ──────────────────────────────────────
      const exceptionRates: ExceptionRatePoint[] = Array.from({ length: 8 }, (_, index) => {
        const start = isoDaysAgo((7 - index) * 7 + 6);
        const end = isoDaysAgo((7 - index) * 7);
        const inWeek = jobs.filter((job) => job.readyDate >= start && job.readyDate <= end);
        const futile = inWeek.filter((job) => job.status === 'futile').length;
        const contaminated = inWeek.filter((job) =>
          job.charges.some((charge) => charge.code === 'contamination'),
        ).length;
        const denominator = Math.max(1, inWeek.length);

        return {
          weekStarting: start,
          futilePercent: Number(((futile / denominator) * 100).toFixed(1)),
          contaminationPercent: Number(((contaminated / denominator) * 100).toFixed(1)),
        };
      });

      // ── The four queues (M2.6, M2.7, M7.3, M2.12) ─────────────────────
      // Every futile pickup that has not yet been actioned by the office.
      // Deliberately NOT filtered on a pending futile-pickup charge: the fee is
      // raised the moment the driver marks it and does not need approving, so
      // keying the queue off the charge would hide entries the office still owes
      // a decision on. Same predicate as the queue screen (M2.6).
      const futileReview = jobs.filter(
        (job) => job.status === 'futile' && !store.futileDecisions.has(job.id),
      );
      const serviceApprovals = jobs.flatMap((job) =>
        job.charges.filter(
          (charge) => charge.source !== 'office' && charge.approvalState === 'pending',
        ),
      );
      const awaitingPo = jobs.filter((job) => job.invoiceStatus === 'awaiting-po');
      const poReview = store.poExtractions.filter((row) => row.state === 'needs-review');

      const queues: QueueSummary[] = [
        {
          key: 'futile-review',
          label: 'Futile pickups to review',
          count: futileReview.length,
          oldestAt:
            futileReview
              .map(
                (job) => job.events.find((event) => event.status === 'futile')?.at ?? job.createdAt,
              )
              .sort()[0] ?? null,
          valueExGst: money(futileReview.length * 12000),
          href: '/admin/queues/futile',
        },
        {
          key: 'service-approvals',
          label: 'Charges awaiting approval',
          count: serviceApprovals.length,
          oldestAt: serviceApprovals.map((charge) => charge.raisedAt).sort()[0] ?? null,
          valueExGst: money(
            serviceApprovals.reduce(
              (sum, charge) => sum + Math.round(Number(charge.amount) * 100),
              0,
            ),
          ),
          href: '/admin/queues/approvals',
        },
        {
          key: 'awaiting-po',
          label: 'Approved charges awaiting a PO',
          count: awaitingPo.length,
          oldestAt: awaitingPo.map((job) => job.completedAt ?? job.createdAt).sort()[0] ?? null,
          // Only the APPROVED EXTRAS, not the whole job. The tile's label says
          // "approved charges", and the base invoice for those jobs went out on
          // completion and is already earning (M7.2) — including it would quote
          // a figure four times larger than the queue screen shows for the same
          // rows, and the first person to compare the two stops trusting both.
          valueExGst: money(
            awaitingPo.reduce(
              (sum, job) =>
                sum +
                job.charges
                  .filter(
                    (charge) => charge.source !== 'office' && charge.approvalState === 'approved',
                  )
                  .reduce((inner, charge) => inner + Math.round(Number(charge.amount) * 100), 0),
              0,
            ),
          ),
          href: '/admin/queues/awaiting-po',
        },
        {
          key: 'po-review',
          label: 'Extracted POs to confirm',
          count: poReview.length,
          oldestAt: poReview.map((row) => row.receivedAt).sort()[0] ?? null,
          valueExGst: money(
            poReview.reduce(
              (sum, row) => sum + Math.round(Number(row.amountExGst ?? '0') * 100),
              0,
            ),
          ),
          href: '/admin/queues/po-review',
        },
      ];

      // ── Finance (M7) ──────────────────────────────────────────────────
      const monthStart = `${today.slice(0, 7)}-01`;
      const invoicedThisMonth = jobs.filter(
        (job) => job.invoicedAt !== null && job.invoicedAt.slice(0, 10) >= monthStart,
      );

      const onSite = jobs
        .map((job) => job.onSiteMinutes)
        .filter((minutes): minutes is number => minutes !== null)
        .sort((a, b) => a - b);

      const futileThisMonth = jobs.filter(
        (job) => job.status === 'futile' && job.readyDate >= monthStart,
      ).length;
      const contaminationThisMonth = jobs.filter(
        (job) =>
          job.readyDate >= monthStart &&
          job.charges.some((charge) => charge.code === 'contamination'),
      ).length;
      const thisMonthTotal = Math.max(1, jobs.filter((job) => job.readyDate >= monthStart).length);

      const recentActivity: RecentActivity[] = jobs
        .flatMap((job) =>
          job.events.map((event) => ({
            id: event.id,
            at: event.at,
            actor: event.actor,
            summary: `${event.label} — ${job.accountName}, ${job.siteName}`,
            jobId: job.id,
            jobNumber: job.jobNumber,
            kind: 'status' as const,
          })),
        )
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 12);

      const summary: DashboardSummary = {
        generatedAt: new Date().toISOString(),
        openJobs: open.length,
        unallocatedJobs: open.filter((job) => job.driverId === null).length,
        atRiskJobs: open.filter((job) => isAtRisk(job)).length,
        completedToday: jobs.filter(
          (job) => job.completedAt !== null && job.completedAt.slice(0, 10) === today,
        ).length,

        futileThisMonth,
        contaminationThisMonth,
        futileRatePercent: Number(((futileThisMonth / thisMonthTotal) * 100).toFixed(1)),
        contaminationRatePercent: Number(
          ((contaminationThisMonth / thisMonthTotal) * 100).toFixed(1),
        ),

        invoicedThisMonthExGst: money(
          invoicedThisMonth.reduce((sum, job) => sum + Math.round(Number(job.totalExGst) * 100), 0),
        ),
        awaitingPoExGst: money(
          awaitingPo.reduce((sum, job) => sum + Math.round(Number(job.totalExGst) * 100), 0),
        ),
        overdueInvoiceCount: jobs.filter(
          (job) =>
            job.invoiceStatus === 'invoiced' &&
            job.invoicedAt !== null &&
            job.invoicedAt.slice(0, 10) < isoDaysAgo(7),
        ).length,

        medianOnSiteMinutes:
          onSite.length > 0 ? (onSite[Math.floor(onSite.length / 2)] ?? null) : null,

        statusCounts,
        dailyVolume,
        exceptionRates,
        queues,
        driverHealth: ACTIVE_DRIVERS.map((driver) => ({
          driverId: driver.id,
          driverName: driver.name,
          jobsToday: jobs.filter(
            (job) =>
              job.driverId === driver.id && job.readyDate === today && OPEN.includes(job.status),
          ).length,
          capacity: driver.dailyJobCapacity,
          lastSyncAt: new Date(Date.now() - 7 * 60_000).toISOString(),
          pendingSyncActions: 0,
        })),
        recentActivity,

        failedBackgroundJobs: 0,
      };

      return summary;
    },
  };
}
