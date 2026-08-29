import {
  CHARGE_CODE_LABELS,
  EXCEPTION_REASON_LABELS,
  type AwaitingPoItem,
  type ChargeApprovalDetail,
  type ChargeApprovalItem,
  type FutileReview,
  type FutileReviewItem,
  type Job,
  type Lead,
  type LeadListItem,
  type PoExtractionItem,
} from '@plastago/shared';
import { ServiceError } from '../service-error';
import type { QueueService } from '../types';
import { applyListQuery, byDate, byNumber, byText } from './list-query';
import { ACCOUNTS, FUTILE_CENTS, centsToMoney, objectId } from './fixtures/reference';
import { latency } from './mock-transport';
import { invoiceList, store } from './store';

/**
 * The five office queues (M2.6, M2.7, M7.3, M2.12, M5 · Journey A).
 *
 * ── Three of the five are projections, not tables ──────────────────────────
 * Futile review, approvals and awaiting-PO are computed from `store.jobs` on
 * every call. That is not laziness — it is the only way the queue count on the
 * dashboard, the badge in the nav and the rows in the grid can never disagree.
 * The moment a queue keeps its own copy, an approval made on one screen leaves a
 * ghost on another, and the demo stops being believable exactly where it matters
 * most. Leads and inbound PO emails DO have their own store, because they have
 * no job to be a projection of.
 *
 * ── Every list is sorted oldest-first by default ───────────────────────────
 * Deliberate, and the opposite of the newest-first convention used everywhere
 * else in the console. These grids exist to be emptied, and the item that has
 * been waiting a year must be the first thing on the screen — not on page 4
 * behind everything that arrived this morning.
 */

const DEMO_ACTOR = 'Matthew Browne';

