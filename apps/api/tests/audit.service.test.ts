import type { Role } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The audit log (M1.6).
 *
 * ── What is worth testing, and what is not ────────────────────────────────
 * Not the list filters — those are Mongo predicates, exercised in QA against
 * real rows. What matters here is everything that would make the log itself
 * untrustworthy, because a log nobody trusts is worse than no log: people rely
 * on it and are misled.
 *
 * Four properties, in order of how badly they hurt when broken:
 *
 *  1. **A failed audit write never fails the action.** Refusing to complete a
 *     driver's job because the log was briefly unreachable trades a small
 *     accountability gap for trucks stopped on site.
 *  2. **The diff is honest.** A field reported as changed when it did not move,
 *     or `null` conflated with `''`, is evidence that happens to be wrong.
 *  3. **Nothing is written when nothing changed.** A save that moved no field is
 *     not an event, and logging it buries the real ones.
 *  4. **Only administrators can read it.** It is accountability data about
 *     staff, not a general feed.
 *
 * The append-only guarantee is tested separately, against a real MongoDB, in
 * `audit.append-only.integration.test.ts` — Mongoose middleware is exactly the
 * kind of thing that passes a mock and fails a database.
 */

let recorded: Array<Record<string, unknown>> = [];
let recordThrows = false;
let stored: Record<string, unknown> | null = null;
let listQueriesSeen: Array<Record<string, unknown>> = [];
let counts = { application: 8, changeStream: 2 };

vi.mock('../src/domains/audit/audit.repository.js', () => ({
  auditRepository: {
    record: (input: Record<string, unknown>) => {
      if (recordThrows) return Promise.reject(new Error('mongo is down'));
      recorded.push(input);
      return Promise.resolve({ ...input, id: '650000000000000000000001' });
    },
    list: (query: Record<string, unknown>) => {
      listQueriesSeen.push(query);
      return Promise.resolve({
        data: [],
        meta: { page: 1, pageSize: 25, total: 0, totalPages: 1 },
      });
    },
    findById: () => Promise.resolve(stored),
    countBySource: () => Promise.resolve(counts),
  },
}));

const { auditService, diffFields } = await import('../src/domains/audit/audit.service.js');

function caller(...roles: Role[]): { userId: string; name: string; roles: Role[] } {
  return { userId: '650000000000000000000009', name: 'Renee Alvarez', roles };
}

beforeEach(() => {
  recorded = [];
  recordThrows = false;
  stored = null;
  listQueriesSeen = [];
  counts = { application: 8, changeStream: 2 };
});

/* ── 1. A broken log must not break the business ─────────────────────────── */

describe('recording never fails the action being audited', () => {
  it('swallows a repository failure instead of throwing', async () => {
    recordThrows = true;

    // If this rejects, a driver cannot complete a job because a log write failed.
    await expect(
      auditService.record({
        actorId: null,
        actorName: 'Dave',
        actorRole: 'driver',
        action: 'status-changed',
        entity: 'job',
        entityId: '650000000000000000000003',
        entityLabel: 'Job #61402',
        summary: 'Completed',
      }),
    ).resolves.toBeUndefined();
  });

  it('swallows a failure from the diffing path too', async () => {
    recordThrows = true;

    await expect(
      auditService.recordUpdate({
        actor: caller('operations'),
        entity: 'job',
        entityId: '650000000000000000000003',
        entityLabel: 'Job #61402',
        summary: 'Ready date changed',
        before: { readyDate: '2026-08-12' },
        after: { readyDate: '2026-08-19' },
      }),
    ).resolves.toBeUndefined();
  });
});

/* ── 2 & 3. The diff ─────────────────────────────────────────────────────── */

