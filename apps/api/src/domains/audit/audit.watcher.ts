import type { AuditEntity } from '@plastago/shared';
import mongoose from 'mongoose';
import { supportsTransactions } from '../../db/mongo.js';
import { logger } from '../../lib/logger.js';
import { auditRepository } from './audit.repository.js';
import { renderAuditValue } from './audit.service.js';

const log = logger.child({ module: 'audit-watcher' });

/**
 * §6A.3 #7 — Change Streams feeding the append-only audit collection.
 *
 * ── What this actually does, and why it is a backstop ─────────────────────
 * It watches the collections that matter and records any write that no service
 * claimed. It does NOT record every change, because it cannot usefully: the
 * oplog carries the document delta and nothing about who caused it, so an entry
 * written from here can only ever say "something changed" — which is the half of
 * M1.6 that was already easy.
 *
 * The application records the other half (see `audit.service.ts`). This process
 * exists to answer a different and genuinely valuable question: *what changed in
 * the database that nobody wrote down?* That is a script run against production,
 * a manual `mongosh` edit during an incident, or a service that forgot to call
 * `record()`. All three are invisible otherwise, and all three are exactly what
 * an auditor asks about.
 *
 * ── Where it runs ─────────────────────────────────────────────────────────
 * In the worker process, ONCE. Running it in the API would mean one watcher per
 * replica, and three replicas would write three copies of every unattributed
 * change — into a collection that by design cannot be de-duplicated afterwards.
 *
 * ── ⚠️ Requires a replica set ─────────────────────────────────────────────
 * Change streams read the oplog, which a standalone `mongod` does not have. On a
 * developer's local standalone this logs a clear warning and does nothing, which
 * is the honest behaviour — the alternative, crashing the worker, would make the
 * dev environment worse to no benefit. Production is Atlas (§6A.3 #2).
 */

/**
 * Which collections are watched, and how a change in each is described.
 *
 * Deliberately not "everything". `auditentries` itself must never be watched —
 * a watcher writing to the collection it watches is an infinite loop — and the
 * high-churn operational collections (`jobevents`, `notifications`, `session`,
 * `verification`) are machine-generated noise that would bury the human changes
 * this log exists to surface.
 */
const WATCHED: Record<string, { entity: AuditEntity; label: string; href: (id: string) => string }> =
  {
    jobs: { entity: 'job', label: 'Job', href: (id) => `/admin/jobs/${id}` },
    accounts: { entity: 'account', label: 'Account', href: (id) => `/admin/customers/${id}` },
    invoices: { entity: 'invoice', label: 'Invoice', href: (id) => `/admin/invoices/${id}` },
    jobcharges: { entity: 'charge', label: 'Charge', href: () => '' },
    user: { entity: 'user', label: 'User', href: (id) => `/admin/users/${id}` },
    vehicles: { entity: 'vehicle', label: 'Vehicle', href: (id) => `/admin/fleet/${id}` },
    settings: { entity: 'settings', label: 'Settings', href: () => '/admin/settings' },
  };

/**
 * How long after a change an application entry still counts as covering it.
 *
 * Ten seconds. The application writes its audit row in the same request as the
 * change, so the real gap is milliseconds; the margin is for clock skew between
 * the API and the worker, and for a change stream that fell behind under load.
 */
const CLAIM_WINDOW_MS = 10_000;

/** Fields whose movement is never interesting on its own. */
const IGNORED_FIELDS = new Set(['updatedAt', 'createdAt', '__v', 'lastSyncAt', 'lastSeenAt']);

let stream: mongoose.mongo.ChangeStream | null = null;
let stopping = false;

export const auditWatcher = {
  /**
   * Starts watching. Safe to call when the topology cannot support it — it says
   * so and returns rather than throwing.
   */
  async start(): Promise<{ started: boolean; reason?: string }> {
    if (stream) return { started: true };

    /*
     * The same check transactions use: a replica set or a sharded cluster. Both
     * features need the oplog, so if one is unavailable so is the other.
     */
    if (!(await supportsTransactions())) {
      const reason =
        'MongoDB is standalone — change streams need a replica set, so the audit ' +
        'backstop is OFF. Application-level audit recording is unaffected. ' +
        'Use Atlas or a local replica set to enable it (§6A.3 #2, #7).';
      log.warn(reason);
      return { started: false, reason };
    }

    const db = mongoose.connection.db;
    if (!db) return { started: false, reason: 'no MongoDB connection' };

    stopping = false;

    stream = db.watch(
      [
        { $match: { 'ns.coll': { $in: Object.keys(WATCHED) } } },
        { $match: { operationType: { $in: ['insert', 'update', 'replace', 'delete'] } } },
      ],
      {
        /*
         * The document AFTER the change, so a delta can be described in terms a
         * reader recognises rather than as a list of raw field paths. `whenAvailable`
         * rather than `required`: a delete has no after-image, and demanding one
         * would drop exactly the events most worth noticing.
         */
        fullDocument: 'whenAvailable',
        fullDocumentBeforeChange: 'whenAvailable',
      },
    );

    stream.on('change', (change) => {
      void handleChange(change).catch((error: unknown) => {
        log.error({ err: error }, 'audit watcher failed to handle a change');
      });
    });

    stream.on('error', (error: unknown) => {
      log.error({ err: error }, 'audit change stream errored');
      /*
       * Resumption is the driver's job while the stream is alive; a surfaced
       * error means it gave up. Reopening on a fresh cursor loses events between
       * the failure and the restart, which is a gap — logged as one rather than
       * papered over, because a backstop that silently skips is worse than none.
       */
      if (!stopping) {
        log.warn('reopening the audit change stream — events during the gap are LOST');
        stream = null;
        void auditWatcher.start();
      }
    });

    log.info(
      { collections: Object.keys(WATCHED).length },
      'audit change-stream backstop started',
    );

    return { started: true };
  },

  async stop(): Promise<void> {
    stopping = true;
    if (!stream) return;

    await stream.close();
    stream = null;
    log.info('audit change-stream backstop stopped');
  },

  /** Test seam: is it currently watching? */
  isRunning(): boolean {
    return stream !== null;
  },
};

