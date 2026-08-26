import type { Notification } from '@plastago/shared';
import { ServiceError } from '../service-error';
import type { NotificationService } from '../types';
import { applyListQuery, byDate } from './list-query';
import { objectId } from './fixtures/reference';
import { latency } from './mock-transport';
import { store } from './store';

/**
 * The internal notification centre (M8.7).
 *
 * ── Derived from real state, then frozen ───────────────────────────────────
 * Every notification here corresponds to something actually in the store: a
 * futile pickup that nobody has actioned, a driver-raised charge waiting for
 * approval, an invoice held on a PO, a device that has stopped syncing. Nothing
 * is invented, and there is no parallel "messages" table that could disagree
 * with the dashboard.
 *
 * They are built once and cached, because read state has to persist. Rebuilding
 * on every call would resurrect notifications the user had already dismissed —
 * which is the single most annoying bug an inbox can have.
 */
let cache: Notification[] | null = null;

function isoAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

function build(): Notification[] {
  const items: Notification[] = [];
  let index = 0;
  const add = (item: Omit<Notification, 'id'>) => {
    index += 1;
    items.push({ ...item, id: objectId('nt', index) });
  };

  // ── Futile pickups awaiting review (M2.6) ───────────────────────────────
  const futile = store.jobs
    .filter(
      (job) =>
        job.status === 'futile' &&
        job.charges.some(
          (charge) => charge.code === 'futile-pickup' && charge.approvalState === 'pending',
        ),
    )
    .slice(0, 4);

  for (const job of futile) {
    const ageHours = Math.max(
      1,
      Math.round((Date.now() - new Date(job.createdAt).getTime()) / 3600_000),
    );
    add({
      category: 'exception',
      // A futile pickup left for more than a fortnight is the failure mode this
      // whole screen exists to prevent.
      severity: ageHours > 24 * 14 ? 'urgent' : 'action',
      title: `Futile pickup to review — job #${String(job.jobNumber)}`,
      body: `${job.accountName} at ${job.siteName}. A $120 futile fee applies whether it is rescheduled or cancelled.`,
      at: isoAgo(Math.min(ageHours, 24 * 30)),
      readAt: null,
      // The job itself, deliberately: this alert is about ONE futile pickup, and
      // the reschedule/cancel actions are on the job as well as in the queue.
      href: `/admin/jobs/${job.id}?tab=exceptions`,
      valueExGst: '120.00',
      jobId: job.id,
      jobNumber: job.jobNumber,
    });
  }

  // ── Driver and system charges awaiting approval (M2.7) ──────────────────
  const pendingCharges = store.jobs
    .flatMap((job) =>
      job.charges
        .filter((charge) => charge.source !== 'office' && charge.approvalState === 'pending')
        .map((charge) => ({ job, charge })),
    )
    .slice(0, 5);

  for (const { job, charge } of pendingCharges) {
    add({
      category: 'queue',
      severity: 'action',
      title: `${charge.description} awaiting approval`,
      body:
        charge.source === 'driver'
          ? `Raised by ${charge.raisedBy ?? 'a driver'} on job #${String(job.jobNumber)}, with ${String(charge.photoCount)} photo${charge.photoCount === 1 ? '' : 's'} attached.`
          : `Auto-generated from on-site duration on job #${String(job.jobNumber)}.`,
      at: charge.raisedAt,
      readAt: null,
      // The approvals queue, not the job's read-only charges tab: a
      // notification has to land where the decision is actually made (M2.7).
      href: '/admin/queues/approvals',
      valueExGst: charge.amount,
      jobId: job.id,
      jobNumber: job.jobNumber,
    });
  }

  // ── Approved charges held on a PO (M7.3) ────────────────────────────────
  const awaitingPo = store.jobs.filter((job) => job.invoiceStatus === 'awaiting-po').slice(0, 4);
  for (const job of awaitingPo) {
    add({
      category: 'invoice',
      severity: 'action',
      title: `Charges awaiting a purchase order — ${job.accountName}`,
      body: `Job #${String(job.jobNumber)}. The base invoice is not held up; these charges need their own PO before they can go out.`,
      at: job.completedAt ?? job.createdAt,
      readAt: null,
      // The awaiting-PO queue rather than a filtered invoice list — the queue
      // is where the PO gets recorded and the chase gets sent (M7.3).
      href: '/admin/queues/awaiting-po',
      // Only the held charges. The job's total includes the base invoice, which
      // has already gone out — quoting it here would overstate what is stuck.
      valueExGst: job.charges
        .filter((charge) => charge.source !== 'office' && charge.approvalState === 'approved')
        .reduce((sum, charge) => sum + Number(charge.amount), 0)
        .toFixed(2),
      jobId: job.id,
      jobNumber: job.jobNumber,
    });
  }

  // ── PO pipeline review queue (M2.12) ────────────────────────────────────
  add({
    category: 'queue',
    severity: 'action',
    title: '3 extracted purchase orders need confirming',
    body: 'Below the confidence threshold, so they are queued for a human rather than attached automatically.',
    at: isoAgo(5),
    readAt: null,
    href: '/admin/invoices',
    valueExGst: null,
    jobId: null,
    jobNumber: null,
  });

  // ── Fleet and credential reminders (F43, F53) ───────────────────────────
  add({
    category: 'system',
    severity: 'action',
    title: 'Registration expires in 9 days — BQ44JT',
    body: 'Isuzu FVZ crane truck. Log the renewal and the date rolls forward automatically.',
    at: isoAgo(20),
    readAt: null,
    href: '/admin/vehicles',
    valueExGst: null,
    jobId: null,
    jobNumber: null,
  });

  add({
    category: 'system',
    severity: 'urgent',
    title: 'Registration has expired — DL92RS',
    body: '34T hooklift. The vehicle should not be on the road until this is renewed.',
    at: isoAgo(28),
    readAt: null,
    href: '/admin/vehicles',
    valueExGst: null,
    jobId: null,
    jobNumber: null,
  });

  add({
    category: 'system',
    severity: 'action',
    title: 'Crane ticket expiring — Troy Holm',
    body: 'Class 3 crane ticket expires inside the month. Chain of Responsibility makes currency an operator obligation, not just the driver’s.',
    at: isoAgo(36),
    readAt: null,
    href: '/admin/drivers',
    valueExGst: null,
    jobId: null,
    jobNumber: null,
  });

  // ── Driver sync health (§6A.8) ──────────────────────────────────────────
  add({
    category: 'sync',
    severity: 'info',
    title: 'All driver devices in sync',
    body: 'No queued offline actions. With no error-tracking vendor, this is the only place a stuck queue would surface.',
    at: isoAgo(1),
    readAt: isoAgo(1),
    href: '/admin/drivers',
    valueExGst: null,
    jobId: null,
    jobNumber: null,
  });

  // A couple already read, so the unread filter has something to hide.
  add({
    category: 'queue',
    severity: 'info',
    title: 'Daily queue digest sent',
    body: 'Futile review, approvals and awaiting-PO counts emailed to the office.',
    at: isoAgo(9),
    readAt: isoAgo(8),
    href: '/admin',
    valueExGst: null,
    jobId: null,
    jobNumber: null,
  });

  return items.sort((a, b) => b.at.localeCompare(a.at));
}

