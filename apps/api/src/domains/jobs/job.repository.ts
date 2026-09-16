import type {
  AppliedRate,
  MapPin,
  RunSheetStop,
  BrandId,
  ChargeCode,
  ExceptionReason,
  FreightItem,
  Job,
  JobCharge,
  JobComment,
  JobDocument,
  JobEvent,
  JobListItem,
  JobPhoto,
  JobStatus,
  LocationSource,
  PageMeta,
  ServiceLevel,
  WeightBasis,
  Zone,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { UNKNOWN_ZONE_LABEL, toObjectId, zoneLabels } from '../settings/zone-lookup.js';
import { fromDecimal128, toDecimal128 } from '../../lib/money.js';
import {
  JobChargeModel,
  JobCommentModel,
  JobDocumentModel,
  JobEventModel,
  JobModel,
  JobPhotoModel,
  JobPreStartModel,
  JobRiskAssessmentModel,
} from './job.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 *
 * ── Where the access boundary is enforced ─────────────────────────────────
 * Every read takes a `JobScope` and folds it into the FILTER, not into a
 * post-fetch `.filter()`. A row a caller may not see is never loaded, so it
 * cannot leak through a count, a total, a sort or a stack trace — and a filter
 * applied in a controller is one somebody can forget.
 */

export interface JobScope {
  /** Non-null narrows every read to one account. */
  accountId: string | null;
  /**
   * Non-null narrows further, to the jobs this person raised.
   *
   * ⚠️ A site supervisor's whole boundary. Until sites were removed they were
   * scoped by assigned sites (M1.5); with no site records the boundary is "the
   * jobs I booked". See `bookedByUserId` on the model.
   */
  bookedByUserId: string | null;
  /** Non-null narrows to one driver's own work — the driver app's only view. */
  driverId: string | null;
}

export interface ListJobsQuery {
  page: number;
  pageSize: number;
  sort?: string | undefined;
  q?: string | undefined;
  status?: JobStatus | undefined;
  account?: string | undefined;
  builder?: string | undefined;
  driver?: string | undefined;
  zoneId?: Zone | undefined;
  invoiceStatus?: Job['invoiceStatus'] | undefined;
  serviceLevel?: ServiceLevel | undefined;
  readyWindow?: string | undefined;
  risk?: string | undefined;
}

/** The projection M8.3's reminder sweep reads. See `dueForReadinessReminder`. */
export interface ReminderJob {
  id: string;
  jobNumber: number;
  accountId: string;
  accountName: string;
  siteName: string;
  targetDate: string;
  siteContactEmail: string | null;
  siteContactMobile: string | null;
}

export interface CreateJobInput {
  jobNumber: number;
  accountId: string;
  accountName: string;
  brandId: BrandId;
  builderName: string;
  siteName: string;
  lotNumber: string | null;
  addressLine: string;
  suburb: string;
  postcode: string;
  zoneId: Zone;
  latitude: number;
  longitude: number;
  /** I3 — whether the pin is the site itself or the middle of the suburb. */
  locationSource: LocationSource;
  accessNotes: string;
  gateHours: string | null;
  inductionRequired: boolean;
  craneAvailable: boolean;
  siteContactName: string | null;
  siteContactMobile: string | null;
  siteContactEmail: string | null;
  poNumber: string | null;
  /** M2.12 — the confirmed order this job fulfils. See the note on the model. */
  purchaseOrderId: string | null;
  bookedByName: string | null;
  bookedByUserId: string | null;
  bookedBySource: 'portal' | 'office' | 'call-up';
  readyDate: string;
  targetDate: string;
  serviceLevel: ServiceLevel;
  freightItem: FreightItem;
  expectedAreaM2: number | null;
  bagCount: number;
  notes: string;
  totalExGst: string;
  gst: string;
  totalIncGst: string;
  /** M6.2 — the rates as applied, frozen so nothing can reprice this job. */
  appliedRate: AppliedRate;
  riskAssessmentRequired: boolean;
}

export interface AppendEventInput {
  jobId: string;
  label: string;
  actor: string;
  status?: JobStatus | null;
  detail?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface CreateCommentInput {
  jobId: string;
  body: string;
  author: string;
  authorId: string | null;
  visibility: JobComment['visibility'];
  deliveredAt: Date | null;
  fromDriver: boolean;
}

/* ── Raw document shapes ─────────────────────────────────────────────────── */

interface RawJob {
  _id: mongoose.Types.ObjectId;
  jobNumber: number;
  status: JobStatus;
  accountId: mongoose.Types.ObjectId;
  accountName: string;
  brandId: BrandId;
  builderName: string;
  siteName: string;
  lotNumber: string | null;
  addressLine: string;
  suburb: string;
  postcode: string;
  zoneId: mongoose.Types.ObjectId;
  latitude: number;
  longitude: number;
  locationSource: LocationSource;
  accessNotes: string;
  gateHours: string | null;
  inductionRequired: boolean;
  craneAvailable: boolean;
  siteContactName: string | null;
  siteContactMobile: string | null;
  siteContactEmail: string | null;
  poNumber: string | null;
  bookedByName: string | null;
  bookedByUserId: mongoose.Types.ObjectId | null;
  bookedBySource: 'portal' | 'office' | 'call-up' | null;
  readyDate: string;
  targetDate: string;
  serviceLevel: ServiceLevel;
  driverId: mongoose.Types.ObjectId | null;
  driverName: string | null;
  expectedAreaM2: number | null;
  recoveredWeightKg: number | null;
  recoveredWeightBasis: WeightBasis | null;
  bagCount: number;
  collectedBagCount: number | null;
  freightItem: FreightItem;
  totalExGst: mongoose.Types.Decimal128;
  gst: mongoose.Types.Decimal128;
  totalIncGst: mongoose.Types.Decimal128;
  invoiceStatus: Job['invoiceStatus'];
  invoiceNumber: number | null;
  invoicedAt: Date | null;
  notes: string;
  exceptionReason: ExceptionReason | null;
  exceptionNote: string | null;
  arrivedAt: Date | null;
  onSiteMinutes: number | null;
  completedAt: Date | null;
  riskAssessmentRequired: boolean;
  createdAt: Date;
}

/**
 * Sort fields a caller may name.
 *
 * An allow-list, not a pass-through: `sort` arrives from a querystring, and
 * handing an arbitrary string to Mongo lets a caller sort by any field in the
 * document — including ones a projection deliberately withholds.
 */
const SORTABLE: Record<string, string> = {
  jobNumber: 'jobNumber',
  accountName: 'accountName',
  siteName: 'siteName',
  suburb: 'suburb',
  status: 'status',
  readyDate: 'readyDate',
  targetDate: 'targetDate',
  driverName: 'driverName',
  expectedAreaM2: 'expectedAreaM2',
  totalExGst: 'totalExGst',
  createdAt: 'createdAt',
};

/** Statuses that are still in play — the office's working set. */
const OPEN_STATUSES: JobStatus[] = ['booked', 'assigned', 'in-transit', 'arrived'];

interface JobFilter {
  _id?: mongoose.Types.ObjectId;
  accountId?: mongoose.Types.ObjectId;
  bookedByUserId?: mongoose.Types.ObjectId;
  driverId?: mongoose.Types.ObjectId | null;
  status?: JobStatus | { $in: JobStatus[] };
  builderName?: string;
  zoneId?: mongoose.Types.ObjectId;
  invoiceStatus?: Job['invoiceStatus'];
  serviceLevel?: ServiceLevel;
  readyDate?: { $gte?: string; $lte?: string };
  targetDate?: { $lt: string };
  /** An exact job-number search. See the note in `buildFilter`. */
  jobNumber?: number;
  $text?: { $search: string };
}

export const jobRepository = {
  /**
   * The jobs grid — the screen the office lives in.
   *
   * Deliberately renders from the job document alone: `JobListItem` is flat, so
   * a page of 20 rows is one query and one count, never a join per row.
   */
  async list(
    query: ListJobsQuery,
    scope: JobScope,
  ): Promise<{ data: JobListItem[]; meta: PageMeta }> {
    const filter = buildFilter(query, scope);

    const sortKey = query.sort?.replace(/^-/, '') ?? '';
    // Typed as the literal union rather than `number`, so the sort object below
    // needs no assertion to satisfy it.
    const direction: 1 | -1 = query.sort?.startsWith('-') ? -1 : 1;
    const sortField = SORTABLE[sortKey];

    /*
     * A text search orders by relevance unless the caller asked otherwise.
     * Otherwise: newest job first, because the office works from the top of the
     * list. Mongo's natural order is not an order anyone can predict.
     *
     * ⚠️ Keyed off whether `$text` is ACTUALLY in the filter, not off whether a
     * search term was supplied. A numeric term is matched against `jobNumber`
     * instead (see `buildFilter`), and asking Mongo for `textScore` with no
     * `$text` query is an error — so keying this off `query.q` would make every
     * search-by-job-number fail outright.
     */
    const relevance = '$text' in filter;

    const sort: Record<string, 1 | -1 | { $meta: 'textScore' }> = sortField
      ? { [sortField]: direction }
      : relevance
        ? { score: { $meta: 'textScore' } }
        : { jobNumber: -1 };

    const projection = relevance && !sortField ? { score: { $meta: 'textScore' } } : {};

    const [rows, total] = await Promise.all([
      JobModel.find(filter, projection)
        .sort(sort)
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean<RawJob[]>(),
      JobModel.countDocuments(filter),
    ]);

    /*
     * `hasPendingCharges` is on the grid contract and lives in another
     * collection. Resolved for the WHOLE PAGE in one query rather than one per
     * row — the classic N+1 that makes a 20-row grid issue 21 queries.
     */
    /*
     * The zone NAMES, for the whole page at once.
     *
     * ⚠️ The grid shows the zone's CURRENT name, unlike an invoice line, which
     * froze its own text when the job was priced. Renaming a zone should move
     * every row of this grid and no figure on any invoice — which is exactly
     * the split between this join and `appliedRate.zoneLabel`.
     */
    const [pending, zones] = await Promise.all([
      jobIdsWithPendingCharges(rows.map((row) => row._id)),
      zoneLabels(),
    ]);

    return {
      data: rows.map((row) => toListItem(row, pending.has(row._id.toHexString()), zones)),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  },

  /**
   * One job with everything hanging off it.
   *
   * Null when it does not exist OR is out of scope — the service turns both into
   * the same 404, because a 403 would confirm the job exists.
   */
  async findById(id: string, scope: JobScope): Promise<Job | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    // Scoping applied to the QUERY: a customer asking for another account's job
    // gets no document back, rather than a document that is then filtered.
    const filter: JobFilter = { _id: new mongoose.Types.ObjectId(id) };
    applyScope(filter, scope);

    const row = await JobModel.findOne(filter).lean<RawJob>();
    if (!row) return null;

    /*
     * Seven collections, fetched in parallel. In sequence this one screen would
     * be seven round trips deep, and the detail page is opened constantly.
     */
    const [charges, events, photos, documents, comments, preStart, riskAssessment] =
      await Promise.all([
        JobChargeModel.find({ jobId: row._id }).sort({ raisedAt: 1 }).lean(),
        JobEventModel.find({ jobId: row._id }).sort({ at: 1 }).lean(),
        JobPhotoModel.find({ jobId: row._id }).sort({ takenAt: 1 }).lean(),
        JobDocumentModel.find({ jobId: row._id }).sort({ uploadedAt: 1 }).lean(),
        JobCommentModel.find({ jobId: row._id }).sort({ at: 1 }).lean(),
        JobPreStartModel.findOne({ jobId: row._id }).lean(),
        JobRiskAssessmentModel.findOne({ jobId: row._id }).lean(),
      ]);

    return {
      ...toListItem(
        row,
        charges.some((charge) => charge.approvalState === 'pending'),
        await zoneLabels(),
      ),
      freightItem: row.freightItem,
      notes: row.notes,
      exceptionReason: row.exceptionReason,
      exceptionNote: row.exceptionNote,
      arrivedAt: row.arrivedAt ? row.arrivedAt.toISOString() : null,
      onSiteMinutes: row.onSiteMinutes,
      charges: charges.map(
        (charge): JobCharge => ({
          id: charge._id.toHexString(),
          code: charge.code,
          description: charge.description,
          quantity: charge.quantity,
          unitRate: fromDecimal128(charge.unitRate),
          amount: fromDecimal128(charge.amount),
          source: charge.source,
          approvalState: charge.approvalState,
          raisedBy: charge.raisedBy ?? null,
          raisedAt: charge.raisedAt.toISOString(),
          photoCount: charge.photoCount,
          note: charge.note ?? null,
          decidedBy: charge.decidedBy ?? null,
          decidedAt: charge.decidedAt ? charge.decidedAt.toISOString() : null,
          decisionNote: charge.decisionNote ?? null,
        }),
      ),
      events: events.map(
        (event): JobEvent => ({
          id: event._id.toHexString(),
          at: event.at.toISOString(),
          label: event.label,
          actor: event.actor ?? '',
          status: event.status ?? null,
          detail: event.detail ?? null,
          latitude: event.latitude ?? null,
          longitude: event.longitude ?? null,
        }),
      ),
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
      documents: documents.map(
        (document): JobDocument => ({
          id: document._id.toHexString(),
          name: document.name,
          kind: document.kind,
          uploadedAt: document.uploadedAt.toISOString(),
          uploadedBy: document.uploadedBy ?? '',
          sizeKb: document.sizeKb,
        }),
      ),
      comments: comments.map(toComment),
      invoiceNumber: row.invoiceNumber,
      invoicedAt: row.invoicedAt ? row.invoicedAt.toISOString() : null,
      gst: fromDecimal128(row.gst),
      totalIncGst: fromDecimal128(row.totalIncGst),
      compliance: {
        // The rule as it was AT CREATION, read off the job — never re-derived
        // from the account, which would let a settings change rewrite history.
        riskAssessmentRequired: row.riskAssessmentRequired,
        preStart: preStart
          ? {
              completedAt: preStart.completedAt.toISOString(),
              driverName: preStart.driverName,
              vehicleRego: preStart.vehicleRego ?? '',
              odometerKm: preStart.odometerKm,
              failedItems: preStart.failedItems.map((item) => ({
                key: item.key,
                label: item.label,
                note: item.note ?? '',
              })),
              itemsChecked: preStart.itemsChecked,
            }
          : null,
        riskAssessment: riskAssessment
          ? {
              completedAt: riskAssessment.completedAt.toISOString(),
              driverName: riskAssessment.driverName,
              hazards: riskAssessment.hazards,
              controls: riskAssessment.controls,
              note: riskAssessment.note ?? '',
              safeToProceed: riskAssessment.safeToProceed,
              swmsVersion: riskAssessment.swmsVersion,
              builderPortalCode: riskAssessment.builderPortalCode ?? null,
              uploadState: riskAssessment.uploadState,
              // The PDF is filed as a job document; null while it is being made.
              document: null,
            }
          : null,
      },
    };
  },

  /** The status and driver of one job, without loading its whole history. */
  /**
   * M8.3 — the jobs a readiness reminder is worth sending about.
   *
   * ── Why only `booked` and `assigned` ──────────────────────────────────────
   * Everything further along has already left the depot: a truck in transit
   * cannot be stood down by a supervisor tapping a link, and asking whether the
   * site is ready while the driver is at the gate is worse than silence.
   *
   * ⚠️ Reads only the fields a message needs. The reminder runs over every site
   * booked for tomorrow, and assembling a full job — charges, events, photos,
   * comments — for each of them would be a page of joins to produce one line of
   * text.
   */
  async dueForReadinessReminder(targetDate: string): Promise<ReminderJob[]> {
    const rows = await JobModel.find(
      { targetDate, status: { $in: ['booked', 'assigned'] } },
      {
        jobNumber: 1,
        accountId: 1,
        accountName: 1,
        siteName: 1,
        targetDate: 1,
        siteContactEmail: 1,
        siteContactMobile: 1,
      },
    )
      .sort({ siteName: 1 })
      .lean<
        Array<{
          _id: mongoose.Types.ObjectId;
          jobNumber: number;
          accountId: mongoose.Types.ObjectId;
          accountName: string;
          siteName: string;
          targetDate: string;
          siteContactEmail: string | null;
          siteContactMobile: string | null;
        }>
      >();

    return rows.map((row) => ({
      id: row._id.toHexString(),
      jobNumber: row.jobNumber,
      accountId: row.accountId.toHexString(),
      accountName: row.accountName,
      siteName: row.siteName,
      targetDate: row.targetDate,
      siteContactEmail: row.siteContactEmail,
      siteContactMobile: row.siteContactMobile,
    }));
  },

  async findSummary(
    id: string,
    scope: JobScope,
  ): Promise<{ id: string; jobNumber: number; status: JobStatus; driverId: string | null } | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    const filter: JobFilter = { _id: new mongoose.Types.ObjectId(id) };
    applyScope(filter, scope);

    const row = await JobModel.findOne(filter, {
      jobNumber: 1,
      status: 1,
      driverId: 1,
    }).lean<Pick<RawJob, '_id' | 'jobNumber' | 'status' | 'driverId'>>();

    if (!row) return null;

    return {
      id: row._id.toHexString(),
      jobNumber: row.jobNumber,
      status: row.status,
      driverId: row.driverId ? row.driverId.toHexString() : null,
    };
  },

  async create(input: CreateJobInput): Promise<JobListItem> {
    const created = await JobModel.create({
      jobNumber: input.jobNumber,
      status: 'booked',
      accountId: new mongoose.Types.ObjectId(input.accountId),
      accountName: input.accountName,
      brandId: input.brandId,
      builderName: input.builderName,
      siteName: input.siteName,
      lotNumber: input.lotNumber,
      addressLine: input.addressLine,
      suburb: input.suburb,
      postcode: input.postcode,
      zoneId: new mongoose.Types.ObjectId(input.zoneId),
      latitude: input.latitude,
      longitude: input.longitude,
      locationSource: input.locationSource,
      accessNotes: input.accessNotes,
      gateHours: input.gateHours,
      inductionRequired: input.inductionRequired,
      craneAvailable: input.craneAvailable,
      siteContactName: input.siteContactName,
      siteContactMobile: input.siteContactMobile,
      siteContactEmail: input.siteContactEmail,
      poNumber: input.poNumber,
      purchaseOrderId: input.purchaseOrderId
        ? new mongoose.Types.ObjectId(input.purchaseOrderId)
        : null,
      bookedByName: input.bookedByName,
      bookedByUserId: input.bookedByUserId
        ? new mongoose.Types.ObjectId(input.bookedByUserId)
        : null,
      bookedBySource: input.bookedBySource,
      readyDate: input.readyDate,
      targetDate: input.targetDate,
      serviceLevel: input.serviceLevel,
      driverId: null,
      driverName: null,
      expectedAreaM2: input.expectedAreaM2,
      recoveredWeightKg: null,
      // Nothing has been collected yet, so there is no weight and therefore no
      // basis. Null rather than a default: "estimated" on a job that has not
      // happened is a claim about a measurement nobody has taken.
      recoveredWeightBasis: null,
      bagCount: input.bagCount,
      freightItem: input.freightItem,
      totalExGst: toDecimal128(input.totalExGst),
      gst: toDecimal128(input.gst),
      totalIncGst: toDecimal128(input.totalIncGst),
      /*
       * Both rates converted to `Decimal128` here rather than stored as the
       * strings they arrive as (§6A.10 #1). A rate that round-trips through a
       * string is a rate that can be compared with `>` and get the wrong
       * answer, and these are the figures a credit note is derived from.
       */
      appliedRate: {
        rateCardId: input.appliedRate.rateCardId,
        rateCardLabel: input.appliedRate.rateCardLabel,
        zoneId: new mongoose.Types.ObjectId(input.appliedRate.zoneId),
        zoneLabel: input.appliedRate.zoneLabel,
        scheduleFrom: input.appliedRate.scheduleFrom,
        serviceCharge: toDecimal128(input.appliedRate.serviceCharge),
        ratePerM2: toDecimal128(input.appliedRate.ratePerM2),
      },
      invoiceStatus: 'not-invoiced',
      notes: input.notes,
      riskAssessmentRequired: input.riskAssessmentRequired,
    });

    const row = created.toObject() as unknown as RawJob;
    return toListItem(row, false, await zoneLabels());
  },

  /** Removes a job and everything keyed to it. Compensation for a failed create. */
  async deleteCascade(jobId: string): Promise<void> {
    if (!mongoose.isValidObjectId(jobId)) return;
    const _id = new mongoose.Types.ObjectId(jobId);

    await Promise.all([
      JobModel.deleteOne({ _id }),
      JobChargeModel.deleteMany({ jobId: _id }),
      JobEventModel.deleteMany({ jobId: _id }),
      JobPhotoModel.deleteMany({ jobId: _id }),
      JobDocumentModel.deleteMany({ jobId: _id }),
      JobCommentModel.deleteMany({ jobId: _id }),
      JobPreStartModel.deleteMany({ jobId: _id }),
      JobRiskAssessmentModel.deleteMany({ jobId: _id }),
    ]);
  },

  async appendEvent(input: AppendEventInput): Promise<void> {
    await JobEventModel.create({
      jobId: new mongoose.Types.ObjectId(input.jobId),
      at: new Date(),
      label: input.label,
      actor: input.actor,
      status: input.status ?? null,
      detail: input.detail ?? null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
    });
  },

  /**
   * M2.4 — cancel with a structured reason.
   *
   * The status is part of the FILTER, not just the update: two people cancelling
   * the same job at once, or a cancel racing a completion, must not both win.
   * Returns false when nothing matched, which the service reads as "the job
   * moved underneath you".
   */
  async cancel(
    id: string,
    reason: ExceptionReason,
    note: string | null,
    cancellableFrom: JobStatus[],
  ): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;

    const result = await JobModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id), status: { $in: cancellableFrom } },
      {
        $set: {
          status: 'cancelled',
          exceptionReason: reason,
          exceptionNote: note,
          /*
           * M2.12 — cancelling RELEASES the purchase order.
           *
           * The pickup did not happen and nothing was invoiced, so the
           * builder's order is still live and must be bookable again. Leaving
           * the reference in place would trip `purchase_order_unique` and
           * strand a real order behind a cancelled job.
           *
           * ⚠️ The audit trail survives regardless: `poNumber` is a frozen copy
           * on this job and is deliberately not cleared, so the cancelled job
           * still says which order it was against. Only the live link goes.
           */
          purchaseOrderId: null,
        },
      },
    );

    return result.matchedCount === 1;
  },

  /**
   * Moves the ready date, and returns THE DATES IT REPLACED.
   *
   * ⚠️ The before-values come back from the update itself rather than from a
   * read beforehand, because M1.6's worked example is exactly this operation —
   * *"who changed job 61402's ready date from 12 Aug to 19 Aug?"* — and a `from`
   * read in a separate query is a `from` that another writer can invalidate in
   * between. An audit entry recording a value that was never replaced is worse
   * than no entry: it is evidence that happens to be wrong.
   */
  async reschedule(
    id: string,
    readyDate: string,
    targetDate: string,
  ): Promise<{ readyDate: string; targetDate: string; accountName: string } | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    const previous = await JobModel.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { readyDate, targetDate } },
      {
        returnDocument: 'before',
        projection: { readyDate: 1, targetDate: 1, accountName: 1 },
      },
    ).lean<{ readyDate: string; targetDate: string; accountName: string }>();

    return previous;
  },

  async addComment(input: CreateCommentInput): Promise<JobComment> {
    const created = await JobCommentModel.create({
      jobId: new mongoose.Types.ObjectId(input.jobId),
      body: input.body,
      author: input.author,
      authorId: input.authorId ? new mongoose.Types.ObjectId(input.authorId) : null,
      at: new Date(),
      visibility: input.visibility,
      deliveredAt: input.deliveredAt,
      fromDriver: input.fromDriver,
    });

    return toComment(created.toObject());
  },

  /**
   * M3.2 — the stops on one run, as the driver's sheet needs them.
   *
   * Every field here exists because a driver standing at a gate needs it: the
   * lot number because street numbers do not exist yet in greenfield estates,
   * the contact to tap-to-call when the gate is shut, the expected m² so they
   * know what they are collecting before they open the truck.
   */
  async runSheetStops(runId: string): Promise<RunSheetStop[]> {
    if (!mongoose.isValidObjectId(runId)) return [];

    const [rows, zones] = await Promise.all([
      JobModel.find({ runId: new mongoose.Types.ObjectId(runId) })
        .sort({ runSequence: 1 })
        .lean<Array<RawJob & { runSequence: number | null }>>(),
      zoneLabels(),
    ]);

    return rows.map((row, index) => ({
      id: row._id.toHexString(),
      // Falls back to the position in the sorted list, so a sheet is never
      // handed to a driver with a blank or duplicated stop number.
      sequence: row.runSequence ?? index + 1,
      jobNumber: row.jobNumber,
      status: row.status,
      accountName: row.accountName,
      builderName: row.builderName,
      siteName: row.siteName,
      lotNumber: row.lotNumber ?? null,
      addressLine: row.addressLine,
      suburb: row.suburb,
      zoneId: row.zoneId.toString(),
      zoneLabel: zones.get(row.zoneId.toString()) ?? UNKNOWN_ZONE_LABEL,
      poNumber: row.poNumber ?? null,
      contactName: row.siteContactName ?? null,
      contactMobile: row.siteContactMobile ?? null,
      expectedAreaM2: row.expectedAreaM2,
      bagCount: row.bagCount,
      accessNotes: row.accessNotes,
      craneAvailable: row.craneAvailable,
      inductionRequired: row.inductionRequired,
      serviceLevel: row.serviceLevel,
      latitude: row.latitude,
      longitude: row.longitude,
    }));
  },

  /**
   * M3.3 — pins for one date. Visual clustering, NOT a routing result.
   *
   * Every open job for the day, allocated or not: the map's job is to show the
   * allocator that four unallocated stops are sitting in the same street as a
   * run that already exists.
   *
   * `runName` is left null here and filled in by the dispatch service. This
   * repository must not read the runs collection — jobs know their run's id,
   * which is a reference; reaching into another domain's storage to resolve it
   * is the coupling the layering exists to prevent.
   */
  async mapPins(date: string): Promise<MapPin[]> {
    const rows = await JobModel.find({
      readyDate: { $lte: date },
      status: { $in: OPEN_STATUSES },
    }).lean<Array<RawJob & { runId: mongoose.Types.ObjectId | null }>>();

    const zones = await zoneLabels();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

    return rows.map((row) => ({
      id: row._id.toHexString(),
      jobNumber: row.jobNumber,
      latitude: row.latitude,
      longitude: row.longitude,
      status: row.status,
      accountName: row.accountName,
      siteName: row.siteName,
      suburb: row.suburb,
      zoneId: row.zoneId.toString(),
      zoneLabel: zones.get(row.zoneId.toString()) ?? UNKNOWN_ZONE_LABEL,
      driverName: row.driverName ?? null,
      runId: row.runId ? row.runId.toHexString() : null,
      runName: null,
      serviceLevel: row.serviceLevel,
      atRisk: row.targetDate < today,
    }));
  },

  /** Distinct builder names actually recorded on jobs, for the filter dropdown. */
  async builderNames(): Promise<string[]> {
    const names = await JobModel.distinct('builderName', { builderName: { $nin: ['', '—'] } });
    return names.sort((a, b) => a.localeCompare(b));
  },
};