/* ── Handling one change ─────────────────────────────────────────────────── */

async function handleChange(change: mongoose.mongo.ChangeStreamDocument): Promise<void> {
  if (!('ns' in change) || !('documentKey' in change)) return;

  const watched = WATCHED[change.ns.coll];
  if (!watched) return;

  const entityId = String(change.documentKey._id);
  const at = change.clusterTime ? new Date(change.clusterTime.getHighBits() * 1000) : new Date();

  const changes = describeChange(change);

  /*
   * An update that moved nothing a person cares about — a `lastSeenAt` touch, a
   * Mongoose version bump. Recording these would bury the real entries.
   */
  if (change.operationType === 'update' && changes.length === 0) return;

  // Did a service already log this, properly attributed? Then leave it alone.
  if (await auditRepository.hasRecentEntry(watched.entity, entityId, at, CLAIM_WINDOW_MS)) {
    return;
  }

  const label = describeLabel(change, watched.label, entityId);

  await auditRepository.record({
    at,
    /*
     * ⚠️ Null, always. This is the honest limitation of a change stream and the
     * reason it is a backstop: the oplog does not carry the user. Showing
     * "Unknown" rather than guessing is the whole value of the entry — it tells
     * an administrator that something changed OUTSIDE the application's
     * record-keeping, which is a finding in itself.
     */
    actorId: null,
    actorName: 'Unknown (direct database change)',
    actorRole: null,
    action:
      change.operationType === 'insert'
        ? 'created'
        : change.operationType === 'delete'
          ? 'deleted'
          : 'updated',
    entity: watched.entity,
    entityId,
    entityLabel: label,
    summary:
      `${watched.label} ${change.operationType === 'insert' ? 'created' : change.operationType === 'delete' ? 'deleted' : 'changed'} ` +
      'directly in the database, with no signed-in user recorded',
    changes,
    href: change.operationType === 'delete' ? '' : watched.href(entityId),
    source: 'change-stream',
  });

  log.warn(
    { collection: change.ns.coll, entityId, operation: change.operationType },
    'unattributed database change recorded by the audit backstop',
  );
}

/**
 * Turns an oplog delta into before/after rows.
 *
 * An update carries `updateDescription`, which names the fields that moved but
 * gives only their NEW values — the oplog does not keep the old one unless the
 * deployment enables pre-images. So `from` is filled in when a before-image is
 * available and left null when it is not, rather than being invented.
 */
function describeChange(
  change: mongoose.mongo.ChangeStreamDocument,
): Array<{ field: string; from: string | null; to: string | null }> {
  if (change.operationType !== 'update') return [];

  const before = 'fullDocumentBeforeChange' in change ? change.fullDocumentBeforeChange : null;
  const updated = change.updateDescription?.updatedFields ?? {};
  const removed = change.updateDescription?.removedFields ?? [];

  const rows: Array<{ field: string; from: string | null; to: string | null }> = [];

  for (const [field, value] of Object.entries(updated)) {
    if (IGNORED_FIELDS.has(field.split('.')[0] ?? field)) continue;

    rows.push({
      field,
      from: before ? stringify((before as Record<string, unknown>)[field]) : null,
      to: stringify(value),
    });
  }

  for (const field of removed) {
    if (IGNORED_FIELDS.has(field)) continue;

    rows.push({
      field,
      from: before ? stringify((before as Record<string, unknown>)[field]) : null,
      to: null,
    });
  }

  return rows;
}

/** "Job #61402" where the document says so; the id otherwise. */
function describeLabel(
  change: mongoose.mongo.ChangeStreamDocument,
  kind: string,
  entityId: string,
): string {
  const document =
    'fullDocument' in change && change.fullDocument
      ? (change.fullDocument as Record<string, unknown>)
      : 'fullDocumentBeforeChange' in change && change.fullDocumentBeforeChange
        ? (change.fullDocumentBeforeChange as Record<string, unknown>)
        : null;

  if (!document) return `${kind} ${entityId}`;

  if (typeof document.jobNumber === 'number') return `Job #${String(document.jobNumber)}`;
  if (typeof document.invoiceNumber === 'number') {
    return `Invoice ${String(document.invoiceNumber)}`;
  }
  if (typeof document.name === 'string' && document.name) return document.name;
  if (typeof document.rego === 'string' && document.rego) return document.rego;
  if (typeof document.description === 'string' && document.description) {
    return document.description;
  }

  return `${kind} ${entityId}`;
}

/*
 * The same renderer the application path uses. Shared deliberately: the log must
 * not show a field one way when a service recorded it and another way when the
 * backstop did.
 */
const stringify = renderAuditValue;
