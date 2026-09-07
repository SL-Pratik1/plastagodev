import {
  ZONE_LABELS,
  type Certificate,
  type FinancialRow,
  type ReportFilters,
  type VolumeRow,
  type Zone,
} from '@plastago/shared';
import { ServiceError } from '../service-error';
import type { ReportService } from '../types';
import { applyListQuery, byDate, byNumber, byText } from './list-query';
import { centsToMoney, objectId } from './fixtures/reference';
import { latency } from './mock-transport';
import { store } from './store';

/**
 * Reporting (M9.1–M9.3, M9.6) and diversion certificates (M9.5).
 *
 * ── All computed from the job store ────────────────────────────────────────
 * Nothing is pre-aggregated into a fixture. A report that disagrees with the
 * grid it summarises is worse than no report, and it is exactly what happens
 * when the two are generated separately.
 *
 * In production these are `$merge` rollups recomputed nightly (§6A.3 #8) because
 * re-aggregating thousands of jobs on every request is too slow — but the
 * *numbers* must match what this computes, so this is the reference.
 */

const OPEN_OR_DONE = ['completed', 'admin-complete'] as const;

function cents(value: string): number {
  return Math.round(Number(value) * 100);
}

/** Jobs inside the report window, honouring whichever filters are set. */
function scoped(filters: ReportFilters) {
  return store.jobs.filter((job) => {
    if (job.readyDate < filters.from || job.readyDate > filters.to) return false;
    if (filters.accountId && job.accountId !== filters.accountId) return false;
    // Filtering by site is now filtering by SUBURB — with no site records
    // there is nothing narrower to group on, and a suburb is what the office
    // actually asks about ("how much came out of Kellyville last month?").
    if (filters.suburb && job.suburb !== filters.suburb) return false;
    if (filters.zone && job.zone !== filters.zone) return false;
    if (filters.driverId && job.driverId !== filters.driverId) return false;
    return true;
  });
}

