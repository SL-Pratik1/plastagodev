import type { Role } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who each staff alert reaches (2026-09-24).
 *
 * ── What went wrong, and what is pinned here ──────────────────────────────
 * Every office alert went to the same three roles. The allocator — who plans
 * the runs a futile pickup, an unroadworthy truck or a driver's message upsets
 * — got none of them and had no bell. Office staff got truck and enquiry
 * alerts whose links opened "Forbidden". Each alert now goes to the roles that
 * can act on it, and an allocator is sent somewhere they are allowed to go.
 *
 * The repository is faked with a role-aware staff list, so the audience rules
 * are what is under test — the Mongo filter itself is covered in
 * `notifications-schedule.integration.test.ts`.
 */

interface Person {
  id: string;
  name: string;
  email: string | null;
  roles: Role[];
}

const STAFF: Person[] = [
  { id: 'usr_admin', name: 'Matthew', email: 'matt@x.au', roles: ['super-admin'] },
  { id: 'usr_ops', name: 'Renee', email: 'renee@x.au', roles: ['operations'] },
  { id: 'usr_office', name: 'Priya', email: 'office@x.au', roles: ['office-staff'] },
  { id: 'usr_alloc', name: 'Dean', email: null, roles: ['allocator', 'driver'] },
];

const raised: Array<Record<string, unknown>> = [];

let futileRows: Array<Record<string, unknown>> = [];
let expiringVehicles: Array<Record<string, unknown>> = [];

vi.mock('../src/domains/notifications/notification.repository.js', () => ({
  notificationRepository: {
    officeRecipients: (roles: readonly Role[] = ['super-admin', 'operations', 'office-staff']) =>
      Promise.resolve(STAFF.filter((person) => person.roles.some((role) => roles.includes(role)))),
    raise: (input: Record<string, unknown>) => {
      raised.push(input);
      return Promise.resolve();
    },
  },
}));

vi.mock('../src/domains/queues/queue.repository.js', () => ({
  queueRepository: {
    futileList: () =>
      Promise.resolve({ data: futileRows, meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } }),
    approvalList: () =>
      Promise.resolve({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } }),
    awaitingPoList: () =>
      Promise.resolve({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } }),
  },
}));

vi.mock('../src/domains/fleet/vehicle.repository.js', () => ({
  vehicleRepository: { expiringSoon: () => Promise.resolve(expiringVehicles) },
}));

const { notificationService } = await import('../src/domains/notifications/notification.service.js');

const who = () => raised.map((row) => row.userId).sort();

beforeEach(() => {
  raised.length = 0;
  futileRows = [];
  expiringVehicles = [];
});

const alert = {
  category: 'exception' as const,
  severity: 'action' as const,
  title: 'Futile pickup — #61301 Lot 77',
  body: 'Troy Holm could not collect.',
  href: '/admin/queues/futile',
  subjectKey: 'futile:job1',
};

describe('the audiences', () => {
  it('keeps the default — the three office roles — for money and customer talk', async () => {
    await notificationService.notifyOffice(alert);

    expect(who()).toEqual(['usr_admin', 'usr_office', 'usr_ops']);
  });

  it('adds the allocator to dispatch alerts', async () => {
    await notificationService.notifyOffice({ ...alert, audience: 'dispatch' });

    expect(who()).toEqual(['usr_admin', 'usr_alloc', 'usr_office', 'usr_ops']);
  });

  /* Trucks go to whoever can open a vehicle — not office staff. */
  it('sends fleet alerts to the roles that can open the vehicle screens', async () => {
    await notificationService.notifyOffice({ ...alert, audience: 'fleet', href: '/admin/vehicles' });

    expect(who()).toEqual(['usr_admin', 'usr_alloc', 'usr_ops']);
  });

  it('sends a new enquiry only to the roles that can open the lead queue', async () => {
    await notificationService.notifyOffice({ ...alert, audience: 'sales' });

    expect(who()).toEqual(['usr_admin', 'usr_ops']);
  });

  it('sends "plan it again" to the people who plan runs', async () => {
    await notificationService.notifyOffice({ ...alert, audience: 'planning' });

    expect(who()).toEqual(['usr_admin', 'usr_alloc', 'usr_ops']);
  });
});

describe('an allocator is sent somewhere they can go', () => {
  it('links them to allocatorHref when the main link is a queue they cannot open', async () => {
    await notificationService.notifyOffice({
      ...alert,
      audience: 'dispatch',
      allocatorHref: '/admin/jobs/job1',
    });

    const hrefs = Object.fromEntries(raised.map((row) => [row.userId, row.href]));
    expect(hrefs).toEqual({
      usr_admin: '/admin/queues/futile',
      usr_ops: '/admin/queues/futile',
      usr_office: '/admin/queues/futile',
      usr_alloc: '/admin/jobs/job1',
    });
  });

  it('never shows the allocator an amount', async () => {
    await notificationService.notifyOffice({ ...alert, audience: 'dispatch', valueExGst: '120.00' });

    const values = Object.fromEntries(raised.map((row) => [row.userId, row.valueExGst]));
    expect(values.usr_alloc).toBeNull();
    expect(values.usr_ops).toBe('120.00');
  });
});

it('does not tell somebody about what they just did', async () => {
  await notificationService.notifyOffice({ ...alert, audience: 'planning', exceptUserId: 'usr_ops' });

  expect(who()).toEqual(['usr_admin', 'usr_alloc']);
});

describe('the daily sweep', () => {
  it('sends truck expiry to the fleet roles, and queue items to the office', async () => {
    expiringVehicles = [
      { id: 'veh1', rego: 'GH78IJ', label: 'Isuzu NPR', kind: 'registration', dueOn: '2026-10-10' },
    ];
    futileRows = [
      {
        id: 'rev1',
        jobId: 'job1',
        jobNumber: 61301,
        accountName: 'Clarendon Homes',
        siteName: 'Lot 77',
        markedAt: '2026-09-20T01:00:00.000Z',
        feeExGst: '120.00',
      },
    ];

    await notificationService.runQueueSweep();

    const truckAlerts = raised.filter((row) => String(row.subjectKey).startsWith('vehicle-'));
    const futileAlerts = raised.filter((row) => String(row.subjectKey).startsWith('futile-review:'));

    expect(truckAlerts.map((row) => row.userId).sort()).toEqual(['usr_admin', 'usr_alloc', 'usr_ops']);
    expect(futileAlerts.map((row) => row.userId).sort()).toEqual(['usr_admin', 'usr_office', 'usr_ops']);
  });
});