/** Milliseconds → whole days, floored. Used for every ageing badge. */
function ageDays(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function matchesAgeBucket(iso: string, bucket: string): boolean {
  const days = ageDays(iso);
  switch (bucket) {
    case 'today':
      return days < 1;
    case 'this-week':
      return days < 7;
    case 'over-week':
      return days >= 7;
    case 'over-month':
      return days >= 30;
    default:
      return true;
  }
}

function accountFor(accountId: string) {
  return ACCOUNTS.find((account) => account.id === accountId) ?? null;
}

/* ── M2.6 · Futile pickup review ──────────────────────────────────────────── */

/** When the driver pressed the button — not the ready date, not now. */
function futileMarkedAt(job: Job): string {
  return job.events.find((event) => event.status === 'futile')?.at ?? job.createdAt;
}

function futileItem(job: Job): FutileReviewItem {
  const event = job.events.find((candidate) => candidate.status === 'futile');
  const decision = store.futileDecisions.get(job.id);

  return {
    id: job.id,
    jobId: job.id,
    jobNumber: job.jobNumber,
    brandId: job.brandId,
    accountId: job.accountId,
    accountName: job.accountName,
    builderName: job.builderName,
    siteName: job.siteName,
    suburb: job.suburb,
    zone: job.zone,
    driverId: job.driverId,
    driverName: job.driverName,
    // Every futile job carries a structured reason; `other` is the fallback the
    // schema allows, never a blank.
    reason: job.exceptionReason ?? 'other',
    note: job.exceptionNote,
    markedAt: futileMarkedAt(job),
    readyDate: job.readyDate,
    photoCount: job.photos.length,
    latitude: event?.latitude ?? null,
    longitude: event?.longitude ?? null,
    // "Either way the futile fee applies" — so the fee is a property of the
    // event, not of the decision, and it is shown before anyone decides.
    feeExGst: centsToMoney(FUTILE_CENTS),
    outcome: decision?.outcome ?? 'pending',
  };
}

function futileJobs(): Job[] {
  return store.jobs.filter((job) => job.status === 'futile');
}

/* ── M2.7 · Additional service approvals ──────────────────────────────────── */

interface ChargeRow {
  job: Job;
  charge: Job['charges'][number];
}

/**
 * Every driver- or system-raised charge still waiting on a human.
 *
 * `office` charges are excluded: someone in the office already decided them by
 * typing them in, and asking them to approve their own line item is theatre.
 */
function pendingCharges(): ChargeRow[] {
  const rows: ChargeRow[] = [];
  for (const job of store.jobs) {
    for (const charge of job.charges) {
      if (charge.approvalState === 'pending' && charge.source !== 'office') {
        rows.push({ job, charge });
      }
    }
  }
  return rows;
}

function approvalItem({ job, charge }: ChargeRow): ChargeApprovalItem {
  const account = accountFor(job.accountId);

  return {
    id: charge.id,
    jobId: job.id,
    jobNumber: job.jobNumber,
    accountId: job.accountId,
    accountName: job.accountName,
    siteName: job.siteName,
    suburb: job.suburb,
    code: charge.code,
    description: charge.description,
    quantity: charge.quantity,
    unitRate: charge.unitRate,
    amountExGst: charge.amount,
    raisedBy: charge.raisedBy,
    raisedAt: charge.raisedAt,
    note: charge.note,
    photoCount: charge.photoCount,
    poRequired: account?.poPolicy === 'required-before-invoice',
    latitude: job.events.find((event) => event.status === 'arrived')?.latitude ?? null,
    longitude: job.events.find((event) => event.status === 'arrived')?.longitude ?? null,
  };
}

/* ── M7.3 · Awaiting PO ───────────────────────────────────────────────────── */

function awaitingPoItems(): AwaitingPoItem[] {
  const items: AwaitingPoItem[] = [];

  for (const invoice of invoiceList()) {
    if (invoice.status !== 'awaiting-po') continue;

    const job = store.jobs.find((candidate) => candidate.id === invoice.jobId);
    if (!job) continue;

    const extras = job.charges.filter(
      (charge) => charge.source !== 'office' && charge.approvalState === 'approved',
    );
    if (extras.length === 0) continue;

    const account = accountFor(job.accountId);
    // The billing contact is who gets chased. Falling back to the site contact
    // is wrong — site supervisors do not raise purchase orders.
    const billing =
      account?.contacts.find((contact) => contact.role === 'accounts') ??
      account?.contacts[0] ??
      null;

    const chase = store.chases.get(invoice.id);
    // Ageing runs from APPROVAL, not from the job: the clock starts when the
    // charge became billable and the PO became the only thing in the way.
    const approvedAt = extras
      .map((charge) => charge.raisedAt)
      .sort((a, b) => a.localeCompare(b))[0];

    items.push({
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      jobId: job.id,
      jobNumber: job.jobNumber,
      accountId: job.accountId,
      accountName: job.accountName,
      siteName: `${job.siteName}, ${job.suburb}`,
      contactName: billing?.name ?? null,
      contactEmail: billing?.email ?? null,
      totalExGst: invoice.subtotalExGst,
      totalIncGst: invoice.totalIncGst,
      chargeSummary: extras.map((charge) => CHARGE_CODE_LABELS[charge.code]).join(' · '),
      approvedAt: approvedAt ?? job.createdAt,
      lastChasedAt: chase?.lastChasedAt ?? null,
      chaseCount: chase?.chaseCount ?? 0,
    });
  }

  return items;
}

/* ── M5 · Journey A — leads ───────────────────────────────────────────────── */

function leadListItem(lead: Lead): LeadListItem {
  const { heardAbout: _heardAbout, notes: _notes, ...listItem } = lead;
  return listItem;
}

/* ── M2.12 · PO review ────────────────────────────────────────────────────── */

function extractionItem(extraction: (typeof store.poExtractions)[number]): PoExtractionItem {
  const {
    documentText: _text,
    fields: _fields,
    accountCandidates: _accounts,
    jobCandidates: _jobs,
    reviewedAt: _at,
    reviewedBy: _by,
    ...listItem
  } = extraction;
  return listItem;
}

/* ── Service ──────────────────────────────────────────────────────────────── */

export function createMockQueueService(): QueueService {
  return {
    async counts() {
      // No artificial latency: this feeds the nav badges on every page, and a
      // number that arrives half a second after the page is a number that
      // visibly pops in.
      await latency(90, 40);

      return {
        futileReview: futileJobs().filter((job) => !store.futileDecisions.has(job.id)).length,
        serviceApprovals: pendingCharges().length,
        awaitingPo: awaitingPoItems().length,
        poReview: store.poExtractions.filter((row) => row.state === 'needs-review').length,
        // Only leads still needing work. Won and lost are history.
        leads: store.leads.filter((lead) => !['won', 'lost'].includes(lead.status)).length,
      };
    },

    /* ── M2.6 ──────────────────────────────────────────────────────────── */

    async futileList(query) {
      await latency();
      const rows = futileJobs().map(futileItem);

      return applyListQuery(rows, query, {
        search: (row) => [
          row.jobNumber,
          row.accountName,
          row.siteName,
          row.suburb,
          row.driverName,
          EXCEPTION_REASON_LABELS[row.reason],
        ],
        filters: {
          outcome: (row, value) => row.outcome === value,
          reason: (row, value) => row.reason === value,
          account: (row, value) => row.accountId === value,
          driver: (row, value) => row.driverId === value,
          zone: (row, value) => row.zone === value,
          age: (row, value) => matchesAgeBucket(row.markedAt, value),
        },
        sorters: {
          jobNumber: byNumber((row) => row.jobNumber),
          accountName: byText((row) => row.accountName),
          markedAt: byDate((row) => row.markedAt),
          driverName: byText((row) => row.driverName),
        },
        // Undecided first, then oldest. The year-old entry is row one.
        defaultSort: (a, b) => {
          if (a.outcome !== b.outcome) return a.outcome === 'pending' ? -1 : 1;
          return a.markedAt.localeCompare(b.markedAt);
        },
      });
    },

    async futileGet(id) {
      await latency();
      const job = store.jobs.find((candidate) => candidate.id === id);
      if (!job || job.status !== 'futile') {
        throw new ServiceError('NOT_FOUND', `No futile pickup ${id}`);
      }

      const decision = store.futileDecisions.get(job.id);
      const review: FutileReview = {
        ...futileItem(job),
        photos: job.photos,
        decisionNote: decision?.note ?? null,
        decidedAt: decision?.decidedAt ?? null,
        decidedBy: decision?.decidedBy ?? null,
        newReadyDate: decision?.newReadyDate ?? null,
      };
      return review;
    },

    async futileDecide(id, decision) {
      await latency(620, 260);
      const index = store.jobs.findIndex((candidate) => candidate.id === id);
      const job = store.jobs[index];
      if (index === -1 || !job) throw new ServiceError('NOT_FOUND', `No futile pickup ${id}`);
      if (store.futileDecisions.has(id)) {
        throw new ServiceError('CONFLICT', 'This futile pickup has already been actioned');
      }

      if (decision.outcome === 'rescheduled' && !decision.newReadyDate) {
        throw new ServiceError('VALIDATION_FAILED', 'A new ready date is required to reschedule');
      }
      if (decision.outcome === 'cancelled' && !decision.cancelReason) {
        throw new ServiceError('VALIDATION_FAILED', 'A cancellation reason is required');
      }

      const now = new Date().toISOString();
      store.futileDecisions.set(id, {
        outcome: decision.outcome,
        note: decision.note,
        decidedAt: now,
        decidedBy: DEMO_ACTOR,
        newReadyDate: decision.newReadyDate,
      });

      // Rescheduling puts the job back in play at a new date; cancelling closes
      // it. In BOTH cases the $120 line stays on the job — that is the rule.
      const rescheduled = decision.outcome === 'rescheduled';
      store.jobs[index] = {
        ...job,
        status: rescheduled ? 'booked' : 'cancelled',
        readyDate: rescheduled ? (decision.newReadyDate ?? job.readyDate) : job.readyDate,
        driverId: rescheduled ? null : job.driverId,
        driverName: rescheduled ? null : job.driverName,
        exceptionReason: rescheduled ? job.exceptionReason : (decision.cancelReason ?? 'other'),
        events: [
          ...job.events,
          {
            id: objectId('ev', job.jobNumber * 7 + 3),
            at: now,
            label: rescheduled ? 'Rescheduled after futile' : 'Cancelled after futile',
            actor: DEMO_ACTOR,
            status: rescheduled ? 'booked' : 'cancelled',
            detail: decision.note || null,
            latitude: null,
            longitude: null,
          },
        ],
      };
    },

    /* ── M2.7 ──────────────────────────────────────────────────────────── */

    async approvalList(query) {
      await latency();
      const rows = pendingCharges().map(approvalItem);

      return applyListQuery(rows, query, {
        search: (row) => [
          row.jobNumber,
          row.accountName,
          row.siteName,
          row.description,
          row.raisedBy,
        ],
        filters: {
          code: (row, value) => row.code === value,
          account: (row, value) => row.accountId === value,
          driver: (row, value) => row.raisedBy === value,
          po: (row, value) => (value === 'required' ? row.poRequired : !row.poRequired),
          evidence: (row, value) =>
            value === 'with-photos' ? row.photoCount > 0 : row.photoCount === 0,
          age: (row, value) => matchesAgeBucket(row.raisedAt, value),
        },
        sorters: {
          jobNumber: byNumber((row) => row.jobNumber),
          accountName: byText((row) => row.accountName),
          raisedAt: byDate((row) => row.raisedAt),
          amountExGst: byNumber((row) => Number(row.amountExGst)),
        },
        defaultSort: (a, b) => a.raisedAt.localeCompare(b.raisedAt),
      });
    },

    async approvalGet(id) {
      await latency();
      const row = pendingCharges().find(({ charge }) => charge.id === id);
      if (!row) throw new ServiceError('NOT_FOUND', `No charge awaiting approval ${id}`);

      const detail: ChargeApprovalDetail = {
        ...approvalItem(row),
        // The evidence the driver attached. M2.7's whole argument is that the
        // office can see the timber offcuts in the bag before saying yes.
        photos: row.job.photos.slice(0, Math.max(1, row.charge.photoCount)),
        jobStatus: row.job.status,
        expectedAreaM2: row.job.expectedAreaM2,
        onSiteMinutes: row.job.onSiteMinutes,
      };
      return detail;
    },

    async approvalDecide(ids, decision) {
      await latency(680, 280);
      if (decision.decision === 'reject' && decision.note.trim().length === 0) {
        throw new ServiceError('VALIDATION_FAILED', 'A reason is required when rejecting a charge');
      }

      const wanted = new Set(ids);
      let changed = 0;

      store.jobs = store.jobs.map((job) => {
        if (!job.charges.some((charge) => wanted.has(charge.id))) return job;

        const charges = job.charges.map((charge) => {
          if (!wanted.has(charge.id) || charge.approvalState !== 'pending') return charge;
          changed += 1;
          return {
            ...charge,
            approvalState:
              decision.decision === 'approve' ? ('approved' as const) : ('rejected' as const),
            note: decision.note || charge.note,
          };
        });

        const stillPending = charges.some((charge) => charge.approvalState === 'pending');
        const account = accountFor(job.accountId);
        const approvedExtras = charges.some(
          (charge) => charge.source !== 'office' && charge.approvalState === 'approved',
        );

        // M2.7's closing sentence, implemented: an approved charge on a
        // PO-required account moves to the awaiting-PO queue. It does NOT hold
        // up the base invoice — that is the two-invoice workflow (M7.2).
        let invoiceStatus = job.invoiceStatus;
        if (!stillPending) {
          invoiceStatus =
            approvedExtras && account?.poPolicy === 'required-before-invoice' && !job.poNumber
              ? 'awaiting-po'
              : job.invoiceStatus === 'awaiting-po'
                ? 'not-invoiced'
                : job.invoiceStatus;
        }

        return { ...job, charges, hasPendingCharges: stillPending, invoiceStatus };
      });

      return changed;
    },

    /* ── M7.3 ──────────────────────────────────────────────────────────── */

    async awaitingPoList(query) {
      await latency();
      const rows = awaitingPoItems();

      return applyListQuery(rows, query, {
        search: (row) => [
          row.invoiceNumber,
          row.jobNumber,
          row.accountName,
          row.siteName,
          row.contactName,
          row.contactEmail,
        ],
        filters: {
          account: (row, value) => row.accountId === value,
          chased: (row, value) => (value === 'yes' ? row.chaseCount > 0 : row.chaseCount === 0),
          age: (row, value) => matchesAgeBucket(row.approvedAt, value),
        },
        sorters: {
          invoiceNumber: byNumber((row) => row.invoiceNumber),
          accountName: byText((row) => row.accountName),
          approvedAt: byDate((row) => row.approvedAt),
          totalExGst: byNumber((row) => Number(row.totalExGst)),
          chaseCount: byNumber((row) => row.chaseCount),
        },
        // Never chased, then oldest. Money that nobody has asked for yet is the
        // most recoverable money in the queue.
        defaultSort: (a, b) => {
          if ((a.chaseCount === 0) !== (b.chaseCount === 0)) return a.chaseCount === 0 ? -1 : 1;
          return a.approvedAt.localeCompare(b.approvedAt);
        },
      });
    },

    async awaitingPoChase(ids) {
      await latency(640, 260);
      const now = new Date().toISOString();
      let changed = 0;

      for (const id of ids) {
        const existing = store.chases.get(id);
        store.chases.set(id, {
          lastChasedAt: now,
          chaseCount: (existing?.chaseCount ?? 0) + 1,
        });
        changed += 1;
      }

      return changed;
    },

    /* ── M2.12 ─────────────────────────────────────────────────────────── */

    async poReviewList(query) {
      await latency();
      const rows = store.poExtractions.map(extractionItem);

      return applyListQuery(rows, query, {
        search: (row) => [
          row.poNumber,
          row.fromAddress,
          row.subject,
          row.attachmentName,
          row.suggestedAccountName,
          row.suggestedJobNumber,
        ],
        filters: {
          state: (row, value) => row.state === value,
          reason: (row, value) => row.reason === value,
          confidence: (row, value) =>
            value === 'low'
              ? row.overallConfidence < 0.6
              : value === 'medium'
                ? row.overallConfidence >= 0.6 && row.overallConfidence < 0.85
                : row.overallConfidence >= 0.85,
          age: (row, value) => matchesAgeBucket(row.receivedAt, value),
        },
        sorters: {
          receivedAt: byDate((row) => row.receivedAt),
          overallConfidence: byNumber((row) => row.overallConfidence),
          suggestedAccountName: byText((row) => row.suggestedAccountName),
        },
        defaultSort: (a, b) => {
          if (a.state !== b.state) return a.state === 'needs-review' ? -1 : 1;
          return a.receivedAt.localeCompare(b.receivedAt);
        },
      });
    },

    async poReviewGet(id) {
      await latency();
      const extraction = store.poExtractions.find((candidate) => candidate.id === id);
      if (!extraction) throw new ServiceError('NOT_FOUND', `No PO extraction ${id}`);
      return { ...extraction };
    },

    async poReviewConfirm(id, input) {
      await latency(720, 300);
      const index = store.poExtractions.findIndex((candidate) => candidate.id === id);
      const extraction = store.poExtractions[index];
      if (index === -1 || !extraction)
        throw new ServiceError('NOT_FOUND', `No PO extraction ${id}`);
      if (extraction.state !== 'needs-review') {
        throw new ServiceError('CONFLICT', 'This purchase order has already been reviewed');
      }

      const job = store.jobs.find((candidate) => candidate.id === input.jobId);
      if (!job) throw new ServiceError('VALIDATION_FAILED', 'Choose a job to attach this PO to');

      store.poExtractions[index] = {
        ...extraction,
        state: 'confirmed',
        poNumber: input.poNumber,
        suggestedAccountId: input.accountId,
        suggestedJobId: input.jobId,
        reviewedAt: new Date().toISOString(),
        reviewedBy: DEMO_ACTOR,
      };

      // Attaching the PO is the point — it releases whatever was waiting on it.
      store.jobs = store.jobs.map((candidate) =>
        candidate.id === job.id
          ? {
              ...candidate,
              poNumber: input.poNumber,
              invoiceStatus:
                candidate.invoiceStatus === 'awaiting-po'
                  ? 'not-invoiced'
                  : candidate.invoiceStatus,
              documents: [
                ...candidate.documents,
                {
                  id: objectId('dc', candidate.jobNumber * 3 + 1),
                  name: extraction.attachmentName,
                  kind: 'purchase-order' as const,
                  uploadedAt: new Date().toISOString(),
                  uploadedBy: `${DEMO_ACTOR} (from email)`,
                  sizeKb: 40 + extraction.pageCount * 60,
                },
              ],
            }
          : candidate,
      );
    },

    async poReviewReject(id, note) {
      await latency(560, 240);
      const index = store.poExtractions.findIndex((candidate) => candidate.id === id);
      const extraction = store.poExtractions[index];
      if (index === -1 || !extraction)
        throw new ServiceError('NOT_FOUND', `No PO extraction ${id}`);
      if (!note.trim()) {
        throw new ServiceError('VALIDATION_FAILED', 'Say why this document is not a usable PO');
      }

      store.poExtractions[index] = {
        ...extraction,
        state: 'rejected',
        reviewedAt: new Date().toISOString(),
        reviewedBy: DEMO_ACTOR,
      };
    },

    /* ── M5 · Journey A ────────────────────────────────────────────────── */

    async leadList(query) {
      await latency();
      const rows = store.leads.map(leadListItem);

      return applyListQuery(rows, query, {
        search: (row) => [
          row.companyName,
          row.contactName,
          row.email,
          row.mobile,
          row.suburbs,
          row.ownerName,
        ],
        filters: {
          status: (row, value) => row.status === value,
          source: (row, value) => row.source === value,
          zone: (row, value) => (value === 'none' ? row.zone === null : row.zone === value),
          owner: (row, value) =>
            value === 'unassigned' ? row.ownerName === null : row.ownerName === value,
          age: (row, value) => matchesAgeBucket(row.createdAt, value),
        },
        sorters: {
          companyName: byText((row) => row.companyName),
          status: byText((row) => row.status),
          createdAt: byDate((row) => row.createdAt),
          lastActivityAt: byDate((row) => row.lastActivityAt),
          typicalVolumeM2: byNumber((row) => row.typicalVolumeM2),
        },
        // Open leads first, then oldest — the same "chase" ordering as every
        // other queue. A lead that has sat unanswered for three weeks is the
        // one that costs money.
        defaultSort: (a, b) => {
          const open = (row: LeadListItem) => (['won', 'lost'].includes(row.status) ? 1 : 0);
          const byOpen = open(a) - open(b);
          return byOpen !== 0 ? byOpen : a.createdAt.localeCompare(b.createdAt);
        },
      });
    },

    async leadGet(id) {
      await latency();
      const lead = store.leads.find((candidate) => candidate.id === id);
      if (!lead) throw new ServiceError('NOT_FOUND', `No lead ${id}`);
      return { ...lead, notes: [...lead.notes] };
    },

    async leadUpdate(id, input) {
      await latency(600, 240);
      const index = store.leads.findIndex((candidate) => candidate.id === id);
      const lead = store.leads[index];
      if (index === -1 || !lead) throw new ServiceError('NOT_FOUND', `No lead ${id}`);
      if (lead.convertedAccountId) {
        throw new ServiceError('CONFLICT', 'This lead has already been converted to an account');
      }

      const now = new Date().toISOString();
      const trimmed = input.note.trim();

      const updated: Lead = {
        ...lead,
        status: input.status,
        ownerName: input.ownerName.trim() || null,
        lastActivityAt: now,
        notes: trimmed
          ? [
              ...lead.notes,
              {
                id: objectId('ln', 900 + lead.notes.length + index),
                at: now,
                author: DEMO_ACTOR,
                body: trimmed,
              },
            ]
          : lead.notes,
      };

      store.leads[index] = updated;
      return leadListItem(updated);
    },

    async leadConvert(id, input) {
      await latency(1100, 400);
      const index = store.leads.findIndex((candidate) => candidate.id === id);
      const lead = store.leads[index];
      if (index === -1 || !lead) throw new ServiceError('NOT_FOUND', `No lead ${id}`);
      if (lead.convertedAccountId) {
        throw new ServiceError('CONFLICT', 'This lead has already been converted to an account');
      }
      if (ACCOUNTS.some((account) => account.code === input.customerCode)) {
        throw new ServiceError('VALIDATION_FAILED', `Customer code ${input.customerCode} is taken`);
      }

      const accountId = objectId('ac', 200 + index);
      const now = new Date().toISOString();

      store.leads[index] = {
        ...lead,
        status: 'won',
        convertedAccountId: accountId,
        lastActivityAt: now,
        notes: [
          ...lead.notes,
          {
            id: objectId('ln', 950 + index),
            at: now,
            author: DEMO_ACTOR,
            body: `Converted to account ${input.customerCode} on the ${input.rateCardId} rate card${
              input.sendInvitation ? '. Invitation sent.' : ' (no invitation sent).'
            }`,
          },
        ],
      };

      // A real conversion also writes the Account, the Site and the invitation.
      // The mock stops at the lead because Accounts are fixture data here — the
      // service signature is what the backend implements, and it already says so.
      store.sites.push({
        id: objectId('st', 400 + index),
        accountId,
        builderName: lead.companyName,
        name: input.siteName,
        lotNumber: null,
        addressLine: `${input.siteName}, ${input.siteSuburb}`,
        suburb: input.siteSuburb,
        postcode: '2000',
        zone: input.primaryZone,
        latitude: -33.86,
        longitude: 151.2,
        accessNotes: '',
        gateHours: null,
        inductionRequired: false,
        craneAvailable: false,
        siteContactName: lead.contactName,
        siteContactMobile: lead.mobile,
        jobCount: 0,
        status: 'active',
        // A site created by converting a lead follows its new account's rule.
        // Anything else would silently exempt every customer we just won.
        riskAssessmentOverride: 'inherit',
      });

      return { accountId, customerCode: input.customerCode };
    },
  };
}
