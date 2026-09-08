import type { Role } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The internal notification centre (M8.7).
 *
 * ── What is actually under test ───────────────────────────────────────────
 * Two things, and the second is the harder one.
 *
 * That the sweep CHASES: one futile pickup sat unactioned in TransVirtual since
 * 28 August 2025 — a year, at $120 — because nothing looked.
 *
 * And that it shows RESTRAINT: a centre where everything is urgent trains
 * people to ignore it. So `urgent` is reserved for things that stop work, and
 * nothing is announced twice.
 */

interface RaisedNotification {
  userId: string;
  category: string;
  severity: string;
  title: string;
  body: string;
  subjectKey: string;
  valueExGst?: string | null;
}

let raised: RaisedNotification[] = [];
let markedRead: Array<{ userId: string; ids: readonly string[] }> = [];
let listScopes: string[] = [];

/** What the repositories report back. Set per test. */
let recipients = [{ id: 'usr1', name: 'Renee Alvarez' }];
let futileRows: Array<Record<string, unknown>> = [];
let approvalRows: Array<Record<string, unknown>> = [];
let awaitingPoRows: Array<Record<string, unknown>> = [];
let expiringVehicles: Array<Record<string, unknown>> = [];
let stuckDevices: Array<Record<string, unknown>> = [];

vi.mock('../src/domains/notifications/notification.repository.js', () => ({
  notificationRepository: {
    list: (userId: string) => {
      listScopes.push(userId);
      return Promise.resolve({
        data: [],
        meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
      });
    },
    summary: () => Promise.resolve({ unread: 4, urgent: 1 }),
    raise: (input: RaisedNotification) => {
      raised.push(input);
      return Promise.resolve();
    },
    markRead: (userId: string, ids: readonly string[]) => {
      markedRead.push({ userId, ids });
      return Promise.resolve(ids.length);
    },
    markAllRead: () => Promise.resolve(3),
    officeRecipients: () => Promise.resolve(recipients),
  },
}));

vi.mock('../src/domains/queues/queue.repository.js', () => ({
  queueRepository: {
    futileList: () =>
      Promise.resolve({
        data: futileRows,
        meta: { page: 1, pageSize: 20, total: futileRows.length, totalPages: 1 },
      }),
    approvalList: () =>
      Promise.resolve({
        data: approvalRows,
        meta: { page: 1, pageSize: 20, total: approvalRows.length, totalPages: 1 },
      }),
    awaitingPoList: () =>
      Promise.resolve({
        data: awaitingPoRows,
        meta: { page: 1, pageSize: 20, total: awaitingPoRows.length, totalPages: 1 },
      }),
  },
}));

vi.mock('../src/domains/fleet/vehicle.repository.js', () => ({
  vehicleRepository: { expiringSoon: () => Promise.resolve(expiringVehicles) },
}));

vi.mock('../src/domains/users/user.repository.js', () => ({
  userRepository: { stuckDevices: () => Promise.resolve(stuckDevices) },
}));

const { notificationService } = await import(
  '../src/domains/notifications/notification.service.js'
);

const CALLER = {
  userId: 'usr1',
  name: 'Renee Alvarez',
  roles: ['operations'] as Role[],
};

const OTHER = {
  userId: 'usr2',
  name: 'Priya Raman',
  roles: ['office-staff'] as Role[],
};

