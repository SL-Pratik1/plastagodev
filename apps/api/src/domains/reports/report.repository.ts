import type {
  Certificate,
  CertificateScope,
  CertificateWeightBasis,
  PageMeta,
  ReportFilters,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { startOfSydneyDay, todayInSydney } from '../../lib/business-day.js';
import { UNKNOWN_ZONE_LABEL, orderedZones, toObjectId } from '../settings/zone-lookup.js';
import { RunTipOffModel } from '../dispatch/run.model.js';
import { JobChargeModel, JobModel } from '../jobs/job.model.js';
import { CertificateModel } from './certificate.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 *
 * ── Why every report aggregates rather than reads a rollup table ──────────
 * Because a rollup that is written by one path and read by another is two
 * places that can disagree, and a monthly volume report disagreeing with the
 * jobs grid is a report nobody trusts twice. These run over a few thousand
 * completed jobs — small enough that the honest query is also the fast one.
 *
 * ⚠️ Every report counts only work that ACTUALLY HAPPENED: `completed` and
 * `admin-complete`. A cancelled job has no diverted tonnage and a futile one
 * collected nothing, so including either would put tonnage on a diversion
 * certificate that never left a site.
 */

/**
 * `as const` so Mongoose's typed `find()` accepts it as a status union rather
 * than as a widened `string[]`, which it refuses.
 */
const COMPLETED = ['completed', 'admin-complete'] as const;

export interface VolumeAggregate {
  key: string;
  label: string;
  jobs: number;
  areaM2: number;
  /** Null on accounts that do not capture weight (M2.3). */
  weightKg: number | null;
  bags: number;
  chargesCents: number;
}

export interface ZoneAggregate {
  zoneId: string;
  label: string;
  jobs: number;
  areaM2: number;
  revenueCents: number;
}

export interface FinancialAggregate {
  key: string;
  label: string;
  jobs: number;
  baseRevenueCents: number;
  additionalCents: number;
}

/**
 * Turns report filters into a match stage.
 *
 * `completedAt` is the date axis, not `readyDate` or `createdAt`: a report of
 * September's volume means work done in September, and a job booked in August
 * for a September pickup belongs in September.
 */
function matchStage(filters: ReportFilters): Record<string, unknown> {
  const match: Record<string, unknown> = {
    status: { $in: COMPLETED },
    completedAt: {
      $gte: new Date(`${filters.from}T00:00:00.000Z`),
      // End of the day, so a job completed at 4pm on the `to` date is included.
      $lte: new Date(`${filters.to}T23:59:59.999Z`),
    },
  };

  if (filters.accountId && mongoose.isValidObjectId(filters.accountId)) {
    match.accountId = new mongoose.Types.ObjectId(filters.accountId);
  }
  /* Dropped when it is not an id — a bookmarked report URL may predate zones. */
  const zoneFilter = filters.zoneId ? toObjectId(filters.zoneId) : null;
  if (zoneFilter) match.zoneId = zoneFilter;
  if (filters.suburb) match.suburb = filters.suburb;
  if (filters.driverId && mongoose.isValidObjectId(filters.driverId)) {
    match.driverId = new mongoose.Types.ObjectId(filters.driverId);
  }

  return match;
}

export const reportRepository = {
  /**
   * M9.1 — volume per customer, or per SITE when one customer is selected.
   *
   * The grouping flips deliberately: "how much did each customer send us" is
   * the question at portfolio level, and "which of my sites" is the question
   * once you have picked one. A single report that always grouped by account
   * would answer the first well and the second not at all.
   */
  async volume(filters: ReportFilters): Promise<VolumeAggregate[]> {
    const groupBySite = Boolean(filters.accountId);

    const rows = await JobModel.aggregate<{
      _id: string;
      label: string;
      jobs: number;
      areaM2: number;
      weightKg: number;
      weighedJobs: number;
      bags: number;
    }>([
      { $match: matchStage(filters) },
      {
        $group: {
          _id: groupBySite ? '$siteName' : { $toString: '$accountId' },
          label: { $first: groupBySite ? '$siteName' : '$accountName' },
          jobs: { $sum: 1 },
          // `$ifNull` to 0 for the SUM only: a job with no area contributes
          // nothing rather than making the whole total null.
          areaM2: { $sum: { $ifNull: ['$expectedAreaM2', 0] } },
          weightKg: { $sum: { $ifNull: ['$recoveredWeightKg', 0] } },
          /*
           * How many jobs actually carried a weight. Used below to tell "this
           * account records no weight" from "this account recovered zero" —
           * see the note on `weightKg`.
           */
          weighedJobs: {
            $sum: { $cond: [{ $ne: ['$recoveredWeightKg', null] }, 1, 0] },
          },
          /*
           * Collected, not ordered — this sits beside `weightKg` and answers
           * "what came off site". `$ifNull` covers jobs saved before the
           * allowance and the driver's count were separate fields.
           */
          bags: { $sum: { $ifNull: ['$collectedBagCount', '$bagCount'] } },
        },
      },
      { $sort: { areaM2: -1 } },
    ]);

    const charges = await chargeTotals(filters, groupBySite);

    return rows.map((row) => ({
      key: row._id,
      label: row.label,
      jobs: row.jobs,
      areaM2: row.areaM2,
      /*
       * ⚠️ Null, not zero, when nothing in the group was weighed. An m²-only
       * account (M2.3) recovered kilograms nobody measured — reporting 0 kg
       * would read as "we diverted nothing", which is a different claim.
       */
      weightKg: row.weighedJobs > 0 ? row.weightKg : null,
      bags: row.bags,
      chargesCents: charges.get(row._id) ?? 0,
    }));
  },

  /** M9.1 — the monthly trend line, on the same filters. */
  async byMonth(
    filters: ReportFilters,
  ): Promise<Array<{ month: string; jobs: number; areaM2: number }>> {
    const rows = await JobModel.aggregate<{ _id: string; jobs: number; areaM2: number }>([
      { $match: matchStage(filters) },
      {
        $group: {
          // Formatted in the business's own timezone: a job completed at 9am
          // Sydney on 1 October is October's, whatever UTC says.
          _id: {
            $dateToString: {
              format: '%Y-%m',
              date: '$completedAt',
              timezone: 'Australia/Sydney',
            },
          },
          jobs: { $sum: 1 },
          areaM2: { $sum: { $ifNull: ['$expectedAreaM2', 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    return rows.map((row) => ({ month: row._id, jobs: row.jobs, areaM2: row.areaM2 }));
  },

  /**
   * M9.3 — the Sydney / Wollongong / Newcastle split.
   *
   * ── Revenue comes from the CHARGES, not from `job.totalExGst` ─────────────
   * ⚠️ This used to `$sum: '$totalExGst'`, which is the quote frozen on the job
   * when it was booked. Every charge raised afterwards — contamination, extra
   * bags, extra load time, the futile fee, anything the office added — lives in
   * `jobcharges` and never reaches that field, so the zone tab under-reported
   * revenue against the volume and financial tabs on the same screen. On this
   * dataset it was $3,933 short over ten weeks, while jobs and m² matched
   * exactly, which is the worst shape for a reconciliation error: everything
   * looks right except the money.
   *
   * `financial` already reads the charge rows for exactly this reason. Same
   * source here, same answer, and the three tabs now agree.
   */
  async byZone(filters: ReportFilters): Promise<ZoneAggregate[]> {
    const [rows, zones] = await Promise.all([
      JobModel.aggregate<{
        _id: mongoose.Types.ObjectId;
        jobs: number;
        areaM2: number;
        jobIds: mongoose.Types.ObjectId[];
      }>([
        { $match: matchStage(filters) },
        {
          $group: {
            _id: '$zoneId',
            jobs: { $sum: 1 },
            areaM2: { $sum: { $ifNull: ['$expectedAreaM2', 0] } },
            jobIds: { $push: '$_id' },
          },
        },
        /*
         * ⚠️ Deliberately NOT sorted in the pipeline any more.
         *
         * It sorted `_id: 1` — alphabetically by slug, which read as a sensible
         * order only because the three slugs happened to sort the way the office
         * thinks. On ids it would be meaningless. The rows are put into the
         * administrator's own `displayOrder` below instead.
         */
      ]),
      orderedZones(),
    ]);

    const order = new Map(zones.map((zone, index) => [zone.id, index]));
    const names = new Map(zones.map((zone) => [zone.id, zone.label]));

    // One read for every job in the report, then bucketed — not a lookup per
    // zone. Same approach as `financial`.
    const chargesByJob = await chargesByJobId(rows.flatMap((row) => row.jobIds));

    const aggregates = rows.map((row) => {
      let revenueCents = 0;
      for (const jobId of row.jobIds) {
        const split = chargesByJob.get(jobId.toHexString());
        revenueCents += (split?.base ?? 0) + (split?.additional ?? 0);
      }

      /*
       * ⚠️ A null key is a job with no zone — a data fault, since every job is
       * written with one. It is grouped and SHOWN rather than dropped or thrown
       * on: the revenue is real and has to reach the total, and a row somebody
       * can see is how the fault gets found. Dropping it would make the zone
       * report quietly disagree with the financial one.
       */
      const zoneId = row._id === null ? '' : row._id.toString();

      return {
        zoneId,
        label: zoneId === '' ? 'No zone' : (names.get(zoneId) ?? UNKNOWN_ZONE_LABEL),
        jobs: row.jobs,
        areaM2: row.areaM2,
        revenueCents,
      };
    });

    return aggregates.sort(
      (a, b) =>
        (order.get(a.zoneId) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.zoneId) ?? Number.MAX_SAFE_INTEGER),
    );
  },

  /**
   * M9.6 — revenue split into base and additional services.
   *
   * Split at the source rather than subtracted afterwards: the margin question
   * is "how much of this came from exceptions", and a single total cannot
   * answer it.
   */
  async financial(
    filters: ReportFilters,
    groupBy: 'account' | 'zone',
  ): Promise<FinancialAggregate[]> {
    const rows = await JobModel.aggregate<{
      _id: string;
      label: string;
      jobs: number;
      jobIds: mongoose.Types.ObjectId[];
    }>([
      { $match: matchStage(filters) },
      {
        $group: {
          _id: groupBy === 'zone' ? '$zone' : { $toString: '$accountId' },
          label: { $first: groupBy === 'zone' ? '$zone' : '$accountName' },
          jobs: { $sum: 1 },
          jobIds: { $push: '$_id' },
        },
      },
      { $sort: { jobs: -1 } },
    ]);

    /*
     * Charges are read once for every job in the report, then bucketed —
     * rather than a lookup per group, which on a 12-month report is one query
     * per customer.
     */
    const allJobIds = rows.flatMap((row) => row.jobIds);
    const chargesByJob = await chargesByJobId(allJobIds);

    return rows.map((row) => {
      let baseRevenueCents = 0;
      let additionalCents = 0;

      for (const jobId of row.jobIds) {
        const split = chargesByJob.get(jobId.toHexString());
        baseRevenueCents += split?.base ?? 0;
        additionalCents += split?.additional ?? 0;
      }

      return {
        key: row._id,
        label: row.label,
        jobs: row.jobs,
        baseRevenueCents,
        additionalCents,
      };
    });
  },

  /* ── M9.5 · certificates ───────────────────────────────────────────────── */

  async listCertificates(
    query: {
      page: number;
      pageSize: number;
      state?: string | undefined;
      q?: string | undefined;
    },
    accountId: string | null,
  ): Promise<{ data: Certificate[]; meta: PageMeta }> {
    const filter: Record<string, unknown> = {};

    // Non-null scopes a customer to their own. The office passes null.
    if (accountId) filter.accountId = new mongoose.Types.ObjectId(accountId);
    if (query.state) filter.state = query.state;

    /*
     * ⚠️ The screen has always had a search box and nothing read the term.
     *
     * A certificate is looked up by its reference — that is the string quoted
     * in a GBCA submission — or by the site it covers.
     */
    if (query.q) {
      const like = { $regex: escapeRegex(query.q), $options: 'i' };
      filter.$or = [{ reference: like }, { siteName: like }];
    }

    const [rows, total] = await Promise.all([
      CertificateModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean<RawCertificate[]>(),
      CertificateModel.countDocuments(filter),
    ]);

    return {
      data: rows.map(toCertificate),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  },

  async findCertificate(id: string, accountId: string | null): Promise<Certificate | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    const filter: Record<string, unknown> = { _id: new mongoose.Types.ObjectId(id) };
    if (accountId) filter.accountId = new mongoose.Types.ObjectId(accountId);

    const row = await CertificateModel.findOne(filter).lean<RawCertificate>();
    return row ? toCertificate(row) : null;
  },

  /**
   * The figures a certificate is built from.
   *
   * ⚠️ `tonnesDiverted` comes from `recoveredWeightKg` — the reconciled
   * weighbridge figure (M4.4) — never from the priced m². A builder's Green
   * Star submission is audited against what actually reached the facility.
   */
  async certificateFigures(input: {
    accountId: string;
    from: string;
    to: string;
    jobId?: string | null;
    siteName?: string | null;
  }): Promise<{ jobs: number; areaM2: number | null; weightKg: number; siteName: string | null }> {
    /*
     * ⚠️ SYDNEY day boundaries, not UTC ones.
     *
     * `completedAt` is an instant and the period is a pair of calendar dates.
     * `new Date(\`${from}T00:00:00.000Z\`)` reads like the start of the day and
     * is not — it is 10am in Sydney, so a pickup completed at 8am would fall
     * outside its own day. That matters twice here: the certificate would omit
     * the morning's work, and the automatic draft asks for exactly one day,
     * so a morning pickup would find nothing at all and never be certified.
     *
     * Upper bound is EXCLUSIVE against the start of the next day, which is the
     * only form that cannot drop the last millisecond of an evening job.
     */
    const match: Record<string, unknown> = {
      accountId: new mongoose.Types.ObjectId(input.accountId),
      status: { $in: COMPLETED },
      completedAt: {
        $gte: startOfSydneyDay(input.from),
        $lt: startOfSydneyDay(dayAfter(input.to)),
      },
    };

    if (input.jobId && mongoose.isValidObjectId(input.jobId)) {
      match._id = new mongoose.Types.ObjectId(input.jobId);
    }
    if (input.siteName) match.siteName = input.siteName;

    /*
     * ⚠️ ACTUALLY WEIGHED jobs only, and this line is the compliance rule.
     *
     * Matt, 32:11: *"this is only for weighed jobs. If it's an estimated job,
     * we're unable to provide a certificate because it's an estimated weight and
     * it doesn't meet compliance regulation."*
     *
     * `actual` means a crane-scale reading taken as the bags went on the truck.
     * A hand load's `estimated` figure is its share of the weighbridge remainder
     * apportioned by m² (M4.4) — a defensible number for a report, but not a
     * measurement of THIS job, and a Green Star assessor is entitled to reject it.
     *
     * Excluding them here rather than in the service is deliberate: the figures
     * and the eligibility have to come from one query, or a certificate could be
     * prepared from a job count that includes work its tonnage does not.
     */
    match.recoveredWeightBasis = 'actual';

    const rows = await JobModel.aggregate<{
      jobs: number;
      areaM2: number;
      areaJobs: number;
      weightKg: number;
      siteName: string;
    }>([
      { $match: match },
      {
        $group: {
          _id: null,
          jobs: { $sum: 1 },
          areaM2: { $sum: { $ifNull: ['$expectedAreaM2', 0] } },
          // How many jobs carried an area at all — see the null rule below.
          areaJobs: { $sum: { $cond: [{ $ne: ['$expectedAreaM2', null] }, 1, 0] } },
          weightKg: { $sum: { $ifNull: ['$recoveredWeightKg', 0] } },
          siteName: { $first: '$siteName' },
        },
      },
    ]);

    const row = rows[0];
    if (!row) return { jobs: 0, areaM2: null, weightKg: 0, siteName: null };

    return {
      jobs: row.jobs,
      /*
       * Null when NO job in scope carried an area — a fixed-price builder's POs
       * carry none (Matt, 31:04). The certificate is still valid; a zero would
       * claim they installed no plasterboard.
       */
      areaM2: row.areaJobs > 0 ? row.areaM2 : null,
      weightKg: row.weightKg,
      siteName: row.siteName,
    };
  },

  /**
   * What a job-scoped certificate prints besides its figures.
   *
   * ── Why the docket is fetched through the run ─────────────────────────────
   * The crane scale evidences what left the SITE; the weighbridge docket
   * evidences what reached the FACILITY. A Green Star assessor wants both, and
   * only the second one proves the diversion actually happened. A job carries
   * `runId`, the docket hangs off the run (one docket, one run — see
   * `run.model.ts`), so this is the join that puts them on one page.
   *
   * Returns null for a job that does not exist. Every field is separately
   * nullable: a run with no docket recorded yet still produces a valid
   * certificate, it just prints one fewer line.
   */
  async certificateJobContext(jobId: string): Promise<{
    jobNumber: number | null;
    siteName: string | null;
    siteAddress: string | null;
    collectedOn: string | null;
    docketNumber: string | null;
    tippedOffAt: Date | null;
  } | null> {
    if (!mongoose.isValidObjectId(jobId)) return null;

    const job = await JobModel.findById(jobId)
      .select({ jobNumber: 1, siteName: 1, addressLine: 1, suburb: 1, completedAt: 1, runId: 1 })
      .lean<{
        jobNumber: number | null;
        siteName: string | null;
        addressLine: string | null;
        suburb: string | null;
        completedAt: Date | null;
        runId: mongoose.Types.ObjectId | null;
      }>();

    if (!job) return null;

    const docket = job.runId
      ? await RunTipOffModel.findOne({ runId: job.runId })
          .select({ docketNumber: 1, tippedOffAt: 1 })
          .lean<{ docketNumber: string | null; tippedOffAt: Date | null }>()
      : null;

    return {
      jobNumber: job.jobNumber,
      siteName: job.siteName,
      // One line, the way an address is read off a page — not two fields.
      siteAddress:
        [job.addressLine, job.suburb].filter((part) => (part ?? '').trim() !== '').join(', ') ||
        null,
      // ⚠️ The SYDNEY date. A pickup at 8am on the 3rd is 22:00 UTC on the
      // 2nd, and this date is printed on the document as "Collected".
      collectedOn: job.completedAt ? todayInSydney(job.completedAt) : null,
      docketNumber: docket?.docketNumber ?? null,
      tippedOffAt: docket?.tippedOffAt ?? null,
    };
  },

  /**
   * The jobs on a run that a certificate could be prepared for (M9.5).
   *
   * Used by the automatic draft after a tip-off is reconciled. Applies the same
   * two rules the figures query does — completed, and ACTUALLY weighed — plus
   * one more: no certificate already exists for the job. That last check is why
   * this returns a list rather than the caller looping: the office may have
   * prepared one by hand before the truck reached the tip.
   */
  async certifiableJobsOnRun(runId: string): Promise<
    Array<{ jobId: string; accountId: string; completedOn: string }>
  > {
    if (!mongoose.isValidObjectId(runId)) return [];

    const jobs = await JobModel.find({
      runId: new mongoose.Types.ObjectId(runId),
      status: { $in: COMPLETED },
      recoveredWeightBasis: 'actual',
      recoveredWeightKg: { $gt: 0 },
      completedAt: { $ne: null },
    })
      .select({ accountId: 1, completedAt: 1 })
      .lean<Array<{ _id: mongoose.Types.ObjectId; accountId: mongoose.Types.ObjectId; completedAt: Date }>>();

    if (jobs.length === 0) return [];

    const existing = await CertificateModel.find({ jobId: { $in: jobs.map((job) => job._id) } })
      .select({ jobId: 1 })
      .lean<Array<{ jobId: mongoose.Types.ObjectId }>>();

    const taken = new Set(existing.map((row) => row.jobId.toHexString()));

    return jobs
      .filter((job) => !taken.has(job._id.toHexString()))
      .map((job) => ({
        jobId: job._id.toHexString(),
        accountId: job.accountId.toHexString(),
        // Sydney again — this becomes the certificate's period, and the
        // figures query below resolves it back to the same Sydney day.
        completedOn: todayInSydney(job.completedAt),
      }));
  },

  async createCertificate(input: {
    reference: string;
    scope: CertificateScope;
    accountId: string;
    accountName: string;
    siteName: string | null;
    siteAddress: string | null;
    jobId: string | null;
    jobNumber: number | null;
    collectedOn: string | null;
    periodFrom: string;
    periodTo: string;
    jobs: number;
    areaM2: number | null;
    tonnesDiverted: number;
    weightBasis: CertificateWeightBasis;
    docketNumber: string | null;
    tippedOffAt: Date | null;
  }): Promise<string> {
    const created = await CertificateModel.create({
      ...input,
      accountId: new mongoose.Types.ObjectId(input.accountId),
      jobId: input.jobId ? new mongoose.Types.ObjectId(input.jobId) : null,
      state: 'draft',
    });

    return created._id.toHexString();
  },

  /**
   * Point an issued certificate at its rendered PDF.
   *
   * ⚠️ Writes ONLY `storageKey`. Everything else froze at issue, and a render
   * that could touch a figure would defeat the freeze — the whole reason the
   * document is stored rather than recomputed.
   */
  /**
   * The stored PDF's key, scoped the same way `findCertificate` is.
   *
   * Separate from the certificate itself because the key never crosses the API
   * boundary — this is for the download endpoint, which turns it into a
   * short-lived link and returns that instead.
   */
  async certificateStorageKey(id: string, accountId: string | null): Promise<string | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    const filter: Record<string, unknown> = { _id: new mongoose.Types.ObjectId(id) };
    if (accountId) filter.accountId = new mongoose.Types.ObjectId(accountId);

    const row = await CertificateModel.findOne(filter)
      .select({ storageKey: 1 })
      .lean<{ storageKey: string | null }>();

    const key = row?.storageKey ?? '';
    return key.trim() === '' ? null : key;
  },

  async recordCertificatePdf(id: string, storageKey: string): Promise<void> {
    if (!mongoose.isValidObjectId(id)) return;

    await CertificateModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { storageKey } },
    );
  },

  /**
   * Issues a certificate, freezing it.
   *
   * ⚠️ `state: 'draft'` is in the FILTER. An issued certificate is a document
   * somebody has submitted to an auditor — re-issuing it would change figures
   * that are already in a Green Star pack.
   */
  async issueCertificate(
    id: string,
    issuedTo: string | null,
    issuedByName: string,
  ): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;

    const result = await CertificateModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id), state: 'draft' },
      { $set: { state: 'issued', issuedAt: new Date(), issuedTo, issuedByName } },
    );

    return result.matchedCount === 1;
  },

  /** Whether a job already has a certificate — the double-claim guard. */
  async certificateExistsForJob(jobId: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(jobId)) return false;

    return (
      (await CertificateModel.countDocuments({ jobId: new mongoose.Types.ObjectId(jobId) })) > 0
    );
  },

  /** The next reference in the year's sequence. */
  async nextReferenceNumber(year: number): Promise<number> {
    const latest = await CertificateModel.findOne(
      { reference: { $regex: `^PG-CERT-${String(year)}-` } },
      { reference: 1 },
    )
      .sort({ reference: -1 })
      .lean<{ reference: string }>();

    if (!latest) return 1;

    const suffix = Number(latest.reference.split('-').at(-1));
    return Number.isFinite(suffix) ? suffix + 1 : 1;
  },
};

