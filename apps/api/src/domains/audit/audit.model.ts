import { AUDIT_ACTIONS, AUDIT_ENTITIES, ROLES } from '@plastago/shared';
import { Schema, model } from 'mongoose';

export const AUDIT_ENTRIES_COLLECTION = 'auditentries';

/**
 * The audit log (M1.6) — "who changed what, when, from what value to what
 * value, immutable".
 *
 * ── The problem it solves ─────────────────────────────────────────────────
 * A shared mailbox and a shared page password mean there is currently zero
 * accountability, so *"who changed job 61402's ready date from 12 Aug to 19
 * Aug?"* cannot be answered at all. Every field below exists to make that one
 * question answerable in a single row: the actor, the timestamp, the entity,
 * and the before/after of each field that moved.
 *
 * ── Why this is not `jobevents` ───────────────────────────────────────────
 * `jobevents` is a job's own story, shown on the job and useful to the customer
 * — "arrived 8:42, completed 9:30". This is the opposite: a cross-cutting record
 * of who touched WHAT, spanning jobs, users, invoices, settings and sign-ins,
 * read by an administrator asking an accountability question. Folding the two
 * together would put "signed in from an unknown device" on a customer's job
 * timeline.
 *
 * ⚠️ APPEND-ONLY. Enforced three ways, deliberately overlapping:
 *   1. the repository exposes no update or delete;
 *   2. the middleware at the bottom of this file throws on every mutating
 *      Mongoose operation, so a future service cannot quietly add one;
 *   3. in production the application's database user is granted `insert` and
 *      `find` on this collection and nothing else — the only one of the three a
 *      compromised process cannot talk its way past.
 *
 * An audit log you can edit is not an audit log.
 */

/** One field's before/after. `null` on either side means absent, not empty. */
const auditChangeSchema = new Schema(
  {
    field: { type: String, required: true, trim: true },
    /*
     * Stored as strings, not as the original types. A `from` of `null` must mean
     * "the field was not set", and a Decimal128 or a Date read back as its own
     * type would render differently here than it does on the screen the change
     * was made on. The log has to show what the user saw.
     */
    from: { type: String, default: null },
    to: { type: String, default: null },
  },
  { _id: false },
);

const auditEntrySchema = new Schema(
  {
    /**
     * When the thing happened — not when the row was written.
     *
     * They differ for the change-stream backstop, which notices a change after
     * the fact, and an audit log that reports its own write time would put
     * events in the wrong order on exactly the occasions that matter.
     */
    at: { type: Date, required: true, default: Date.now },

    /** REFERENCE → `user._id`. Null for a system-generated change (M6.6). */
    actorId: { type: Schema.Types.ObjectId, default: null, ref: 'User' },
    /*
     * ⚠️ A FROZEN COPY, and one of the few deliberate ones. The audit log must
     * still read correctly after somebody is renamed or offboarded — the entry
     * records who did it at the time, which is not the same as who that user id
     * belongs to today. Joining live would rewrite history every time HR does.
     */
    actorName: { type: String, required: true, trim: true },
    actorRole: { type: String, enum: [...ROLES, null], default: null },

    action: { type: String, required: true, enum: AUDIT_ACTIONS },
    entity: { type: String, required: true, enum: AUDIT_ENTITIES },
    /** Null for entities that have no row — a failed sign-in, a settings blob. */
    entityId: { type: Schema.Types.ObjectId, default: null },
    /** Human-readable handle — "Job #61402", "iPlasta Pty Ltd". Also frozen. */
    entityLabel: { type: String, required: true, trim: true },

    summary: { type: String, required: true, trim: true },
    changes: { type: [auditChangeSchema], required: true, default: [] },

    /** Where the record lives now, for a deep link. Empty when it is gone. */
    href: { type: String, required: true, default: '' },
    /** §9 — the device is the only clue on a suspicious sign-in. */
    device: { type: String, default: null, trim: true },

    /**
     * How this entry came to exist. Not on the wire — the contract froze at day
     * 3 — but load-bearing for diagnosis.
     *
     * `application` is a deliberate record written by a service that knew who
     * the actor was. `change-stream` is the backstop below noticing a write
     * nobody claimed, which is either a script, a manual database edit, or a
     * service that forgot to record. Being able to ask "how much of my audit log
     * is unattributed?" is the difference between trusting it and hoping.
     */
    source: {
      type: String,
      required: true,
      enum: ['application', 'change-stream'],
      default: 'application',
    },
  },
  {
    collection: AUDIT_ENTRIES_COLLECTION,
    /*
     * ⚠️ No `timestamps`. `updatedAt` on a row that can never be updated is a
     * field that can only ever lie, and `createdAt` would duplicate `at` while
     * disagreeing with it for backstop entries.
     */
    timestamps: false,
    versionKey: false,
    // Nothing may be added by a caller that this schema did not declare.
    strict: 'throw',
  },
);