export function createMockReportService(): ReportService {
  return {
    /**
     * M9.1 — the parity report. They produce this today and send it to
     * customers, and at least one customer requires it.
     *
     * Grouped by account, or by SITE when one account is selected — because
     * "which of my sites produced this" is the next question a customer asks.
     */
    async monthlyVolume(filters) {
      await latency(520, 240);
      const jobs = scoped(filters).filter((job) =>
        (OPEN_OR_DONE as readonly string[]).includes(job.status),
      );

      // Drilling into one account groups by suburb rather than by site, for
      // the reason above. Across all accounts it still groups by account.
      const groupBySuburb = Boolean(filters.accountId);
      const buckets = new Map<string, VolumeRow>();

      for (const job of jobs) {
        const key = groupBySuburb ? job.suburb : job.accountId;
        const label = groupBySuburb ? job.suburb : job.accountName;
        const existing = buckets.get(key) ?? {
          key,
          label,
          jobs: 0,
          areaM2: 0,
          weightKg: null,
          bags: 0,
          chargesExGst: '0.00',
        };

        buckets.set(key, {
          ...existing,
          jobs: existing.jobs + 1,
          areaM2: existing.areaM2 + (job.expectedAreaM2 ?? 0),
          // Only accumulate weight for accounts that capture it (M2.3). A zero
          // would read as "nothing recovered", which is a different claim.
          weightKg:
            job.recoveredWeightKg === null
              ? existing.weightKg
              : (existing.weightKg ?? 0) + job.recoveredWeightKg,
          bags: existing.bags + job.bagCount,
          chargesExGst: centsToMoney(cents(existing.chargesExGst) + cents(job.totalExGst)),
        });
      }

      const rows = [...buckets.values()].sort((a, b) => b.areaM2 - a.areaM2);

      // Month-by-month, for the trend beside the table.
      const months = new Map<string, { jobs: number; areaM2: number }>();
      for (const job of jobs) {
        const month = job.readyDate.slice(0, 7);
        const existing = months.get(month) ?? { jobs: 0, areaM2: 0 };
        months.set(month, {
          jobs: existing.jobs + 1,
          areaM2: existing.areaM2 + (job.expectedAreaM2 ?? 0),
        });
      }

      return {
        filters,
        rows,
        byMonth: [...months.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([month, value]) => ({ month, ...value })),
        totalJobs: jobs.length,
        totalAreaM2: rows.reduce((sum, row) => sum + row.areaM2, 0),
        totalChargesExGst: centsToMoney(
          rows.reduce((sum, row) => sum + cents(row.chargesExGst), 0),
        ),
      };
    },

    /** M9.3 — zone mix drives margin, because rate AND drive distance vary. */
    async zoneVolume(filters) {
      await latency(460, 220);
      const jobs = scoped(filters).filter((job) =>
        (OPEN_OR_DONE as readonly string[]).includes(job.status),
      );

      const zones = Object.keys(ZONE_LABELS) as Zone[];
      const rows = zones.map((zone) => {
        const inZone = jobs.filter((job) => job.zone === zone);
        const revenue = inZone.reduce((sum, job) => sum + cents(job.totalExGst), 0);
        return {
          zone,
          jobs: inZone.length,
          areaM2: inZone.reduce((sum, job) => sum + (job.expectedAreaM2 ?? 0), 0),
          revenueExGst: centsToMoney(revenue),
          averageJobValueExGst: centsToMoney(
            inZone.length === 0 ? 0 : Math.round(revenue / inZone.length),
          ),
        };
      });

      return {
        filters,
        rows: rows.filter((row) => row.jobs > 0),
        totalJobs: jobs.length,
        totalRevenueExGst: centsToMoney(
          rows.reduce((sum, row) => sum + cents(row.revenueExGst), 0),
        ),
      };
    },

    /**
     * M9.6 — the financial summary, restored to scope.
     *
     * ⚠️ The cost side is an ASSUMPTION, not a measurement: it reproduces the
     * flat $100 "Reporting Cost (Pickup Rate)" per job that their current margin
     * figure uses (M6.8). Real per-vehicle cost is the improvement to make once
     * the vehicle expense log has history — which is why cost per km matters.
     */
    async financial(filters) {
      await latency(560, 260);
      const jobs = scoped(filters).filter((job) =>
        (OPEN_OR_DONE as readonly string[]).includes(job.status),
      );
      const assumedCostPerJobCents = 10000;

      const group = (keyOf: (job: (typeof jobs)[number]) => [string, string]): FinancialRow[] => {
        const buckets = new Map<string, FinancialRow>();

        for (const job of jobs) {
          const [key, label] = keyOf(job);
          const base = job.charges
            .filter((charge) => charge.source === 'office')
            .reduce((sum, charge) => sum + cents(charge.amount), 0);
          const extra = job.charges
            .filter((charge) => charge.source !== 'office')
            .reduce((sum, charge) => sum + cents(charge.amount), 0);

          const existing = buckets.get(key) ?? {
            key,
            label,
            jobs: 0,
            baseRevenueExGst: '0.00',
            additionalServicesExGst: '0.00',
            totalRevenueExGst: '0.00',
            assumedCostExGst: '0.00',
            marginExGst: '0.00',
            marginPercent: 0,
          };

          const jobCount = existing.jobs + 1;
          const baseTotal = cents(existing.baseRevenueExGst) + base;
          const extraTotal = cents(existing.additionalServicesExGst) + extra;
          const revenue = baseTotal + extraTotal;
          const cost = jobCount * assumedCostPerJobCents;

          buckets.set(key, {
            key,
            label,
            jobs: jobCount,
            baseRevenueExGst: centsToMoney(baseTotal),
            additionalServicesExGst: centsToMoney(extraTotal),
            totalRevenueExGst: centsToMoney(revenue),
            assumedCostExGst: centsToMoney(cost),
            marginExGst: centsToMoney(revenue - cost),
            marginPercent:
              revenue === 0 ? 0 : Number((((revenue - cost) / revenue) * 100).toFixed(2)),
          });
        }

        return [...buckets.values()].sort(
          (a, b) => cents(b.totalRevenueExGst) - cents(a.totalRevenueExGst),
        );
      };

      const byAccount = group((job) => [job.accountId, job.accountName]);
      const byZone = group((job) => [job.zone, ZONE_LABELS[job.zone]]);
      const revenue = byAccount.reduce((sum, row) => sum + cents(row.totalRevenueExGst), 0);
      const margin = byAccount.reduce((sum, row) => sum + cents(row.marginExGst), 0);

      return {
        filters,
        byAccount,
        byZone,
        assumedCostPerJobExGst: centsToMoney(assumedCostPerJobCents),
        totalRevenueExGst: centsToMoney(revenue),
        totalMarginExGst: centsToMoney(margin),
      };
    },

    /**
     * M9.5 · F52 — diversion certificates, one per completed job.
     *
     * Matt: *"at the end of every job, a customer gets some sort of
     * certificate"*, showing both square metres and tonnage. The tonnage is the
     * RECOVERED weight — the figure the tip-off reconciliation produces — not
     * something derived from the priced m², because these documents go into
     * Green Star submissions and have to survive an audit.
     *
     * ── Only WEIGHED jobs get one ────────────────────────────────────────
     * Matt, 32:11: *"this is only for weighed jobs. If it's an estimated job,
     * we're **unable to provide a certificate** because it's an estimated weight
     * and it doesn't meet compliance regulation."*
     *
     * So an estimated tonnage does not produce a certificate at all — not a
     * certificate with a caveat on it. These documents go into Green Star
     * submissions, and issuing one against a figure apportioned from a
     * weighbridge total would be the single thing here that could fail an audit.
     *
     * The filter is on the weight BASIS, not on whether a number exists: every
     * completed job has a tonnage after reconciliation, and roughly half of them
     * are imputed rather than measured.
     */
    async certificates(query) {
      await latency(480, 220);

      const rows: Certificate[] = store.jobs
        .filter(
          (job) =>
            (job.status === 'admin-complete' || job.status === 'completed') &&
            job.recoveredWeightKg !== null &&
            job.recoveredWeightBasis === 'actual',
        )
        .slice(0, 90)
        .map((job, index) => {
          // Non-null by the filter above; a certificate is never derived from m².
          const tonnes = (job.recoveredWeightKg ?? 0) / 1000;

          return {
            id: `${job.id}-cert`,
            reference: `DIV-${String(job.jobNumber)}`,
            scope: 'job' as const,
            state: job.status === 'admin-complete' ? ('issued' as const) : ('draft' as const),
            accountId: job.accountId,
            accountName: job.accountName,
            siteName: `${job.siteName}, ${job.suburb}`,
            jobNumber: job.jobNumber,
            periodFrom: job.readyDate,
            periodTo: job.readyDate,
            jobs: 1,
            areaM2: (job.expectedAreaM2 ?? 0),
            tonnesDiverted: Number(tonnes.toFixed(2)),
            issuedAt: job.status === 'admin-complete' ? job.invoicedAt : null,
            issuedTo: job.status === 'admin-complete' ? job.accountName : null,
            // Keeps ids stable if a job ever lacks one.
            ...(job.id ? {} : { id: objectId('ct', index) }),
          };
        });

      return applyListQuery(rows, query, {
        search: (row) => [row.reference, row.accountName, row.siteName, row.jobNumber],
        filters: {
          state: (row, value) => row.state === value,
          account: (row, value) => row.accountId === value,
        },
        sorters: {
          reference: byText((row) => row.reference),
          accountName: byText((row) => row.accountName),
          periodFrom: byDate((row) => row.periodFrom),
          tonnesDiverted: byNumber((row) => row.tonnesDiverted),
        },
        defaultSort: (a, b) => b.periodFrom.localeCompare(a.periodFrom),
      });
    },

    async issueCertificate(id) {
      await latency(620, 280);
      const job = store.jobs.find((candidate) => `${candidate.id}-cert` === id);
      if (!job) throw new ServiceError('NOT_FOUND', `No certificate ${id}`);

      // ð Q35 — still blocked on a sample from Matt before the layout and exact
      // data points are fixed, so the mock issues a record rather than a PDF.
      const tonnes =
        job.recoveredWeightKg === null
          ? ((job.expectedAreaM2 ?? 0) * 0.068 * 9.5) / 1000
          : job.recoveredWeightKg / 1000;

      return {
        id,
        reference: `DIV-${String(job.jobNumber)}`,
        scope: 'job',
        state: 'issued',
        accountId: job.accountId,
        accountName: job.accountName,
        siteName: `${job.siteName}, ${job.suburb}`,
        jobNumber: job.jobNumber,
        periodFrom: job.readyDate,
        periodTo: job.readyDate,
        jobs: 1,
        areaM2: (job.expectedAreaM2 ?? 0),
        tonnesDiverted: Number(tonnes.toFixed(2)),
        issuedAt: new Date().toISOString(),
        issuedTo: job.accountName,
      };
    },
  };
}
