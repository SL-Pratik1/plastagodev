import type {
  JobPhoto,
  PortalInvoice,
  JobStatus,
  PageMeta,
  PortalJob,
  PortalJobListItem,
  PortalJobStep,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { zoneLabelFor } from '../settings/zone-lookup.js';
import { fromDecimal128 } from '../../lib/money.js';
import {
  JobCommentModel,
  JobEventModel,
  JobModel,
  JobPhotoModel,
} from '../jobs/job.model.js';
import { InvoiceModel } from '../invoices/invoice.model.js';
import { ChangeRequestModel, ReadinessCertificationModel } from './portal.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 *
 * ── The whole domain is one access boundary ───────────────────────────────
 * Every read here takes a `PortalScope` and folds it into the FILTER. A builder
 * seeing another builder's job is the worst failure this system can have — it
 * exposes what a competitor pays — so the scope is never applied after the fact
 * and never left to a controller.
 */

export interface PortalScope {
  /** Always set. A portal caller with no account is a broken session. */
  accountId: string;
  /**
   * Non-null narrows to the jobs this person RAISED — a site supervisor.
   *
   * Matt, 18:15: *"site supervisors can submit their jobs and be able to see the
   * jobs they've submitted."* This replaces the site-list scoping of M1.5, which
   * went with the sites (0:29).
   */
  bookedByUserId: string | null;
}

export interface PortalJobsQuery {
  page: number;
  pageSize: number;
  sort?: string | undefined;
  q?: string | undefined;
  status?: JobStatus | undefined;
  /** M5.2 — jobs whose readiness nobody has confirmed yet. */
  readiness?: 'pending' | 'certified' | undefined;
  readyWindow?: string | undefined;
}

/** Statuses where "is it ready?" is still a live question (M5.2). */
const PENDING_READINESS_STATUSES: JobStatus[] = ['booked', 'assigned'];

/** M5.4 — a job is freely editable only before it reaches a run sheet. */
const EDITABLE_STATUSES: JobStatus[] = ['booked'];

/** Still in play — the customer's working set. */
const OPEN_STATUSES: JobStatus[] = ['booked', 'assigned', 'in-transit', 'arrived'];

/** Urgency still means something on these. Not on finished work. */
const URGENCY_STATUSES: JobStatus[] = ['booked', 'assigned', 'in-transit'];

/**
 * What a customer may see of their own invoices.
 *
 * ⚠️  is absent on purpose — see `listInvoices`.
 */
const VISIBLE_INVOICE_STATUSES: PortalInvoice['status'][] = [
  'awaiting-po',
  'sent',
  'paid',
  'overdue',
];

interface RawPortalInvoice {
  _id: mongoose.Types.ObjectId;
  invoiceNumber: number;
  kind: 'base' | 'additional-charges';
  status: string;
  jobId: mongoose.Types.ObjectId | null;
  jobNumber: number | null;
  poNumber: string | null;
  issuedOn: string | null;
  dueOn: string | null;
  subtotalExGst: mongoose.Types.Decimal128;
  gst: mongoose.Types.Decimal128;
  totalIncGst: mongoose.Types.Decimal128;
  paidAt: Date | null;
}

/** Work that actually happened — what the month's totals are built from. */
const COMPLETED_STATUSES: JobStatus[] = ['completed', 'admin-complete'];

interface RawJob {
  _id: mongoose.Types.ObjectId;
  jobNumber: number;
  status: JobStatus;
  accountId: mongoose.Types.ObjectId;
  builderName: string;
  siteName: string;
  suburb: string;
  zoneId: mongoose.Types.ObjectId;
  poNumber: string | null;
  bookedByName: string | null;
  bookedByUserId: mongoose.Types.ObjectId | null;
  readyDate: string;
  targetDate: string;
  serviceLevel: 'standard' | 'urgent';
  expectedAreaM2: number | null;
  recoveredWeightKg: number | null;
  bagCount: number;
  totalIncGst: mongoose.Types.Decimal128;
  completedAt: Date | null;
  arrivedAt: Date | null;
  driverName: string | null;
  notes: string;
  runId: mongoose.Types.ObjectId | null;
}

interface Certification {
  jobId: mongoose.Types.ObjectId;
  certifiedAt: Date;
  certifiedByName: string;
}

const SORTABLE: Record<string, string> = {
  jobNumber: 'jobNumber',
  siteName: 'siteName',
  status: 'status',
  readyDate: 'readyDate',
  targetDate: 'targetDate',
  createdAt: 'createdAt',
};

/**
 * Builds the filter, scope first.
 *
 * ⚠️ The scope is written before anything else and to keys no facet touches, so
 * no query parameter can widen it.
 */
function scoped(scope: PortalScope): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    accountId: new mongoose.Types.ObjectId(scope.accountId),
  };

  if (scope.bookedByUserId !== null) {
    filter.bookedByUserId = new mongoose.Types.ObjectId(scope.bookedByUserId);
  }

  return filter;
}