/* ── Mapping ─────────────────────────────────────────────────────────────── */

function toListItem(
  row: RawJob,
  hasPendingCharges: boolean,
  zones: ReadonlyMap<string, string>,
): JobListItem {
  return {
    id: row._id.toHexString(),
    jobNumber: row.jobNumber,
    status: row.status,
    brandId: row.brandId,
    accountId: row.accountId.toHexString(),
    accountName: row.accountName,
    builderName: row.builderName,
    siteName: row.siteName,
    lotNumber: row.lotNumber ?? null,
    addressLine: row.addressLine,
    suburb: row.suburb,
    postcode: row.postcode,
    zoneId: row.zoneId.toString(),
    zoneLabel: zones.get(row.zoneId.toString()) ?? UNKNOWN_ZONE_LABEL,
    latitude: row.latitude,
    longitude: row.longitude,
    accessNotes: row.accessNotes,
    gateHours: row.gateHours ?? null,
    inductionRequired: row.inductionRequired,
    craneAvailable: row.craneAvailable,
    siteContactName: row.siteContactName ?? null,
    siteContactMobile: row.siteContactMobile ?? null,
    siteContactEmail: row.siteContactEmail ?? null,
    poNumber: row.poNumber ?? null,
    bookedByName: row.bookedByName ?? null,
    bookedByUserId: row.bookedByUserId ? row.bookedByUserId.toHexString() : null,
    bookedBySource: row.bookedBySource ?? null,
    readyDate: row.readyDate,
    targetDate: row.targetDate,
    serviceLevel: row.serviceLevel,
    driverId: row.driverId ? row.driverId.toHexString() : null,
    driverName: row.driverName ?? null,
    // Null, not zero. See the warning on the model.
    expectedAreaM2: row.expectedAreaM2,
    recoveredWeightKg: row.recoveredWeightKg,
    recoveredWeightBasis: row.recoveredWeightBasis,
    // The order's allowance and the driver's count, kept apart — the gap
    // between them is what gets charged separately (Matt, 08:28).
    bagCount: row.bagCount,
    collectedBagCount: row.collectedBagCount ?? null,
    totalExGst: fromDecimal128(row.totalExGst),
    invoiceStatus: row.invoiceStatus,
    hasPendingCharges,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

interface RawComment {
  _id: mongoose.Types.ObjectId;
  body: string;
  author: string;
  at: Date;
  visibility: JobComment['visibility'];
  deliveredAt?: Date | null | undefined;
  fromDriver: boolean;
}

function toComment(row: RawComment): JobComment {
  return {
    id: row._id.toHexString(),
    body: row.body,
    author: row.author,
    at: row.at.toISOString(),
    visibility: row.visibility,
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    fromDriver: row.fromDriver,
  };
}

/* ── Filtering ───────────────────────────────────────────────────────────── */

/**
 * Folds the caller's scope into a filter.
 *
 * ⚠️ Assigns to distinct keys and is applied LAST, so a facet cannot overwrite
 * it. `account` below is deliberately ignored when a scope pins the account —
 * a customer nominating another account's id must not widen their own view.
 */
function applyScope(filter: JobFilter, scope: JobScope): void {
  if (scope.accountId !== null) {
    filter.accountId = new mongoose.Types.ObjectId(scope.accountId);
  }
  if (scope.bookedByUserId !== null) {
    filter.bookedByUserId = new mongoose.Types.ObjectId(scope.bookedByUserId);
  }
  if (scope.driverId !== null) {
    filter.driverId = new mongoose.Types.ObjectId(scope.driverId);
  }
}

function buildFilter(query: ListJobsQuery, scope: JobScope): JobFilter {
  const filter: JobFilter = {};

  /*
   * ⚠️ A NUMBER is a job number, not a text search.
   *
   * The text index covers the site, the account, the builder, the suburb and
   * the customer's PO — but `jobNumber` is numeric, and MongoDB's text index
   * cannot index a number at all. So typing "61402" into the grid used to
   * return nothing, which is the single most common search the office runs:
   * the number is on every run sheet and every invoice, and it is what gets
   * quoted down the phone.
   *
   * Digits are therefore matched EXACTLY against the number, using its unique
   * index. A `#` prefix is stripped because people type the number the way it
   * is printed.
   */
  if (query.q) {
    const term = query.q.trim().replace(/^#/, '');

    if (/^\d+$/.test(term)) {
      filter.jobNumber = Number(term);
    } else {
      filter.$text = { $search: query.q };
    }
  }
  if (query.status) filter.status = query.status;
  if (query.builder) filter.builderName = query.builder;
  /*
   * ⚠️ Silently dropped when it is not an id at all, rather than 422'd.
   *
   * The grid's zone filter is in the URL, so a bookmark taken before zones
   * became records carries `?zoneId=sydney`. Refusing it would break the
   * bookmark with a validation error about a field the person never typed;
   * ignoring it shows the unfiltered grid, which is what they can see and act
   * on.
   */
  const zoneFilter = query.zoneId ? toObjectId(query.zoneId) : null;
  if (zoneFilter) filter.zoneId = zoneFilter;
  if (query.invoiceStatus) filter.invoiceStatus = query.invoiceStatus;
  if (query.serviceLevel) filter.serviceLevel = query.serviceLevel;

  if (query.account && mongoose.isValidObjectId(query.account)) {
    filter.accountId = new mongoose.Types.ObjectId(query.account);
  }

  /*
   * `unallocated` is a real answer, not a missing filter: it is the first column
   * of the dispatch board and the question the office asks every morning.
   */
  if (query.driver === 'unallocated') {
    filter.driverId = null;
  } else if (query.driver && mongoose.isValidObjectId(query.driver)) {
    filter.driverId = new mongoose.Types.ObjectId(query.driver);
  }

  if (query.readyWindow) {
    const window = resolveWindow(query.readyWindow);
    if (window) filter.readyDate = window;
  }

  /*
   * "At risk" is a job still open whose target date has passed — the SLA breach
   * the office is chasing (M2.4a). Expressed against stored fields so it stays a
   * query rather than a scan.
   */
  if (query.risk === 'at-risk') {
    filter.status = { $in: OPEN_STATUSES };
    filter.targetDate = { $lt: today() };
  }

  // LAST, so nothing above can widen it.
  applyScope(filter, scope);

  return filter;
}

/** Today in the business's own timezone, as `YYYY-MM-DD`. */
function today(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}

function shiftDays(days: number): string {
  const now = new Date();
  now.setDate(now.getDate() + days);
  return now.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}

/**
 * Relative date windows, matching how the office phrases a filter — "the next
 * three days", "this month". A single token rather than a pair of dates,
 * because that is the question being asked.
 */
function resolveWindow(window: string): { $gte?: string; $lte?: string } | null {
  switch (window) {
    case 'overdue':
      return { $lte: shiftDays(-1) };
    case 'today':
      return { $gte: today(), $lte: today() };
    case 'next-3':
      return { $gte: today(), $lte: shiftDays(3) };
    case 'next-7':
      return { $gte: today(), $lte: shiftDays(7) };
    case 'last-7':
      return { $gte: shiftDays(-7), $lte: today() };
    case 'last-30':
      return { $gte: shiftDays(-30), $lte: today() };
    default:
      return null;
  }
}

/**
 * Which of these jobs have a charge awaiting approval (M2.7).
 *
 * One query for the whole page. `distinct` rather than a group: the answer is a
 * set membership test, and the charge rows themselves are not wanted here.
 */
async function jobIdsWithPendingCharges(ids: mongoose.Types.ObjectId[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();

  const jobIds = await JobChargeModel.distinct('jobId', {
    jobId: { $in: ids },
    approvalState: 'pending',
  });

  return new Set(jobIds.map((id) => id.toHexString()));
}

/**
 * Writes the priced lines of a job as its own charge rows.
 *
 * ── Why the quote is persisted as charges rather than recomputed later ────
 * Because the invoice has to reproduce what the customer was quoted, to the
 * cent (Risk 1). Rates are effective-dated (M6.2) — a job is priced by the date
 * it RAN — so re-running the quote at invoice time would silently re-price
 * history the first time somebody edits a rate card. Storing the lines at
 * booking makes the job the single source of truth, and the invoice a straight
 * copy of it.
 *
 * `system` source and `not-required` approval: these are what the price list
 * says, not something anybody raised or has to approve.
 */
/**
 * Which of these purchase orders already have a job against them (M2.12).
 *
 * ── Why the booking form needs this ───────────────────────────────────────
 * Wisdom's order says it in capitals: *"ONE PURCHASE ORDER NUMBER ONLY PER TAX
 * INVOICE."* The unique index on `purchaseOrderId` enforces it, but a database
 * error at the moment somebody submits a booking form is not an explanation —
 * so the picker greys the used ones out and says which job took them.
 *
 * One query for the whole page rather than one per row: the classic N+1 that
 * turns a fifty-order picker into fifty-one queries.
 */
export async function jobsForPurchaseOrders(
  purchaseOrderIds: readonly string[],
): Promise<Map<string, number>> {
  const ids = purchaseOrderIds
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  if (ids.length === 0) return new Map();

  /*
   * No status filter, deliberately. Cancelling NULLS the reference (see
   * `cancel`), so a released order simply does not appear here — one mechanism
   * rather than two that can disagree. A status clause here plus a live
   * reference on the row would grey an order out in the picker while the unique
   * index still refused it, which is the worst of both.
   */
  const rows = await JobModel.find(
    { purchaseOrderId: { $in: ids } },
    { purchaseOrderId: 1, jobNumber: 1 },
  ).lean<Array<{ purchaseOrderId: mongoose.Types.ObjectId; jobNumber: number }>>();

  return new Map(rows.map((row) => [row.purchaseOrderId.toHexString(), row.jobNumber]));
}

export async function writeQuotedCharges(
  jobId: string,
  lines: ReadonlyArray<{
    code: ChargeCode;
    description: string;
    quantity: number;
    unitRate: string;
    amount: string;
  }>,
): Promise<void> {
  if (lines.length === 0) return;

  const _id = new mongoose.Types.ObjectId(jobId);
  const raisedAt = new Date();

  await JobChargeModel.insertMany(
    lines.map((line) => ({
      jobId: _id,
      code: line.code,
      description: line.description,
      quantity: line.quantity,
      unitRate: toDecimal128(line.unitRate),
      amount: toDecimal128(line.amount),
      source: 'system',
      approvalState: 'not-required',
      raisedBy: null,
      raisedAt,
      photoCount: 0,
      note: null,
    })),
  );
}

/**
 * The charges an invoice is built from, split by who raised them.
 *
 * Only APPROVED and `not-required` charges are billable: a `pending` charge is
 * one the office has not yet looked at, and a `rejected` one is a charge they
 * decided not to make. Billing either would be billing a decision nobody took.
 */
export async function billableCharges(jobId: string): Promise<
  Array<{
    id: string;
    code: ChargeCode;
    description: string;
    quantity: number;
    unitRate: string;
    amount: string;
    source: 'office' | 'driver' | 'system';
    raisedBy: string | null;
  }>
> {
  if (!mongoose.isValidObjectId(jobId)) return [];

  const rows = await JobChargeModel.find({
    jobId: new mongoose.Types.ObjectId(jobId),
    approvalState: { $in: ['approved', 'not-required'] },
  })
    .sort({ raisedAt: 1 })
    .lean();

  return rows.map((row) => ({
    id: row._id.toHexString(),
    code: row.code,
    description: row.description,
    quantity: row.quantity,
    unitRate: fromDecimal128(row.unitRate),
    amount: fromDecimal128(row.amount),
    source: row.source,
    raisedBy: row.raisedBy ?? null,
  }));
}

/** Marks a job's invoice rollup, so the jobs grid agrees with the invoice list. */
export async function setInvoiceStatus(
  jobId: string,
  status: 'not-invoiced' | 'awaiting-po' | 'invoiced' | 'paid',
  invoiceNumber?: number,
): Promise<void> {
  if (!mongoose.isValidObjectId(jobId)) return;

  await JobModel.updateOne(
    { _id: new mongoose.Types.ObjectId(jobId) },
    {
      $set: {
        invoiceStatus: status,
        ...(invoiceNumber === undefined
          ? {}
          : { invoiceNumber, invoicedAt: new Date() }),
      },
    },
  );
}