describe('the diff', () => {
  it('records the scope’s own worked example', async () => {
    await auditService.recordUpdate({
      actor: caller('office-staff'),
      entity: 'job',
      entityId: '650000000000000000000003',
      entityLabel: 'Job #61402',
      summary: 'Ready date changed — Clarendon Homes',
      before: { readyDate: '2026-08-12', targetDate: '2026-08-19' },
      after: { readyDate: '2026-08-19', targetDate: '2026-08-26' },
    });

    // "Who changed job 61402's ready date from 12 Aug to 19 Aug?" — one row.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.changes).toEqual([
      { field: 'readyDate', from: '2026-08-12', to: '2026-08-19' },
      { field: 'targetDate', from: '2026-08-19', to: '2026-08-26' },
    ]);
    expect(recorded[0]?.actorName).toBe('Renee Alvarez');
  });

  it('writes nothing at all when nothing moved', async () => {
    await auditService.recordUpdate({
      actor: caller('operations'),
      entity: 'job',
      entityId: '650000000000000000000003',
      entityLabel: 'Job #61402',
      summary: 'Saved',
      before: { readyDate: '2026-08-12', notes: 'gate code 4821' },
      after: { readyDate: '2026-08-12', notes: 'gate code 4821' },
    });

    // A form posts every field back. Logging a no-op save would bury real edits.
    expect(recorded).toHaveLength(0);
  });

  it('reports only the field that moved, not every field posted', async () => {
    await auditService.recordUpdate({
      actor: caller('operations'),
      entity: 'user',
      entityId: '650000000000000000000004',
      entityLabel: 'Dave Nguyen',
      summary: 'Updated',
      before: { name: 'Dave Nguyen', role: 'driver', jobTitle: 'Driver' },
      after: { name: 'Dave Nguyen', role: 'allocator', jobTitle: 'Driver' },
    });

    expect(recorded[0]?.changes).toEqual([{ field: 'role', from: 'driver', to: 'allocator' }]);
  });

  it('honours a field allow-list', async () => {
    await auditService.recordUpdate({
      actor: caller('operations'),
      entity: 'user',
      entityId: '650000000000000000000004',
      entityLabel: 'Dave Nguyen',
      summary: 'Updated',
      before: { role: 'driver', notes: 'old note' },
      after: { role: 'allocator', notes: 'new note' },
      fields: ['role'],
    });

    expect(recorded[0]?.changes).toEqual([{ field: 'role', from: 'driver', to: 'allocator' }]);
  });
});

describe('diffFields', () => {
  it('distinguishes absent from empty', () => {
    // "No purchase order" and "a purchase order of ''" are different facts.
    expect(diffFields({ poNumber: null }, { poNumber: '' })).toEqual([
      { field: 'poNumber', from: null, to: '' },
    ]);
  });

  it('treats undefined as absent, not as the string "undefined"', () => {
    expect(diffFields({}, { poNumber: 'PO-9931' })).toEqual([
      { field: 'poNumber', from: null, to: 'PO-9931' },
    ]);
  });

  it('reports a field being cleared', () => {
    expect(diffFields({ poNumber: 'PO-9931' }, { poNumber: null })).toEqual([
      { field: 'poNumber', from: 'PO-9931', to: null },
    ]);
  });

  it('renders money as the decimal string it was stored as', () => {
    // §6A.10 #1 — never a float, and never a rounded display value.
    expect(diffFields({ amountExGst: '120.00' }, { amountExGst: '351.75' })).toEqual([
      { field: 'amountExGst', from: '120.00', to: '351.75' },
    ]);
  });

  it('renders dates as ISO instants rather than locale text', () => {
    const changes = diffFields(
      { completedAt: new Date('2026-09-08T01:30:00.000Z') },
      { completedAt: new Date('2026-09-08T02:30:00.000Z') },
    );

    expect(changes[0]?.from).toBe('2026-09-08T01:30:00.000Z');
    expect(changes[0]?.to).toBe('2026-09-08T02:30:00.000Z');
  });

  it('does not report a number and its string form as a change', () => {
    // A form posts "3"; the document holds 3. Nothing moved.
    expect(diffFields({ bagCount: 3 }, { bagCount: '3' })).toEqual([]);
  });

  it('flattens an array of roles into something readable', () => {
    expect(diffFields({ roles: ['driver'] }, { roles: ['driver', 'allocator'] })).toEqual([
      { field: 'roles', from: 'driver', to: 'driver, allocator' },
    ]);
  });

  it('reports a boolean flip', () => {
    expect(diffFields({ inductionRequired: false }, { inductionRequired: true })).toEqual([
      { field: 'inductionRequired', from: 'false', to: 'true' },
    ]);
  });
});

