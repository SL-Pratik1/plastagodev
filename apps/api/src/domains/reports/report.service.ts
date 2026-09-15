import type {
  Certificate,
  FinancialReport,
  FinancialRow,
  MonthlyVolumeReport,
  PageMeta,
  ReportFilters,
  Role,
  VolumeRow,
  ZoneVolumeReport,
} from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { centsToMoney, moneyToCents } from '../../lib/money.js';
import { accountRepository } from '../accounts/account.repository.js';
import { settingsRepository } from '../settings/settings.repository.js';
import { reportRepository } from './report.repository.js';

const log = logger.child({ module: 'reports' });

/**
 * Reporting (M9.1–M9.3, M9.6) and diversion certificates (M9.5 · F52).
 *
 * ── Fixed reports, deliberately ───────────────────────────────────────────
 * There is no `run(query)` here and there never will be. F31's custom report
 * builder is v1.1, and Risk 5 names the WYSIWYG designer as the single biggest
 * scope trap in the project — so this is a small set of named reports with
 * parameters, and nothing that could grow into a designer.
 *
 * M9.1 is PARITY, not an improvement: PlastaGo produces the monthly volume
 * report today and at least one customer requires it. It has to exist on day 20.
 */

export interface Caller {
  userId: string;
  name: string;
  roles: readonly Role[];
  accountId: string | null;
}

/** Reports carry revenue and margin. Office only. */
const REPORT_ROLES = new Set<Role>(['super-admin', 'operations', 'office-staff']);

/** M9.6 shows margin, which is narrower than volume. */
const FINANCIAL_ROLES = new Set<Role>(['super-admin', 'operations']);

const CUSTOMER_ROLES = new Set<Role>(['customer-administrator', 'customer-site-supervisor']);