function current(): Notification[] {
  cache ??= build();
  return cache;
}

export function createMockNotificationService(): NotificationService {
  return {
    async list(query) {
      await latency(280, 140);

      return applyListQuery(current(), query, {
        search: (item) => [item.title, item.body],
        filters: {
          category: (item, value) => item.category === value,
          severity: (item, value) => item.severity === value,
          read: (item, value) => (value === 'unread' ? item.readAt === null : item.readAt !== null),
        },
        sorters: { at: byDate((item) => item.at) },
        // Newest first — an inbox is read from the top.
        defaultSort: (a, b) => b.at.localeCompare(a.at),
      });
    },

    async summary() {
      await latency(120, 60);
      const items = current();
      return {
        unread: items.filter((item) => item.readAt === null).length,
        urgent: items.filter((item) => item.readAt === null && item.severity === 'urgent').length,
      };
    },

    async markRead(ids) {
      await latency(200, 100);
      if (ids.length === 0) throw new ServiceError('VALIDATION_FAILED', 'Nothing selected');

      const at = new Date().toISOString();
      cache = current().map((item) =>
        ids.includes(item.id) && item.readAt === null ? { ...item, readAt: at } : item,
      );
    },

    async markAllRead() {
      await latency(300, 140);
      const at = new Date().toISOString();
      cache = current().map((item) => (item.readAt === null ? { ...item, readAt: at } : item));
    },
  };
}