export const portalRepository = {
  /**
   * The customer's own jobs.
   *
   * `canSeePricing` decides whether the money comes back AT ALL — it is nulled
   * here, in the repository, not hidden in the UI. A site supervisor's browser
   * never receives a figure it is not allowed to show.
   */
  async listJobs(
    query: PortalJobsQuery,
    scope: PortalScope,
    canSeePricing: boolean,
  ): Promise<{ data: PortalJobListItem[]; meta: PageMeta }> {
    const filter = scoped(scope);

    if (query.status) filter.status = query.status;
    if (query.q) filter.$text = { $search: query.q };

    if (query.readyWindow) {
      const window = resolveWindow(query.readyWindow);
      if (window) filter.readyDate = window;
    }

    /*
     * M5.2 — "not yet confirmed" is only a live question on jobs that have not
     * happened. Matching completed pickups too would return rows with nothing
     * left to action, and the dashboard counter would disagree with the list it
     * links to. One definition, applied in both places.
     */
    if (query.readiness) {
      const certifiedJobIds = await certifiedIds(scope);
      filter.status = { $in: PENDING_READINESS_STATUSES };
      filter._id = query.readiness === 'certified'
        ? { $in: certifiedJobIds }
        : { $nin: certifiedJobIds };
    }

    const sortKey = query.sort?.replace(/^-/, '') ?? '';
    const direction: 1 | -1 = query.sort?.startsWith('-') ? -1 : 1;
    const sortField = SORTABLE[sortKey];

    const sort: Record<string, 1 | -1> = sortField
      ? { [sortField]: direction }
      : { jobNumber: -1 };

    const [rows, total] = await Promise.all([
      JobModel.find(filter)
        .sort(sort)
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean<RawJob[]>(),
      JobModel.countDocuments(filter),
    ]);

    const jobIds = rows.map((row) => row._id);
    const [photoCounts, certifications] = await Promise.all([
      countPhotos(jobIds),
      latestCertifications(jobIds),
    ]);

    return {
      data: rows.map((row) => toListItem(row, canSeePricing, photoCounts, certifications)),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  },

  /** One job, with the completion record. Null when out of scope. */
  async findJob(
    id: string,
    scope: PortalScope,
    canSeePricing: boolean,
  ): Promise<PortalJob | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    const filter = scoped(scope);
    filter._id = new mongoose.Types.ObjectId(id);

    const row = await JobModel.findOne(filter).lean<RawJob>();
    if (!row) return null;

    const [photos, events, comments, certifications] = await Promise.all([
      JobPhotoModel.find({ jobId: row._id }).sort({ takenAt: 1 }).lean(),
      JobEventModel.find({ jobId: row._id }).sort({ at: 1 }).lean(),
      /*
       * ⚠️ `customer` visibility ONLY. `internal` is where the office talks
       * ABOUT this customer and `driver` is the thread with the truck — neither
       * belongs in a builder's browser, and filtering in the QUERY means neither
       * can reach one by accident.
       */
      JobCommentModel.find({ jobId: row._id, visibility: 'customer' }).sort({ at: 1 }).lean(),
      latestCertifications([row._id]),
    ]);

    const photoCounts = new Map([[row._id.toHexString(), photos.length]]);

    return {
      ...toListItem(row, canSeePricing, photoCounts, certifications),
      builderName: row.builderName,
      zoneId: row.zoneId.toString(),
      /*
       * Named here rather than by the portal. A builder may not read the zone
       * register — which markets PlastaGo operates in is not their business —
       * so the one zone they are entitled to see arrives already resolved.
       */
      zoneLabel: await zoneLabelFor(row.zoneId),
      notes: row.notes,
      driverName: row.driverName,
      arrivedAt: row.arrivedAt ? row.arrivedAt.toISOString() : null,
      photos: photos.map(
        (photo): JobPhoto => ({
          id: photo._id.toHexString(),
          caption: photo.caption,
          takenAt: photo.takenAt.toISOString(),
          takenBy: photo.takenBy ?? '',
          latitude: photo.latitude ?? null,
          longitude: photo.longitude ?? null,
        }),
      ),
      steps: events.map(
        (event): PortalJobStep => ({
          id: event._id.toHexString(),
          label: event.label,
          at: event.at.toISOString(),
          /*
           * ⚠️ The office actor is deliberately NOT named to the customer.
           * "Rescheduled by Priya Raman" invites a call asking for Priya; the
           * customer's relationship is with PlastaGo, not with a person.
           */
          by: null,
        }),
      ),
      messages: comments.map((comment) => ({
        id: comment._id.toHexString(),
        body: comment.body,
        author: comment.author,
        at: comment.at.toISOString(),
        fromCustomer: false,
      })),
      // Issued by the reporting domain (M9.5); null until then.
      certificateReference: null,
    };
  },

  /** The summary the dashboard is built from — counts, not documents. */
  async dashboardCounts(scope: PortalScope): Promise<{
    openJobs: number;
    atRiskJobs: number;
    completedThisMonth: number;
    areaThisMonthM2: number;
    weightThisMonthKg: number;
    awaitingReadiness: number;
    nextPickup: RawJob | null;
  }> {
    const base = scoped(scope);
    const today = todayIso();
    const monthStart = `${today.slice(0, 7)}-01`;

    const openFilter = { ...base, status: { $in: OPEN_STATUSES } };
    const certifiedJobIds = await certifiedIds(scope);

    const [openJobs, atRiskJobs, monthly, awaitingReadiness, nextPickup] = await Promise.all([
      JobModel.countDocuments(openFilter),
      // M2.4a — still open and the target date has passed.
      JobModel.countDocuments({ ...openFilter, targetDate: { $lt: today } }),
      JobModel.aggregate<{ count: number; area: number; weight: number }>([
        {
          $match: {
            ...base,
            status: { $in: COMPLETED_STATUSES },
            completedAt: { $gte: new Date(`${monthStart}T00:00:00.000Z`) },
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            // `$ifNull` to 0 for the SUM only — a job with no area contributes
            // nothing rather than making the whole total null.
            area: { $sum: { $ifNull: ['$expectedAreaM2', 0] } },
            weight: { $sum: { $ifNull: ['$recoveredWeightKg', 0] } },
          },
        },
      ]),
      JobModel.countDocuments({
        ...base,
        status: { $in: PENDING_READINESS_STATUSES },
        _id: { $nin: certifiedJobIds },
      }),
      // The next pickup, because "when are you coming" is call number one.
      JobModel.findOne({ ...openFilter, readyDate: { $gte: today } })
        .sort({ readyDate: 1 })
        .lean<RawJob>(),
    ]);

    const totals = monthly[0];

    return {
      openJobs,
      atRiskJobs,
      completedThisMonth: totals?.count ?? 0,
      areaThisMonthM2: totals?.area ?? 0,
      weightThisMonthKg: totals?.weight ?? 0,
      awaitingReadiness,
      nextPickup: nextPickup ?? null,
    };
  },

  /** M5.10 — outstanding money. Administrators only; the service gates it. */
  async outstandingInvoices(
    accountId: string,
  ): Promise<{ count: number; totalIncGst: string }> {
    const rows = await InvoiceModel.aggregate<{ count: number; total: mongoose.Types.Decimal128 }>([
      {
        $match: {
          accountId: new mongoose.Types.ObjectId(accountId),
          // What the customer still owes: sent or overdue, not yet paid.
          status: { $in: ['sent', 'overdue'] },
        },
      },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$totalIncGst' } } },
    ]);

    const row = rows[0];
    return {
      count: row?.count ?? 0,
      totalIncGst: row ? fromDecimal128(row.total) : '0.00',
    };
  },

  /** Whether this job is still freely editable (M5.4). */
  async findJobForEdit(
    id: string,
    scope: PortalScope,
  ): Promise<{
    id: string;
    jobNumber: number;
    status: JobStatus;
    editable: boolean;
    runId: string | null;
  } | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    const filter = scoped(scope);
    filter._id = new mongoose.Types.ObjectId(id);

    //  is here because the office notifications raised off a change
    // request and an urgency flag have to name the job in their title.
    const row = await JobModel.findOne(filter, {
      jobNumber: 1,
      status: 1,
      runId: 1,
    }).lean<{
      _id: mongoose.Types.ObjectId;
      jobNumber: number;
      status: JobStatus;
      runId: mongoose.Types.ObjectId | null;
    }>();

    if (!row) return null;

    return {
      id: row._id.toHexString(),
      jobNumber: row.jobNumber,
      status: row.status,
      editable: isEditable(row.status, row.runId),
      runId: row.runId ? row.runId.toHexString() : null,
    };
  },

  /**
   * M5.4 — applies an edit.
   *
   * ⚠️ The editable STATUS is part of the filter, and `runId: null` with it.
   * Between the check above and this write the allocator may have put the job
   * on a run; applying the edit then would change work somebody is already
   * holding.
   */
  async editJob(
    id: string,
    scope: PortalScope,
    input: {
      readyDate: string;
      targetDate: string;
      expectedAreaM2: number;
      bagCount: number;
      serviceLevel: 'standard' | 'urgent';
      poNumber: string | null;
      notes: string;
    },
  ): Promise<boolean> {
    const filter = scoped(scope);
    filter._id = new mongoose.Types.ObjectId(id);
    filter.status = { $in: EDITABLE_STATUSES };
    filter.runId = null;

    const result = await JobModel.updateOne(filter, { $set: input });
    return result.matchedCount === 1;
  },

  /** M5.5 — flag urgent. Allowed later than an edit: it adds nothing to do. */
  async setUrgency(id: string, scope: PortalScope, urgent: boolean): Promise<boolean> {
    const filter = scoped(scope);
    filter._id = new mongoose.Types.ObjectId(id);
    // Not on finished work — urgency on a completed job means nothing.
    filter.status = { $in: URGENCY_STATUSES };

    const result = await JobModel.updateOne(filter, {
      $set: { serviceLevel: urgent ? 'urgent' : 'standard' },
    });

    return result.matchedCount === 1;
  },

  /** M5.2 — records a certification. Append-only; see the model. */
  async certify(input: {
    jobId: string;
    jobReady: boolean;
    truckAccessible: boolean;
    freeOfContaminants: boolean;
    certifiedByUserId: string;
    certifiedByName: string;
    certifiedByCompany: string;
  }): Promise<void> {
    await ReadinessCertificationModel.create({
      jobId: new mongoose.Types.ObjectId(input.jobId),
      jobReady: input.jobReady,
      truckAccessible: input.truckAccessible,
      freeOfContaminants: input.freeOfContaminants,
      certifiedAt: new Date(),
      certifiedByUserId: new mongoose.Types.ObjectId(input.certifiedByUserId),
      certifiedByName: input.certifiedByName,
      certifiedByCompany: input.certifiedByCompany,
    });
  },

  /** M5.4 — files a change request for the office. */
  async requestChange(input: {
    jobId: string;
    accountId: string;
    kind: 'reschedule' | 'cancel' | 'other';
    requestedDate: string | null;
    note: string;
    requestedByUserId: string;
    requestedByName: string;
  }): Promise<string> {
    const created = await ChangeRequestModel.create({
      jobId: new mongoose.Types.ObjectId(input.jobId),
      accountId: new mongoose.Types.ObjectId(input.accountId),
      kind: input.kind,
      requestedDate: input.requestedDate,
      note: input.note,
      requestedByUserId: new mongoose.Types.ObjectId(input.requestedByUserId),
      requestedByName: input.requestedByName,
      requestedAt: new Date(),
      state: 'open',
    });

    return created._id.toHexString();
  },

  /** Whether this job already has an open request — stops duplicate asks. */
  async hasOpenChangeRequest(jobId: string): Promise<boolean> {
    const count = await ChangeRequestModel.countDocuments({
      jobId: new mongoose.Types.ObjectId(jobId),
      state: 'open',
    });
    return count > 0;
  },
};