/** A futile review that has been sitting. */
function futile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rev1',
    jobId: 'job1',
    jobNumber: 61_318,
    accountName: 'Clarendon Homes',
    siteName: 'Lot 600',
    markedAt: daysAgoIso(4),
    feeExGst: '120.00',
    ...overrides,
  };
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function tomorrowIso(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

function yesterdayIso(): string {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
}

beforeEach(() => {
  raised = [];
  markedRead = [];
  listScopes = [];
  recipients = [{ id: 'usr1', name: 'Renee Alvarez' }];
  futileRows = [];
  approvalRows = [];
  awaitingPoRows = [];
  expiringVehicles = [];
  stuckDevices = [];
});

describe('an inbox belongs to one person', () => {
  it('reads the caller’s own and no other', async () => {
    await notificationService.list({ page: 1, pageSize: 20 }, CALLER);

    // No route takes a user id, so this is the only scope there is.
    expect(listScopes[0]).toBe('usr1');
  });

  it('marks read against the caller, not a supplied user', async () => {
    await notificationService.markRead(['a'.repeat(24)], OTHER);

    expect(markedRead[0]?.userId).toBe('usr2');
  });

  it('refuses an empty selection', async () => {
    await expect(notificationService.markRead([], CALLER)).rejects.toMatchObject({
      status: 422,
    });
  });
});

describe('⚠️ the sweep chases', () => {
  /*
   * The reason this domain exists. A futile pickup nobody decided is a customer
   * nobody rang back, and $120 nobody invoiced.
   */
  it('raises a notification naming the job, the customer and the amount', async () => {
    futileRows = [futile()];

    await notificationService.runQueueSweep();

    expect(raised).toHaveLength(1);
    expect(raised[0]?.title).toContain('61318');
    expect(raised[0]?.body).toContain('Clarendon Homes');
    // The amount IS the argument for looking at it.
    expect(raised[0]?.valueExGst).toBe('120.00');
  });

  /*
   * "3 futile reviews are overdue" is not actionable — it does not say which,
   * and somebody has to open the queue to work out what changed.
   */
  it('raises one per row, not one summary line', async () => {
    futileRows = [futile({ id: 'rev1' }), futile({ id: 'rev2' }), futile({ id: 'rev3' })];

    await notificationService.runQueueSweep();

    expect(raised).toHaveLength(3);
    expect(new Set(raised.map((item) => item.subjectKey)).size).toBe(3);
  });

  it('raises for every office user', async () => {
    recipients = [
      { id: 'usr1', name: 'Renee' },
      { id: 'usr2', name: 'Priya' },
    ];
    futileRows = [futile()];

    await notificationService.runQueueSweep();

    // Read state is per person: Renee marking it read must not hide it from
    // Priya, who still has to act.
    expect(raised).toHaveLength(2);
    expect(raised.map((item) => item.userId).sort()).toEqual(['usr1', 'usr2']);
  });

  it('says how long it has been sitting', async () => {
    futileRows = [futile({ markedAt: daysAgoIso(4) })];

    await notificationService.runQueueSweep();

    // The age is the argument, so it is spelled out rather than left as a date
    // somebody has to subtract in their head.
    expect(raised[0]?.body).toContain('4 days ago');
  });

  it('says so when there is nobody to notify', async () => {
    recipients = [];
    futileRows = [futile()];

    const result = await notificationService.runQueueSweep();

    // A silent sweep looks like a working one.
    expect(result.raised).toBe(0);
    expect(raised).toHaveLength(0);
  });
});

describe('⚠️ restraint — what is allowed to be urgent', () => {
  /*
   * An expired registration means the truck cannot legally be driven, and
   * finding out on the morning of a run is finding out too late.
   */
  it('marks an EXPIRED registration urgent', async () => {
    expiringVehicles = [
      { id: 'veh1', rego: 'BQ12AB', label: 'Isuzu FVZ', kind: 'registration', dueOn: yesterdayIso() },
    ];

    await notificationService.runQueueSweep();

    expect(raised[0]?.severity).toBe('urgent');
    expect(raised[0]?.title).toContain('has expired');
  });

  it('does NOT mark a registration merely due as urgent', async () => {
    expiringVehicles = [
      { id: 'veh1', rego: 'BQ12AB', label: 'Isuzu FVZ', kind: 'registration', dueOn: tomorrowIso() },
    ];

    await notificationService.runQueueSweep();

    expect(raised[0]?.severity).toBe('action');
    expect(raised[0]?.title).toContain('is due');
  });

  /* A service is a booking, not a grounding — even when it is overdue. */
  it('does not mark an overdue service urgent', async () => {
    expiringVehicles = [
      { id: 'veh1', rego: 'BQ12AB', label: 'Isuzu FVZ', kind: 'service', dueOn: yesterdayIso() },
    ];

    await notificationService.runQueueSweep();

    expect(raised[0]?.severity).toBe('action');
  });

  /*
   * The truck already left. Somebody has to ring the customer, which is a today
   * job — not a stop-work one.
   */
  it('does not mark a futile review urgent', async () => {
    futileRows = [futile()];

    await notificationService.runQueueSweep();

    expect(raised[0]?.severity).toBe('action');
  });
});

describe('§6A.8 — a stuck offline queue must be visible', () => {
  /*
   * There is no error-tracking vendor. A driver's phone holding fourteen unsent
   * actions since Tuesday is invisible unless the product says so.
   */
  it('raises when a device has not drained its queue', async () => {
    stuckDevices = [
      {
        userId: 'usr9',
        label: "Troy's iPhone",
        pendingSyncActions: 14,
        lastSyncAt: new Date(Date.now() - 3 * 86_400_000),
      },
    ];

    await notificationService.runQueueSweep();

    expect(raised[0]?.category).toBe('sync');
    expect(raised[0]?.title).toContain('14 unsent actions');
    expect(raised[0]?.body).toContain('3 days ago');
  });

  it('handles a device that has never synced at all', async () => {
    stuckDevices = [
      { userId: 'usr9', label: "Troy's iPhone", pendingSyncActions: 6, lastSyncAt: null },
    ];

    await notificationService.runQueueSweep();

    expect(raised[0]?.body).toContain('never');
  });
});

describe('the awaiting-PO chase', () => {
  it('says whether it has been chased before', async () => {
    awaitingPoRows = [
      {
        id: 'inv1',
        invoiceNumber: 104_103,
        accountName: 'Clarendon Homes',
        chargeSummary: 'Contamination charge',
        totalExGst: '90.00',
        lastChasedAt: null,
        chaseCount: 0,
        jobId: 'job1',
        jobNumber: 61_320,
      },
    ];

    await notificationService.runQueueSweep();

    // Never chased is the row that costs three months.
    expect(raised[0]?.body).toContain('Never chased');
    expect(raised[0]?.category).toBe('invoice');
  });

  it('reports the chase count when there has been one', async () => {
    awaitingPoRows = [
      {
        id: 'inv1',
        invoiceNumber: 104_103,
        accountName: 'Clarendon Homes',
        chargeSummary: 'Contamination charge',
        totalExGst: '90.00',
        lastChasedAt: daysAgoIso(9),
        chaseCount: 2,
        jobId: null,
        jobNumber: null,
      },
    ];

    await notificationService.runQueueSweep();

    expect(raised[0]?.body).toContain('2×');
  });
});

describe('charge approvals', () => {
  it('warns the approver what approving will trigger', async () => {
    approvalRows = [
      {
        id: 'chg1',
        jobId: 'job1',
        jobNumber: 61_320,
        accountName: 'Clarendon Homes',
        description: 'Contamination charge',
        amountExGst: '90.00',
        raisedBy: 'Troy Holm',
        raisedAt: daysAgoIso(5),
        poRequired: true,
      },
    ];

    await notificationService.runQueueSweep();

    // M2.7 — on a PO-required account, approving moves it to a queue rather
    // than releasing money. The approver should know before clicking.
    expect(raised[0]?.body).toContain('awaiting-PO queue');
    expect(raised[0]?.valueExGst).toBe('90.00');
  });

  it('does not say that on an account with no PO policy', async () => {
    approvalRows = [
      {
        id: 'chg1',
        jobId: 'job1',
        jobNumber: 61_320,
        accountName: 'Wisdom Homes',
        description: 'Contamination charge',
        amountExGst: '90.00',
        raisedBy: 'Troy Holm',
        raisedAt: daysAgoIso(5),
        poRequired: false,
      },
    ];

    await notificationService.runQueueSweep();

    expect(raised[0]?.body).not.toContain('awaiting-PO queue');
  });
});

describe('notifyOffice', () => {
  it('reaches every office user', async () => {
    recipients = [
      { id: 'usr1', name: 'Renee' },
      { id: 'usr2', name: 'Priya' },
    ];

    await notificationService.notifyOffice({
      category: 'exception',
      severity: 'urgent',
      title: 'Site unsafe',
      body: 'Driver stopped work',
      href: '/jobs/job1',
      subjectKey: 'site-unsafe:job1',
    });

    expect(raised).toHaveLength(2);
    expect(raised.every((item) => item.severity === 'urgent')).toBe(true);
  });
});