/* ── Mapping ─────────────────────────────────────────────────────────────── */

interface RawCertificate {
  _id: mongoose.Types.ObjectId;
  reference: string;
  scope: CertificateScope;
  state: Certificate['state'];
  accountId: mongoose.Types.ObjectId;
  accountName: string;
  siteName: string | null;
  siteAddress: string | null;
  jobNumber: number | null;
  collectedOn: string | null;
  periodFrom: string;
  periodTo: string;
  jobs: number;
  areaM2: number | null;
  tonnesDiverted: number;
  weightBasis: CertificateWeightBasis | null;
  docketNumber: string | null;
  tippedOffAt: Date | null;
  issuedAt: Date | null;
  issuedTo: string | null;
  issuedByName: string | null;
  storageKey: string | null;
}

/**
 * The calendar day after this one — `2026-09-30` → `2026-10-01`.
 *
 * Pure calendar arithmetic on a plain date, so UTC is the right frame here:
 * there is no instant involved, and month and year rollovers come free. The
 * result is handed to `startOfSydneyDay`, which is what applies the timezone.
 */
function dayAfter(isoDate: string): string {
  const next = new Date(`${isoDate}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function toCertificate(row: RawCertificate): Certificate {
  return {
    id: row._id.toHexString(),
    reference: row.reference,
    scope: row.scope,
    state: row.state,
    accountId: row.accountId.toHexString(),
    accountName: row.accountName,
    siteName: row.siteName,
    siteAddress: row.siteAddress ?? null,
    jobNumber: row.jobNumber,
    collectedOn: row.collectedOn ?? null,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    jobs: row.jobs,
    areaM2: row.areaM2,
    tonnesDiverted: row.tonnesDiverted,
    /*
     * Defaulted for rows written before the basis was recorded. `weighed` is
     * the safe direction: every certificate that existed then was prepared
     * under the same rule this column now makes explicit.
     */
    weightBasis: row.weightBasis ?? 'weighed',
    docketNumber: row.docketNumber ?? null,
    tippedOffAt: row.tippedOffAt ? row.tippedOffAt.toISOString() : null,
    issuedAt: row.issuedAt ? row.issuedAt.toISOString() : null,
    issuedTo: row.issuedTo,
    issuedByName: row.issuedByName ?? null,
    /*
     * A boolean, never the key. The key is a bucket path, and the client's only
     * legitimate question is whether there is something to download — the link
     * itself is minted per request and expires.
     */
    hasPdf: (row.storageKey ?? '').trim() !== '',
  };
}

/* ── Charge helpers ──────────────────────────────────────────────────────── */

/**
 * Billable charge totals per group.
 *
 * Only `approved` and `not-required` count. A pending charge is one the office
 * has not looked at and a rejected one is a charge they decided not to make —
 * reporting either as revenue would be reporting a decision nobody took.
 */
async function chargeTotals(
  filters: ReportFilters,
  groupBySite: boolean,
): Promise<Map<string, number>> {
  const rows = await JobModel.aggregate<{ _id: string; total: mongoose.Types.Decimal128 }>([
    { $match: matchStage(filters) },
    {
      $lookup: {
        from: 'jobcharges',
        localField: '_id',
        foreignField: 'jobId',
        as: 'charges',
        pipeline: [{ $match: { approvalState: { $in: ['approved', 'not-required'] } } }],
      },
    },
    { $unwind: { path: '$charges', preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: groupBySite ? '$siteName' : { $toString: '$accountId' },
        total: { $sum: { $ifNull: ['$charges.amount', 0] } },
      },
    },
  ]);

  return new Map(rows.map((row) => [row._id, decimalToCents(row.total)]));
}

/** Base vs additional revenue, per job. See `financial`. */
async function chargesByJobId(
  jobIds: mongoose.Types.ObjectId[],
): Promise<Map<string, { base: number; additional: number }>> {
  if (jobIds.length === 0) return new Map();

  const rows = await JobChargeModel.aggregate<{
    _id: { jobId: mongoose.Types.ObjectId; source: string };
    total: mongoose.Types.Decimal128;
  }>([
    {
      $match: {
        jobId: { $in: jobIds },
        approvalState: { $in: ['approved', 'not-required'] },
      },
    },
    { $group: { _id: { jobId: '$jobId', source: '$source' }, total: { $sum: '$amount' } } },
  ]);

  const byJob = new Map<string, { base: number; additional: number }>();

  for (const row of rows) {
    const key = row._id.jobId.toHexString();
    const current = byJob.get(key) ?? { base: 0, additional: 0 };
    const cents = decimalToCents(row.total);

    /*
     * `driver` charges are the exceptions raised on site — contamination,
     * futile, extra load time. Everything else is the job as sold. That split
     * is the one the margin question actually asks about.
     */
    if (row._id.source === 'driver') current.additional += cents;
    else current.base += cents;

    byJob.set(key, current);
  }

  return byJob;
}

/**
 * `Decimal128` to integer cents.
 *
 * Mongo's `$sum` over Decimal128 returns a Decimal128; converting through a
 * string keeps it exact, which is the whole reason money is stored that way
 * (§6A.10 #1).
 */
function decimalToCents(value: mongoose.Types.Decimal128 | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Math.round(value * 100);

  const text = value.toString();
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));

  return negative ? -cents : cents;
}

/** Local, as in the sibling repositories — an unescaped `(` from the search
 *  box would otherwise reach Mongo as an invalid expression. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
