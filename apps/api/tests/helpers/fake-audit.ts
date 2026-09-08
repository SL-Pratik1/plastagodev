/**
 * A stand-in for the audit repository, for suites that exercise a service which
 * records to the audit log (M1.6).
 *
 * ── Why every one of those suites needs this ──────────────────────────────
 * Booking a job, approving a charge, inviting a user and signing in all append
 * an audit entry now. Those are unit tests against fake repositories, so the
 * REAL audit repository has no MongoDB behind it — and Mongoose buffers a write
 * against a connection that never arrives until it times out, which turns a
 * 5-millisecond test into a 5-second one and then fails it.
 *
 * So the audit repository is faked like every other one. `entries` is exported
 * so a suite can assert what was recorded when that is the thing under test.
 *
 * Usage — `vi.mock` is hoisted, so the factory has to be passed inline:
 *
 *   vi.mock('../src/domains/audit/audit.repository.js', () => ({
 *     auditRepository: makeFakeAuditRepository(),
 *   }));
 */

export interface FakeAuditEntry {
  action: string;
  entity: string;
  entityId: string | null;
  entityLabel: string;
  actorName: string;
  summary: string;
  changes: Array<{ field: string; from: string | null; to: string | null }>;
  [key: string]: unknown;
}

/** Everything recorded during the current test file. Cleared per test. */
export const auditEntries: FakeAuditEntry[] = [];

export function clearAuditEntries(): void {
  auditEntries.length = 0;
}

/** The last entry recorded, which is what an assertion usually wants. */
export function lastAuditEntry(): FakeAuditEntry | undefined {
  return auditEntries.at(-1);
}

/** Entries for one action, e.g. every `approved` row a batch produced. */
export function auditEntriesFor(action: string): FakeAuditEntry[] {
  return auditEntries.filter((entry) => entry.action === action);
}

export function makeFakeAuditRepository(): Record<string, unknown> {
  return {
    record: (input: FakeAuditEntry) => {
      auditEntries.push(input);
      return Promise.resolve({ ...input, id: '650000000000000000000fff' });
    },
    list: () =>
      Promise.resolve({
        data: [],
        meta: { page: 1, pageSize: 25, total: 0, totalPages: 1 },
      }),
    findById: () => Promise.resolve(null),
    hasRecentEntry: () => Promise.resolve(false),
    countBySource: () => Promise.resolve({ application: 0, changeStream: 0 }),
  };
}