/*
 * ── Indexes ───────────────────────────────────────────────────────────────
 * Four, matching the four ways the screen is actually read.
 *
 * ⚠️ There is NO TTL index here and there must never be one. §6A.2 commits to
 * seven-year retention, and a TTL index is a delete the collection performs on
 * itself — the exact thing "immutable" rules out.
 */

/** The default view: everything, newest first. */
auditEntrySchema.index({ at: -1 }, { name: 'recent' });

/** "What has happened to job 61402?" — the question M1.6 is written around. */
auditEntrySchema.index({ entity: 1, entityId: 1, at: -1 }, { name: 'entity_history' });

/** "What has Priya done?" — the other half of accountability. */
auditEntrySchema.index({ actorId: 1, at: -1 }, { name: 'actor_history' });

/** The action facet, and the §9 login audit read as `action: 'signed-in'`. */
auditEntrySchema.index({ action: 1, at: -1 }, { name: 'action_history' });

/*
 * ── Append-only, enforced in code ─────────────────────────────────────────
 *
 * Mongoose middleware cannot stop a raw driver call, which is why the real
 * guarantee is the database grant described at the top of this file. What this
 * DOES stop is the likelier failure by far: a future service, in a hurry,
 * "correcting" an audit entry — because that path now throws in development
 * rather than succeeding quietly in production.
 */
function refuseMutation(operation: string): never {
  throw new Error(
    `The audit log is append-only — \`${operation}\` is not permitted on ` +
      `${AUDIT_ENTRIES_COLLECTION}. If an entry is wrong, append a correcting ` +
      `entry; do not rewrite the record (M1.6).`,
  );
}

/**
 * Every mutating query operation, matched by name:
 * `updateOne`/`updateMany`, `replaceOne`, `deleteOne`/`deleteMany`, and the
 * whole `findOneAnd*` family.
 *
 * A regex rather than a list because the list is the thing that goes stale — a
 * Mongoose release adding one more mutating helper would slip straight through
 * an enumeration, and silently.
 */
auditEntrySchema.pre(/^(update|replace|delete|findOneAnd)/, function () {
  refuseMutation(operationNameOf(this));
});

/**
 * The operation's name, for the error message.
 *
 * Read defensively because a regex hook's `this` is a union — Mongoose types it
 * as either a Query or a Document depending on which hook matched, and only the
 * Query half carries `op`. The name is a nicety in an error message; failing to
 * find it must not stop the refusal itself.
 */
function operationNameOf(context: unknown): string {
  if (typeof context === 'object' && context !== null && 'op' in context) {
    const { op } = context as { op?: unknown };
    if (typeof op === 'string') return op;
  }

  return 'a mutating operation';
}

/**
 * `save()` on an existing document is an update wearing a different name.
 *
 * ⚠️ No `next` parameter. Mongoose treats a hook that DECLARES one as
 * callback-style and hands it a callback only in that style — declaring `next`
 * and then calling it here threw `next is not a function` on every insert,
 * which meant every audit write failed. The service swallows write failures by
 * design, so the symptom would have been an empty audit log in production and
 * no error anywhere a person looks. Caught by the integration test beside this
 * file; keep this hook promise-style.
 */
auditEntrySchema.pre('save', function () {
  if (!this.isNew) refuseMutation('save (on an existing entry)');
});

export const AuditEntryModel = model('AuditEntry', auditEntrySchema);