/* ── Mapping ─────────────────────────────────────────────────────────────── */

function isEditable(status: JobStatus, runId: mongoose.Types.ObjectId | null): boolean {
  // The client's own rule: freely editable until it reaches a run sheet.
  return EDITABLE_STATUSES.includes(status) && runId === null;
}

function toListItem(
  row: RawJob,
  canSeePricing: boolean,
  photoCounts: Map<string, number>,
  certifications: Map<string, Certification>,
): PortalJobListItem {
  const certification = certifications.get(row._id.toHexString());

  return {
    id: row._id.toHexString(),
    jobNumber: row.jobNumber,
    status: row.status,
    siteName: row.siteName,
    suburb: row.suburb,
    poNumber: row.poNumber,
    bookedByName: row.bookedByName,
    readyDate: row.readyDate,
    targetDate: row.targetDate,
    serviceLevel: row.serviceLevel,
    expectedAreaM2: row.expectedAreaM2,
    recoveredWeightKg: row.recoveredWeightKg,
    bagCount: row.bagCount,
    /*
     * ⚠️ Nulled by the SERVER for a site supervisor (M1.5).
     *
     * A role check in the UI still ships the figure to the browser, where it
     * sits in the network tab and in any cached response. What a supervisor
     * must not see, they must not receive.
     */
    totalIncGst: canSeePricing ? fromDecimal128(row.totalIncGst) : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    photoCount: photoCounts.get(row._id.toHexString()) ?? 0,
    editable: isEditable(row.status, row.runId),
    readinessCertifiedAt: certification ? certification.certifiedAt.toISOString() : null,
    readinessCertifiedBy: certification?.certifiedByName ?? null,
  };
}

