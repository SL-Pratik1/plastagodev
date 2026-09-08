import type { AuditChange, AuditEntry, PageMeta, Role } from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import {
  auditRepository,
  type ListAuditQuery,
  type RecordAuditInput,
} from './audit.repository.js';

const log = logger.child({ module: 'audit' });

/**
 * The audit log (M1.6) — read here, written from everywhere.
 *
 * ── ⚠️ Why this is not purely change-stream-fed ───────────────────────────
 * §6A.3 #7 says "Change Streams → append-only audit collection", and the change
 * stream IS wired up (`audit.watcher.ts`). But a change stream on its own cannot
 * satisfy M1.6, for two reasons that are worth stating plainly rather than
 * discovering later:
 *
 *  1. **A change stream knows WHAT changed, never WHO changed it.** MongoDB's
 *     oplog records the document delta; it has no concept of the signed-in user
 *     who caused it. M1.6's requirement is "who changed what" and its worked
 *     example is *"who changed job 61402's ready date?"* — the half a change
 *     stream cannot supply is the half being asked for.
 *
 *  2. **Half the audited actions are not database writes at all.** `signed-in`,
 *     `sign-in-failed`, `signed-out` and `exported` are in the contract because
 *     §9 commits to an audit of all logins, and an export leaves no trace in any
 *     collection. Nothing appears in an oplog for any of them.
 *
 * So the primary path is this service: a domain that knows the actor, the
 * intent, and the before/after calls `record()`. The change stream then runs as
 * a BACKSTOP, recording writes to audited collections that no service claimed —
 * a script, a manual database edit, or a service that forgot. That inversion is
 * the point: the stream's job is to reveal the gaps in the application's
 * record-keeping, which is a genuinely useful thing for it to do and one it can
 * do without knowing who anybody is.
 *
 * ── Read access ──────────────────────────────────────────────────────────
 * Super-admin and operations, matching the console's `audit:read` capability.
 * This is accountability data ABOUT staff — who suspended whom, who approved
 * what — and a wider audience turns it into a surveillance feed rather than an
 * administrative tool.
 */

export interface Caller {
  userId: string;
  name: string;
  roles: readonly Role[];
}

const AUDIT_READERS = new Set<Role>(['super-admin', 'operations']);

export const auditService = {
  async list(
    query: ListAuditQuery,
    caller: Caller,
  ): Promise<{ data: AuditEntry[]; meta: PageMeta }> {
    assertMayRead(caller);

    return auditRepository.list(query);
  },

  async get(id: string, caller: Caller): Promise<AuditEntry> {
    assertMayRead(caller);

    const entry = await auditRepository.findById(id);
    if (!entry) throw AppError.notFound('That audit entry does not exist');

    return entry;
  },

  /**
   * Appends one entry. Called by every other domain.
   *
   * ⚠️ NEVER THROWS. This is the one deliberate swallow in the codebase, and the
   * reasoning is: an audit write is a side effect of an action, not a part of
   * it. If the log is briefly unreachable, refusing to complete the driver's job
   * would turn a small accountability gap into trucks stopped on site. The
   * failure is logged at `error` so it surfaces, and the change-stream backstop
   * catches the resulting hole for anything that touched a collection.
   *
   * The corollary is that callers must not await this for correctness — it
   * reports nothing useful about whether the audit landed.
   */
  async record(input: RecordAuditInput): Promise<void> {
    try {
      await auditRepository.record(input);
    } catch (error) {
      log.error(
        {
          err: error,
          action: input.action,
          entity: input.entity,
          entityId: input.entityId,
          actorName: input.actorName,
        },
        'FAILED TO WRITE AUDIT ENTRY — the action succeeded but is unrecorded',
      );
    }
  },

  /**
   * The common case: somebody edited a record, and the log needs the diff.
   *
   * Takes the before and after, works out what actually moved, and writes
   * nothing at all if nothing did — a save that changed no field is not an
   * event, and logging it would bury the real changes among no-ops.
   */
  async recordUpdate(input: {
    actor: Caller | null;
    actorRole?: Role | null;
    entity: RecordAuditInput['entity'];
    entityId: string | null;
    entityLabel: string;
    summary: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    /** Restricts the diff to the fields a user can actually see and change. */
    fields?: readonly string[];
    href?: string;
    action?: RecordAuditInput['action'];
  }): Promise<void> {
    const changes = diffFields(input.before, input.after, input.fields);

    if (changes.length === 0) return;

    await auditService.record({
      actorId: input.actor?.userId ?? null,
      actorName: input.actor?.name ?? 'System',
      actorRole: input.actorRole ?? mainRole(input.actor),
      action: input.action ?? 'updated',
      entity: input.entity,
      entityId: input.entityId,
      entityLabel: input.entityLabel,
      summary: input.summary,
      changes,
      href: input.href ?? '',
    });
  },

  /** Diagnostics for the dashboard: how much of the log is unattributed. */
  async coverage(caller: Caller): Promise<{
    application: number;
    changeStream: number;
    attributedPercent: number;
  }> {
    assertMayRead(caller);

    const counts = await auditRepository.countBySource();
    const total = counts.application + counts.changeStream;

    return {
      ...counts,
      // 100% on an empty log, not NaN — nothing unrecorded is not a failure.
      attributedPercent: total === 0 ? 100 : Math.round((counts.application / total) * 1000) / 10,
    };
  },
};