/* ── 4. Who may read it ──────────────────────────────────────────────────── */

describe('read access', () => {
  const listQuery = { page: 1, pageSize: 25 };

  it('is allowed to a super-admin', async () => {
    await expect(auditService.list(listQuery, caller('super-admin'))).resolves.toBeDefined();
  });

  it('is allowed to operations', async () => {
    await expect(auditService.list(listQuery, caller('operations'))).resolves.toBeDefined();
  });

  it('is refused to office staff', async () => {
    // Matches the console's `audit:read` capability, which they do not hold.
    await expect(auditService.list(listQuery, caller('office-staff'))).rejects.toMatchObject({
      status: 403,
    });
  });

  it('is refused to an allocator', async () => {
    await expect(auditService.list(listQuery, caller('allocator'))).rejects.toMatchObject({
      status: 403,
    });
  });

  it('is refused to a driver', async () => {
    await expect(auditService.list(listQuery, caller('driver'))).rejects.toMatchObject({
      status: 403,
    });
  });

  it('is refused to a customer', async () => {
    await expect(
      auditService.list(listQuery, caller('customer-administrator')),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('gates the single-entry read as well as the list', async () => {
    await expect(
      auditService.get('650000000000000000000001', caller('driver')),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('404s an entry that does not exist', async () => {
    stored = null;

    await expect(
      auditService.get('650000000000000000000001', caller('super-admin')),
    ).rejects.toMatchObject({ status: 404 });
  });
});

/* ── The service writes no state of its own ──────────────────────────────── */

describe('the log is append-only at the service layer', () => {
  it('exposes no update or delete', () => {
    const surface = Object.keys(auditService);

    // If one of these ever appears, M1.6 has been broken by a helpful commit.
    expect(surface).not.toContain('update');
    expect(surface).not.toContain('delete');
    expect(surface).not.toContain('remove');
    expect(surface).not.toContain('purge');
    expect(surface.sort()).toEqual(['coverage', 'get', 'list', 'record', 'recordUpdate']);
  });
});

/* ── Coverage ────────────────────────────────────────────────────────────── */

describe('coverage', () => {
  it('reports what share of the log has a known actor', async () => {
    counts = { application: 8, changeStream: 2 };

    const result = await auditService.coverage(caller('super-admin'));

    expect(result.attributedPercent).toBe(80);
  });

  it('reports 100% on an empty log rather than NaN', async () => {
    counts = { application: 0, changeStream: 0 };

    const result = await auditService.coverage(caller('super-admin'));

    // Nothing unrecorded is not a failure, and NaN% is not a reading.
    expect(result.attributedPercent).toBe(100);
  });

  it('is gated like the rest of the log', async () => {
    await expect(auditService.coverage(caller('office-staff'))).rejects.toMatchObject({
      status: 403,
    });
  });
});

/* ── Actor handling ──────────────────────────────────────────────────────── */

describe('the actor', () => {
  it('records "System" when there is no signed-in user', async () => {
    await auditService.recordUpdate({
      actor: null,
      entity: 'invoice',
      entityId: '650000000000000000000005',
      entityLabel: 'Invoice 104102',
      summary: 'Marked overdue by the nightly sweep',
      before: { status: 'sent' },
      after: { status: 'overdue' },
    });

    // M6.6 — a system-generated change has no person behind it, and inventing
    // one would attribute an automated sweep to whoever happened to be on.
    expect(recorded[0]?.actorName).toBe('System');
    expect(recorded[0]?.actorId).toBeNull();
    expect(recorded[0]?.actorRole).toBeNull();
  });

  it('records the caller’s MAIN role, not the whole array', async () => {
    await auditService.recordUpdate({
      actor: caller('allocator', 'driver'),
      entity: 'job',
      entityId: '650000000000000000000003',
      entityLabel: 'Job #61402',
      summary: 'Reassigned',
      before: { driverId: null },
      after: { driverId: '650000000000000000000004' },
    });

    // An allocator covering a shift holds both; the column renders one label.
    expect(recorded[0]?.actorRole).toBe('allocator');
  });
});