/* ── Shared reads ────────────────────────────────────────────────────────── */

/** Job ids in scope that carry a certification. One query, not one per row. */
async function certifiedIds(scope: PortalScope): Promise<mongoose.Types.ObjectId[]> {
  const jobIds = (await JobModel.distinct('_id', scoped(scope))) as mongoose.Types.ObjectId[];
  if (jobIds.length === 0) return [];

  return ReadinessCertificationModel.distinct('jobId', { jobId: { $in: jobIds } });
}

/** The most recent certification per job, for a page of rows. */
async function latestCertifications(
  jobIds: mongoose.Types.ObjectId[],
): Promise<Map<string, Certification>> {
  if (jobIds.length === 0) return new Map();

  const rows = await ReadinessCertificationModel.aggregate<Certification & { _id: unknown }>([
    { $match: { jobId: { $in: jobIds } } },
    { $sort: { certifiedAt: -1 } },
    {
      $group: {
        _id: '$jobId',
        jobId: { $first: '$jobId' },
        certifiedAt: { $first: '$certifiedAt' },
        certifiedByName: { $first: '$certifiedByName' },
      },
    },
  ]);

  return new Map(rows.map((row) => [row.jobId.toHexString(), row]));
}

async function countPhotos(jobIds: mongoose.Types.ObjectId[]): Promise<Map<string, number>> {
  if (jobIds.length === 0) return new Map();

  const counts = await JobPhotoModel.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
    { $match: { jobId: { $in: jobIds } } },
    { $group: { _id: '$jobId', count: { $sum: 1 } } },
  ]);

  return new Map(counts.map((row) => [row._id.toHexString(), row.count]));
}