export const reportService = {
  /**
   * M9.1 — monthly pickup volume.
   *
   * Grouped by customer, or by SITE once a customer is chosen. That flip is
   * deliberate: "how much did each customer send us" is the portfolio question
   * and "which of my sites" is the next one.
   */
  async monthlyVolume(filters: ReportFilters, caller: Caller): Promise<MonthlyVolumeReport> {
    const scoped = scopeFilters(filters, caller);
    assertReader(caller);
    assertRange(scoped);

    const [rows, byMonth] = await Promise.all([
      reportRepository.volume(scoped),
      reportRepository.byMonth(scoped),
    ]);

    const totalChargesCents = rows.reduce((sum, row) => sum + row.chargesCents, 0);

    return {
      filters: scoped,
      rows: rows.map(
        (row): VolumeRow => ({
          key: row.key,
          label: row.label,
          jobs: row.jobs,
          areaM2: round(row.areaM2),
          // Null, not zero, where nothing was weighed — see the repository.
          weightKg: row.weightKg === null ? null : round(row.weightKg),
          bags: row.bags,
          chargesExGst: centsToMoney(row.chargesCents),
        }),
      ),
      byMonth: byMonth.map((point) => ({
        month: point.month,
        jobs: point.jobs,
        areaM2: round(point.areaM2),
      })),
      totalJobs: rows.reduce((sum, row) => sum + row.jobs, 0),
      totalAreaM2: round(rows.reduce((sum, row) => sum + row.areaM2, 0)),
      totalChargesExGst: centsToMoney(totalChargesCents),
    };
  },

  /** M9.3 — the zone split. Zone mix drives margin: rate and drive distance vary. */
  async zoneVolume(filters: ReportFilters, caller: Caller): Promise<ZoneVolumeReport> {
    const scoped = scopeFilters(filters, caller);
    assertReader(caller);
    assertRange(scoped);

    const rows = await reportRepository.byZone(scoped);

    return {
      filters: scoped,
      rows: rows.map((row) => ({
        zone: row.zone,
        jobs: row.jobs,
        areaM2: round(row.areaM2),
        revenueExGst: centsToMoney(row.revenueCents),
        // Guarded: a zone with no jobs would divide by zero and render NaN.
        averageJobValueExGst:
          row.jobs > 0 ? centsToMoney(Math.round(row.revenueCents / row.jobs)) : '0.00',
      })),
      totalJobs: rows.reduce((sum, row) => sum + row.jobs, 0),
      totalRevenueExGst: centsToMoney(rows.reduce((sum, row) => sum + row.revenueCents, 0)),
    };
  },

  /**
   * M9.6 — the financial summary.
   *
   * ⚠️ The cost side is an ASSUMPTION, not a measurement. It reproduces the
   * margin figure Matt reads today, which applies a flat per-job cost (M6.8).
   * It is returned as `assumedCostPerJobExGst` so the screen can say so — a
   * margin presented as measured, on a cost nobody measured, is worse than no
   * margin at all.
   */
  async financial(filters: ReportFilters, caller: Caller): Promise<FinancialReport> {
    assertFinancial(caller);
    assertRange(filters);

    const settings = await settingsRepository.get();
    const assumedCostCents = moneyToCents(settings.pricing.assumedCostPerJob);

    const [byAccount, byZone] = await Promise.all([
      reportRepository.financial(filters, 'account'),
      reportRepository.financial(filters, 'zone'),
    ]);

    const toRow = (row: (typeof byAccount)[number]): FinancialRow => {
      const totalCents = row.baseRevenueCents + row.additionalCents;
      const costCents = assumedCostCents * row.jobs;
      const marginCents = totalCents - costCents;

      return {
        key: row.key,
        label: row.label,
        jobs: row.jobs,
        baseRevenueExGst: centsToMoney(row.baseRevenueCents),
        additionalServicesExGst: centsToMoney(row.additionalCents),
        totalRevenueExGst: centsToMoney(totalCents),
        assumedCostExGst: centsToMoney(costCents),
        marginExGst: centsToMoney(marginCents),
        /*
         * Margin as a percentage OF REVENUE, and zero when there is none.
         * Dividing by zero revenue gives Infinity, which renders as a number
         * somebody might act on.
         */
        marginPercent: totalCents > 0 ? Math.round((marginCents / totalCents) * 1000) / 10 : 0,
      };
    };

    const accountRows = byAccount.map(toRow);

    return {
      filters,
      byAccount: accountRows,
      byZone: byZone.map(toRow),
      assumedCostPerJobExGst: settings.pricing.assumedCostPerJob,
      // Totalled from the ACCOUNT grouping only. Adding both would double every
      // figure, since the same jobs appear in each.
      totalRevenueExGst: centsToMoney(
        accountRows.reduce((sum, row) => sum + moneyToCents(row.totalRevenueExGst), 0),
      ),
      totalMarginExGst: centsToMoney(
        accountRows.reduce((sum, row) => sum + moneyToCents(row.marginExGst), 0),
      ),
    };
  },

  /* ── M9.5 · certificates ───────────────────────────────────────────────── */

  /**
   * The certificate list.
   *
   * A customer sees their own; the office sees all. Scoped in the query, so a
   * customer's total never counts somebody else's tonnage.
   */
  async certificates(
    query: { page: number; pageSize: number; state?: string | undefined; q?: string | undefined },
    caller: Caller,
  ): Promise<{ data: Certificate[]; meta: PageMeta }> {
    return reportRepository.listCertificates(query, scopeAccount(caller));
  },

  /**
   * M9.5 — prepares a certificate as a DRAFT.
   *
   * Draft first, always. The figures are frozen at issue, and a document that
   * goes straight to issued gives nobody the chance to notice that a tip-off
   * has not been reconciled yet.
   */
  async prepareCertificate(
    input: {
      scope: Certificate['scope'];
      accountId: string;
      from: string;
      to: string;
      jobId?: string | null;
      siteName?: string | null;
    },
    caller: Caller,
  ): Promise<Certificate> {
    assertReader(caller);

    if (input.from > input.to) {
      throw AppError.validation('The period ends before it starts', [
        { path: 'to', message: 'Choose an end date on or after the start date' },
      ]);
    }

    const account = await accountRepository.findById(input.accountId, { accountId: null });
    if (!account) {
      throw AppError.validation('That account could not be found', [
        { path: 'accountId', message: 'Choose an account from the list' },
      ]);
    }

    /*
     * ⚠️ One certificate per job. Two would let the same tonnage be claimed
     * twice in two different Green Star submissions — checked here so the
     * caller gets an explanation rather than a duplicate-key error.
     */
    if (input.jobId && (await reportRepository.certificateExistsForJob(input.jobId))) {
      throw AppError.conflict('That job already has a certificate');
    }

    const figures = await reportRepository.certificateFigures({
      accountId: input.accountId,
      from: input.from,
      to: input.to,
      jobId: input.jobId ?? null,
      siteName: input.siteName ?? null,
    });

    if (figures.jobs === 0) {
      throw AppError.conflict(
        'No completed pickups in that period — there is nothing to certify',
      );
    }

    /*
     * ⚠️ Tonnage comes from the RECONCILED weight (M4.4), never from the priced
     * m². Refusing a zero is deliberate: a certificate claiming nothing was
     * diverted is worse than no certificate, and it almost always means the
     * tip-off has not been reconciled yet.
     */
    if (figures.weightKg <= 0) {
      throw AppError.conflict(
        'No recovered weight has been recorded for those pickups yet — the tip-off may not be reconciled',
      );
    }

    const reference = await nextReference();

    const id = await reportRepository.createCertificate({
      reference,
      scope: input.scope,
      accountId: account.id,
      accountName: account.name,
      siteName: input.siteName ?? (input.scope === 'job' ? figures.siteName : null),
      jobId: input.jobId ?? null,
      jobNumber: null,
      periodFrom: input.from,
      periodTo: input.to,
      jobs: figures.jobs,
      areaM2: figures.areaM2 === null ? null : round(figures.areaM2),
      // Kilograms to tonnes, one decimal — the unit a certificate is read in.
      tonnesDiverted: Math.round(figures.weightKg / 100) / 10,
    });

    const certificate = await reportRepository.findCertificate(id, null);
    if (!certificate) throw new Error('Certificate vanished immediately after being created');

    log.info(
      { certificateId: id, reference, accountId: account.id, tonnes: certificate.tonnesDiverted },
      'certificate prepared',
    );

    return certificate;
  },

  /**
   * Issues a certificate, freezing its figures.
   *
   * ⚠️ Once issued it cannot be re-issued. It is a document somebody has put
   * into a Green Star pack, and changing the numbers afterwards would leave the
   * copy in that pack disagreeing with ours.
   */
  async issueCertificate(id: string, caller: Caller): Promise<Certificate> {
    assertReader(caller);

    const existing = await reportRepository.findCertificate(id, null);
    if (!existing) throw AppError.notFound('No such certificate');

    if (existing.state === 'issued') {
      throw AppError.conflict(
        `${existing.reference} was already issued on ${existing.issuedAt?.slice(0, 10) ?? 'an earlier date'}`,
      );
    }

    const account = await accountRepository.findById(existing.accountId, { accountId: null });

    /*
     * Matt, 31:04 — certificates often go to a different team from invoices:
     * *"I need a section where we could say that certificates are sent to this
     * specific email address."* Falls back to null rather than the accounts
     * address, because sending a sustainability document to accounts payable is
     * how it gets ignored.
     */
    const issuedTo = account?.certificateEmail ?? null;

    const issued = await reportRepository.issueCertificate(id, issuedTo, caller.name);
    if (!issued) {
      throw AppError.conflict('That certificate was issued by somebody else — reload');
    }

    const certificate = await reportRepository.findCertificate(id, null);
    if (!certificate) throw AppError.notFound('No such certificate');

    log.info(
      { certificateId: id, reference: certificate.reference, issuedTo, by: caller.name },
      'certificate issued',
    );

    return certificate;
  },
};

