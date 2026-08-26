import type { Job, JobComment, JobDraft, PricePreview, PricePreviewLine } from '@plastago/shared';
import { ServiceError } from '../service-error';
import type { JobService } from '../types';
import { applyListQuery, byDate, byNumber, byText } from './list-query';
import { ACCOUNTS, BAG_RATE_CENTS, ZONE_RATES, centsToMoney, objectId } from './fixtures/reference';
import { toListItem } from './fixtures/jobs';
import { latency } from './mock-transport';
import { findJob, isAtRisk, jobList, store } from './store';

const ZONE_NAMES = { sydney: 'Sydney', wollongong: 'Wollongong', newcastle: 'Newcastle' } as const;

export function createMockJobService(): JobService {
  return {
    async list(query) {
      await latency();

      return applyListQuery(jobList(), query, {
        search: (job) => [
          job.jobNumber,
          job.accountName,
          job.builderName,
          job.siteName,
          job.suburb,
          job.customerReference,
          job.poNumber,
          job.driverName,
        ],
        filters: {
          status: (job, value) => job.status === value,
          account: (job, value) => job.accountId === value,
          builder: (job, value) => job.builderName === value,
          driver: (job, value) =>
            value === 'unallocated' ? job.driverId === null : job.driverId === value,
          zone: (job, value) => job.zone === value,
          invoiceStatus: (job, value) => job.invoiceStatus === value,
          serviceLevel: (job, value) => job.serviceLevel === value,
          // Date filters are ranges expressed as a single token, because that is
          // how the office asks the question: "the next 3 days", "this month".
          readyWindow: (job, value) => matchesWindow(job.readyDate, value),
          risk: (job, value) => (value === 'at-risk' ? isAtRisk(job) : true),
        },
        sorters: {
          jobNumber: byNumber((job) => job.jobNumber),
          accountName: byText((job) => job.accountName),
          siteName: byText((job) => job.siteName),
          suburb: byText((job) => job.suburb),
          status: byText((job) => job.status),
          readyDate: byDate((job) => job.readyDate),
          targetDate: byDate((job) => job.targetDate),
          driverName: byText((job) => job.driverName),
          expectedAreaM2: byNumber((job) => job.expectedAreaM2),
          totalExGst: byNumber((job) => Number(job.totalExGst)),
        },
        // Newest job first: the office works from the top of the list.
        defaultSort: (a, b) => b.jobNumber - a.jobNumber,
      });
    },

    async get(id) {
      await latency();
      const job = findJob(id);
      if (!job) throw new ServiceError('NOT_FOUND', `No job ${id}`);
      return { ...job };
    },

    /**
     * The estimate the office sees before saving (M2.1).
     *
     * ⚠️ This arithmetic lives in the MOCK, standing in for the server. It is
     * not the pricing engine and must never be moved into a component: the real
     * engine is an effective-dated three-dimensional lookup with per-component
     * overrides that has to match TransVirtual to the cent (Risk 1). The UI's
     * only job is to render whatever comes back.
     */
    async preview(draft: JobDraft) {
      await latency(280, 140);

      const site = store.sites.find((candidate) => candidate.id === draft.siteId);
      if (!site) throw new ServiceError('NOT_FOUND', 'Choose a site before pricing');

      const account = ACCOUNTS.find((candidate) => candidate.id === draft.accountId);
      const rates = ZONE_RATES[site.zone];

      const lines: PricePreviewLine[] = [
        {
          code: 'service-fee',
          description: `Service fee — ${ZONE_NAMES[site.zone]}`,
          quantity: 1,
          unitRate: centsToMoney(rates.serviceCents),
          amount: centsToMoney(rates.serviceCents),
        },
        {
          code: 'area-charge',
          description: 'Weight charge (per m²)',
          quantity: draft.expectedAreaM2,
          unitRate: centsToMoney(rates.perM2Cents),
          amount: centsToMoney(draft.expectedAreaM2 * rates.perM2Cents),
        },
      ];

      if (draft.bagCount > 0) {
        lines.push({
          code: 'recycling-bags',
          description: 'Recycling bags',
          quantity: draft.bagCount,
          unitRate: centsToMoney(BAG_RATE_CENTS),
          amount: centsToMoney(draft.bagCount * BAG_RATE_CENTS),
        });
      }

      if (account?.code === 'WIS001') {
        lines.push({
          code: 'fuel-levy-wisdom',
          description: 'Fuel levy — Wisdom',
          quantity: 1,
          unitRate: centsToMoney(2000),
          amount: centsToMoney(2000),
        });
      }

      const subtotalCents = lines.reduce(
        (sum, line) => sum + Math.round(Number(line.amount) * 100),
        0,
      );
      const gstCents = Math.round(subtotalCents / 10);

      const preview: PricePreview = {
        zone: site.zone,
        rateCardLabel: account ? account.rateCardId : 'default',
        lines,
        subtotalExGst: centsToMoney(subtotalCents),
        gst: centsToMoney(gstCents),
        totalIncGst: centsToMoney(subtotalCents + gstCents),
        caveat:
          draft.expectedAreaM2 === 0
            ? 'Enter the expected m² for a complete estimate — the area charge is the larger part of most jobs.'
            : null,
      };

      return preview;
    },

    async create(draft) {
      await latency(520, 260);

      const site = store.sites.find((candidate) => candidate.id === draft.siteId);
      const account = ACCOUNTS.find((candidate) => candidate.id === draft.accountId);
      if (!site || !account) {
        throw new ServiceError('VALIDATION_FAILED', 'Account and site are required', {
          fieldErrors: { siteId: 'Choose a site' },
        });
      }

      // M1.4 — continue the sequence. Never restart at 1: three years of
      // consignment numbers are quoted in builders' AP systems.
      const nextNumber = Math.max(...store.jobs.map((job) => job.jobNumber)) + 1;
      const rates = ZONE_RATES[site.zone];
      const subtotalCents =
        rates.serviceCents +
        draft.expectedAreaM2 * rates.perM2Cents +
        draft.bagCount * BAG_RATE_CENTS;
      const gstCents = Math.round(subtotalCents / 10);
      const now = new Date().toISOString();

      const job: Job = {
        id: objectId('jb', nextNumber),
        jobNumber: nextNumber,
        status: 'booked',
        brandId: account.brandId,
        accountId: account.id,
        accountName: account.name,
        builderName: site.builderName,
        siteId: site.id,
        siteName: site.name,
        suburb: site.suburb,
        zone: site.zone,
        customerReference: draft.customerReference || null,
        poNumber: draft.poNumber || null,
        readyDate: draft.readyDate,
        targetDate: addBusinessDays(draft.readyDate, 5),
        serviceLevel: draft.serviceLevel,
        driverId: null,
        driverName: null,
        expectedAreaM2: draft.expectedAreaM2,
        recoveredWeightKg: null,
        bagCount: draft.bagCount,
        totalExGst: centsToMoney(subtotalCents),
        invoiceStatus: 'not-invoiced',
        hasPendingCharges: false,
        completedAt: null,
        createdAt: now,
        freightItem: draft.freightItem,
        notes: draft.notes,
        exceptionReason: null,
        exceptionNote: null,
        arrivedAt: null,
        onSiteMinutes: null,
        charges: [],
        events: [
          {
            id: objectId('ev', nextNumber),
            at: now,
            label: 'Job created',
            actor: 'Matthew Browne',
            status: 'booked',
            detail: 'Created in the admin console',
            latitude: null,
            longitude: null,
          },
        ],
        photos: [],
        documents: [],
        comments: [],
        invoiceNumber: null,
        invoicedAt: null,
        gst: centsToMoney(gstCents),
        totalIncGst: centsToMoney(subtotalCents + gstCents),
      };

      store.jobs = [job, ...store.jobs];
      return toListItem(job);
    },

    async cancel(id, reason, note) {
      await latency(420, 200);
      const job = findJob(id);
      if (!job) throw new ServiceError('NOT_FOUND', `No job ${id}`);
      if (job.status === 'completed' || job.status === 'admin-complete') {
        throw new ServiceError('CONFLICT', 'A completed job cannot be cancelled');
      }

      const updated: Job = {
        ...job,
        status: 'cancelled',
        exceptionReason: reason,
        exceptionNote: note || null,
        events: [
          ...job.events,
          {
            id: objectId('ev', job.jobNumber * 100 + job.events.length),
            at: new Date().toISOString(),
            label: 'Job cancelled',
            actor: 'Matthew Browne',
            status: 'cancelled',
            detail: note || null,
            latitude: null,
            longitude: null,
          },
        ],
      };

      store.jobs = store.jobs.map((candidate) => (candidate.id === id ? updated : candidate));
    },

    async reschedule(id, readyDate) {
      await latency(420, 200);
      const job = findJob(id);
      if (!job) throw new ServiceError('NOT_FOUND', `No job ${id}`);

      const updated: Job = {
        ...job,
        readyDate,
        // The SLA clock restarts from the customer's new ready date (M2.4a).
        targetDate: addBusinessDays(readyDate, 5),
        events: [
          ...job.events,
          {
            id: objectId('ev', job.jobNumber * 100 + job.events.length),
            at: new Date().toISOString(),
            label: 'Ready date changed',
            actor: 'Matthew Browne',
            status: null,
            detail: `Moved to ${readyDate}`,
            latitude: null,
            longitude: null,
          },
        ],
      };

      store.jobs = store.jobs.map((candidate) => (candidate.id === id ? updated : candidate));
    },

    /**
     * M2.11 / M8.6 · W50, W102 — post to one of the job's three threads.
     *
     * ── Why a driver comment can be refused ────────────────────────────────
     * M8.6's shape is *"between the office and the driver"*, singular: the
     * driver in question is the one allocated to this job. On an unallocated job
     * there is no such person, so there is nobody for the message to reach —
     * and silently accepting it would put a message in a thread that never gets
     * delivered, which is worse than refusing to send it.
     */
    async addComment(jobId, draft) {
      await latency(380, 180);
      const job = findJob(jobId);
      if (!job) throw new ServiceError('NOT_FOUND', `No job ${jobId}`);

      const body = draft.body.trim();
      if (!body) {
        throw new ServiceError('VALIDATION_FAILED', 'A comment cannot be empty', {
          fieldErrors: { body: 'Write something before posting' },
        });
      }

      if (draft.visibility === 'driver' && job.driverId === null) {
        throw new ServiceError(
          'CONFLICT',
          'This job has no allocated driver, so there is nobody to send it to',
        );
      }

      const now = new Date().toISOString();
      const comment: JobComment = {
        id: objectId('cm', job.jobNumber * 10 + job.comments.length + 1),
        body,
        author: 'Matthew Browne',
        at: now,
        visibility: draft.visibility,
        // A driver comment pushes to their app (M4.11 · F45). Internal and
        // customer comments are not pushed, so they carry no delivery state —
        // `null` rather than a timestamp that would imply one.
        deliveredAt: draft.visibility === 'driver' ? now : null,
        fromDriver: false,
      };

      store.jobs = store.jobs.map((candidate) =>
        candidate.id === jobId
          ? { ...candidate, comments: [...candidate.comments, comment] }
          : candidate,
      );

      return comment;
    },
  };
}

/** M2.4a — five BUSINESS days from the customer's ready date. */
function addBusinessDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  let remaining = days;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return date.toISOString().slice(0, 10);
}

/** Relative date windows, matching how the office phrases a filter. */
function matchesWindow(isoDate: string, window: string): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${isoDate}T00:00:00`);
  const days = Math.round((target.getTime() - today.getTime()) / 86400_000);

  switch (window) {
    case 'overdue':
      return days < 0;
    case 'today':
      return days === 0;
    case 'next-3':
      return days >= 0 && days <= 3;
    case 'next-7':
      return days >= 0 && days <= 7;
    case 'last-7':
      return days <= 0 && days >= -7;
    case 'last-30':
      return days <= 0 && days >= -30;
    default:
      return true;
  }
}