function todayIso(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}

function shiftDays(days: number): string {
  const now = new Date();
  now.setDate(now.getDate() + days);
  return now.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}

function resolveWindow(window: string): { $gte?: string; $lte?: string } | null {
  switch (window) {
    case 'upcoming':
      return { $gte: todayIso() };
    case 'next-7':
      return { $gte: todayIso(), $lte: shiftDays(7) };
    case 'last-30':
      return { $gte: shiftDays(-30), $lte: todayIso() };
    case 'last-90':
      return { $gte: shiftDays(-90), $lte: todayIso() };
    default:
      return null;
  }
}

/* ── M5.10 · invoices ────────────────────────────────────────────────────── */

/**
 * The customer's own invoices.
 *
 * ⚠️ `draft` is deliberately EXCLUDED. A draft is an invoice the office has not
 * sent yet, and showing one to the customer invites a call about a bill that may
 * still change — or worse, a payment against a number that is not final.
 */
export async function listInvoices(
  accountId: string,
  query: {
    page: number;
    pageSize: number;
    status?: string | undefined;
    q?: string | undefined;
  },
): Promise<{ data: PortalInvoice[]; meta: PageMeta }> {
  const filter: Record<string, unknown> = {
    accountId: new mongoose.Types.ObjectId(accountId),
    status: { $in: VISIBLE_INVOICE_STATUSES },
  };

  // A facet may only ever NARROW what is already visible — never widen it to a
  // draft the office has not sent.
  const requested = query.status as PortalInvoice['status'] | undefined;
  if (requested && VISIBLE_INVOICE_STATUSES.includes(requested)) {
    filter.status = requested;
  }

  /*
   * What a customer actually types into this box is an invoice number or
   * their own PO — those are the two strings they hold. The site name is
   * included because a supervisor knows the address and not the number.
   *
   * The site lives on the JOB, so matching it means resolving job ids first:
   * one extra query on a search only, rather than a `$lookup` on every list.
   */
  if (query.q) {
    const term = escapeRegex(query.q);
    const like = { $regex: term, $options: 'i' };
    const digits = Number(query.q.replace(/\D/g, ""));

    const matchingJobs = await JobModel.find(
      { siteName: like },
      { _id: 1 },
    ).lean<Array<{ _id: mongoose.Types.ObjectId }>>();

    filter.$or = [
      { poNumber: like },
      ...(Number.isFinite(digits) && digits > 0 ? [{ invoiceNumber: digits }] : []),
      ...(matchingJobs.length > 0
        ? [{ jobId: { $in: matchingJobs.map((job) => job._id) } }]
        : []),
    ];
  }

  const [rows, total] = await Promise.all([
    InvoiceModel.find(filter)
      .sort({ invoiceNumber: -1 })
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .lean<RawPortalInvoice[]>(),
    InvoiceModel.countDocuments(filter),
  ]);

  // Site names for the page in one query, so a 20-row list is not 21 round trips.
  const jobIds = rows
    .map((row) => row.jobId)
    .filter((id): id is mongoose.Types.ObjectId => id !== null);

  const jobs = await JobModel.find({ _id: { $in: jobIds } }, { siteName: 1 }).lean<
    Array<{ _id: mongoose.Types.ObjectId; siteName: string }>
  >();
  const siteByJob = new Map(jobs.map((job) => [job._id.toHexString(), job.siteName]));

  return {
    data: rows.map(
      (row): PortalInvoice => ({
        id: row._id.toHexString(),
        invoiceNumber: row.invoiceNumber,
        kind: row.kind,
        status: row.status as PortalInvoice['status'],
        jobId: row.jobId ? row.jobId.toHexString() : null,
        jobNumber: row.jobNumber,
        siteName: row.jobId ? (siteByJob.get(row.jobId.toHexString()) ?? null) : null,
        poNumber: row.poNumber,
        issuedOn: row.issuedOn,
        dueOn: row.dueOn,
        subtotalExGst: fromDecimal128(row.subtotalExGst),
        gst: fromDecimal128(row.gst),
        totalIncGst: fromDecimal128(row.totalIncGst),
        paidAt: row.paidAt ? row.paidAt.toISOString() : null,
      }),
    ),
    meta: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    },
  };
}

/** Which of these invoices belong to this account — the PDF request's gate. */
export async function ownedInvoiceIds(
  accountId: string,
  ids: readonly string[],
): Promise<string[]> {
  const objectIds = ids
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  if (objectIds.length === 0) return [];

  const rows = await InvoiceModel.find(
    {
      _id: { $in: objectIds },
      accountId: new mongoose.Types.ObjectId(accountId),
      status: { $in: VISIBLE_INVOICE_STATUSES },
    },
    { _id: 1 },
  ).lean<Array<{ _id: mongoose.Types.ObjectId }>>();

  return rows.map((row) => row._id.toHexString());
}

/**
 * Escapes a user-typed search term before it becomes a regex.
 *
 * Local, matching `queue.repository` and `vehicle.repository`, which each keep
 * their own. Without it a customer typing `(` in the search box sends an
 * invalid expression to Mongo and the list 500s.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