/* ── Diffing ─────────────────────────────────────────────────────────────── */

/**
 * Works out which fields moved, rendered the way the screen renders them.
 *
 * ── Why everything becomes a string ───────────────────────────────────────
 * The contract stores `from`/`to` as nullable strings, and that is the right
 * call: the log must show what the USER saw. A Decimal128 read back as an object
 * and a Date read back as an instant would both display differently in the log
 * than they did on the form, and a before/after that does not match the screen
 * is one somebody will argue with.
 *
 * `null` means the field was ABSENT, which is not the same as an empty string —
 * "no purchase order" and "a purchase order of ''" are different facts.
 */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields?: readonly string[],
): AuditChange[] {
  const keys = fields ?? [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changes: AuditChange[] = [];

  for (const field of keys) {
    const from = render(before[field]);
    const to = render(after[field]);

    // Only a field that MOVED. A form posts every field back; logging all of
    // them would make the one that changed impossible to find.
    if (from === to) continue;

    changes.push({ field, from, to });
  }

  return changes;
}

/**
 * Renders one value the way the screen would show it.
 *
 * Exported because the change-stream watcher renders oplog values with exactly
 * the same rules — two copies would drift, and the log would then display the
 * same field differently depending on which path recorded it.
 */
export function renderAuditValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    return value.map((item) => renderAuditValue(item) ?? '').join(', ');
  }

  if (typeof value === 'object') {
    /*
     * Decimal128, ObjectId and Buffer all define a meaningful `toString`, and
     * that is what belongs in the log — a money value must read "351.75".
     *
     * A PLAIN object does not, and `String({})` is "[object Object]", which
     * tells a reader nothing about what changed. So the default is detected and
     * replaced with JSON, which at least says what the value was.
     */
    const text = (value as { toString: () => string }).toString();
    if (text !== '[object Object]') return text;

    try {
      return JSON.stringify(value);
    } catch {
      // Circular. Rare, and better admitted than crashing an audit write.
      return '[unserialisable]';
    }
  }

  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  /*
   * A symbol or a function, which cannot come out of a Mongo document and has no
   * meaningful before/after. Named rather than stringified, so a reader can tell
   * this apart from a field that was genuinely empty.
   */
  return '[unrepresentable]';
}

const render = renderAuditValue;

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * The role to record against an action.
 *
 * The FIRST role, because that is the one the console shows and the one a reader
 * of the log will recognise. An allocator covering a driver's shift holds both;
 * recording "allocator, driver" in a column that renders one label would just
 * render badly.
 */
function mainRole(caller: Caller | null): Role | null {
  return caller?.roles[0] ?? null;
}

function assertMayRead(caller: Caller): void {
  if (!caller.roles.some((role) => AUDIT_READERS.has(role))) {
    throw AppError.forbidden('The audit log is for administrators');
  }
}