/* ── Access and validation ───────────────────────────────────────────────── */

function isCustomer(caller: Caller): boolean {
  return caller.roles.some((role) => CUSTOMER_ROLES.has(role));
}

/** Non-null narrows certificate reads to one account. */
function scopeAccount(caller: Caller): string | null {
  if (!isCustomer(caller)) return null;
  // Fail closed: a customer session with no account sees nothing, never all.
  return caller.accountId ?? '000000000000000000000000';
}

/**
 * Forces a customer's own account onto the filters.
 *
 * A customer reaching a report must not be able to widen it by supplying
 * somebody else's account id — or none at all, which would be everybody's.
 */
function scopeFilters(filters: ReportFilters, caller: Caller): ReportFilters {
  if (!isCustomer(caller)) return filters;
  return { ...filters, accountId: caller.accountId ?? '000000000000000000000000' };
}

/**
 * Refuses a range that is backwards or absurd.
 *
 * The cap is not arbitrary: an unbounded range is how one request aggregates
 * every job PlastaGo has ever done, and the office's real questions are months
 * and quarters.
 */
function assertRange(filters: ReportFilters): void {
  if (filters.from > filters.to) {
    throw AppError.validation('The period ends before it starts', [
      { path: 'to', message: 'Choose an end date on or after the start date' },
    ]);
  }

  const days =
    (Date.parse(`${filters.to}T00:00:00Z`) - Date.parse(`${filters.from}T00:00:00Z`)) / 86_400_000;

  if (!Number.isFinite(days)) {
    throw AppError.validation('That is not a valid date range', [
      { path: 'from', message: 'Choose dates from the calendar' },
    ]);
  }

  if (days > 366 * 3) {
    throw AppError.validation('That range is too long', [
      { path: 'from', message: 'Reports cover up to three years at a time' },
    ]);
  }
}

function assertReader(caller: Caller): void {
  // A customer reading their own is handled by the portal; this is the office.
  if (isCustomer(caller)) return;

  if (!caller.roles.some((role) => REPORT_ROLES.has(role))) {
    throw AppError.forbidden('Reports are for office staff');
  }
}

function assertFinancial(caller: Caller): void {
  if (!caller.roles.some((role) => FINANCIAL_ROLES.has(role))) {
    // Margin is not something a customer or an allocator sees.
    throw AppError.forbidden('The financial summary is for operations and super-admins');
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** `PG-CERT-2026-0041` — readable off a printed page by an auditor. */
async function nextReference(): Promise<string> {
  const year = new Date().getFullYear();
  const next = await reportRepository.nextReferenceNumber(year);
  return `PG-CERT-${String(year)}-${String(next).padStart(4, '0')}`;
}

/** One decimal place. Areas and weights are measurements, not currency. */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}
