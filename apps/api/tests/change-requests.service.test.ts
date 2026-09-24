import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The office end of the portal's change-request channel (M5.4).
 *
 * ⚠️ Why this file exists: the channel had no office end at all. The portal
 * refuses a direct edit once a pickup is on a run sheet and points the customer
 * at "Request a change", telling them the office has it. The rows were written
 * and read by nothing — no screen, no queue, no notification — so the only way a
 * customer could reach anybody after allocation went nowhere. These tests pin
 * the parts that make the promise true.
 */

const decideChangeRequest = vi.fn();
const changeRequestList = vi.fn();
/*
 * Takes rest args so the mock below can forward whatever the service passes.
 * A zero-arg signature cannot be spread into, and the assertions in this file
 * read the recorded arguments.
 */
const notifyJobAudience = vi.fn(async (..._args: unknown[]) => [] as unknown[]);

vi.mock('../src/domains/queues/queue.repository.js', () => ({
  queueRepository: {
    changeRequestList: (...args: unknown[]) => changeRequestList(...args),
    decideChangeRequest: (...args: unknown[]) => decideChangeRequest(...args),
  },
}));

vi.mock('../src/domains/notifications/notification.service.js', () => ({
  notificationService: {
    notifyJobAudience: (...args: unknown[]) => notifyJobAudience(...args),
    notifyOffice: vi.fn(async () => []),
  },
}));

vi.mock('../src/domains/settings/settings.repository.js', () => ({
  settingsRepository: { futileFeeExGst: vi.fn(async () => '120.00') },
}));

const { queueService } = await import('../src/domains/queues/queue.service.js');

type Role = 'super-admin' | 'operations' | 'office-staff' | 'allocator' | 'driver';

const caller = (role: Role) => ({
  userId: 'u1',
  name: 'Priya Raman',
  roles: [role] as never,
  accountId: null,
});

const RESOLVED = {
  jobId: 'job1',
  jobNumber: 61472,
  accountId: 'acc1',
  bookedByUserId: 'usr0000000000000000000s1',
};

beforeEach(() => {
  vi.clearAllMocks();
  decideChangeRequest.mockResolvedValue(RESOLVED);
  changeRequestList.mockResolvedValue({ data: [], meta: { page: 1, pageSize: 25, total: 0 } });
});

describe('who may work the queue', () => {
  /*
   * `assertOffice`, not `assertApprover`. Answering "can we move this to
   * Thursday" is dispatch work, not a pricing decision — and the allocator is
   * the one person who can see whether the run has room for it.
   */
  it('lets the allocator read it', async () => {
    await expect(
      queueService.changeRequestList(
        { page: 1, pageSize: 25, sort: null } as never,
        caller('allocator'),
      ),
    ).resolves.toBeDefined();
  });

  it('refuses a driver', async () => {
    await expect(
      queueService.changeRequestList(
        { page: 1, pageSize: 25, sort: null } as never,
        caller('driver'),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('answering a request', () => {
  it('records who decided it', async () => {
    await queueService.changeRequestDecide(
      'cr1',
      { outcome: 'actioned', note: 'Moved to Thursday.' },
      caller('office-staff'),
    );

    expect(decideChangeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cr1', outcome: 'actioned', decidedBy: 'Priya Raman' }),
    );
  });

  /*
   * A decline must say why, for the reason a rejected charge must: the customer
   * asked for something and is being told no. Unlike the charge case this reason
   * DOES reach them — it is the body of their notification.
   */
  it('refuses a decline with no reason', async () => {
    await expect(
      queueService.changeRequestDecide(
        'cr1',
        { outcome: 'declined', note: '   ' },
        caller('office-staff'),
      ),
    ).rejects.toMatchObject({ status: 422 });

    expect(decideChangeRequest).not.toHaveBeenCalled();
  });

  it('allows an acceptance with no note — there is nothing to explain', async () => {
    await expect(
      queueService.changeRequestDecide(
        'cr1',
        { outcome: 'actioned', note: '' },
        caller('office-staff'),
      ),
    ).resolves.toBeUndefined();
  });

  /* Two people working the same queue must not both answer the same row. */
  it('conflicts when it has already been answered', async () => {
    decideChangeRequest.mockResolvedValue(null);

    await expect(
      queueService.changeRequestDecide(
        'cr1',
        { outcome: 'actioned', note: '' },
        caller('office-staff'),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('telling the customer', () => {
  it('sends the decision to the account that asked', async () => {
    await queueService.changeRequestDecide(
      'cr1',
      { outcome: 'declined', note: 'The truck is already loaded for this run.' },
      caller('office-staff'),
    );

    expect(notifyJobAudience).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc1',
        title: 'Your change request for #61472 was declined',
        body: 'The truck is already loaded for this run.',
        href: '/portal/jobs/job1',
      }),
    );
  });

  /*
   * The pickup's audience — its administrators and the supervisor who booked
   * it. Every other supervisor on the account would be told about a pickup the
   * portal will not open for them.
   */
  it('reaches the supervisor who booked the pickup, not every supervisor', async () => {
    await queueService.changeRequestDecide(
      'cr1',
      { outcome: 'actioned', note: '' },
      caller('office-staff'),
    );

    expect(notifyJobAudience).toHaveBeenCalledWith(
      expect.objectContaining({ bookedByUserId: 'usr0000000000000000000s1' }),
    );
  });

  it('carries the reason as the body, because that is what they need to read', async () => {
    await queueService.changeRequestDecide(
      'cr1',
      { outcome: 'actioned', note: 'Moved to Thursday, same driver.' },
      caller('office-staff'),
    );

    expect(notifyJobAudience).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Moved to Thursday, same driver.' }),
    );
  });

  /* An acceptance with nothing typed still has to say something useful. */
  it('falls back to a plain sentence when the office typed nothing', async () => {
    await queueService.changeRequestDecide(
      'cr1',
      { outcome: 'actioned', note: '' },
      caller('office-staff'),
    );

    expect(notifyJobAudience).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'The office has actioned your request.' }),
    );
  });

  /* One notification per decision, keyed on the request. */
  it('keys the notification on the request, so a retry cannot double-send', async () => {
    await queueService.changeRequestDecide(
      'cr1',
      { outcome: 'actioned', note: '' },
      caller('office-staff'),
    );

    expect(notifyJobAudience).toHaveBeenCalledWith(
      expect.objectContaining({ subjectKey: 'change-request-decided:cr1' }),
    );
  });
});
