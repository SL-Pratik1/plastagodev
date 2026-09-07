import mongoose, { type ClientSession } from 'mongoose';
import { supportsTransactions } from '../db/mongo.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'transaction' });

/**
 * Run a multi-document write atomically where the deployment allows it.
 *
 * ── Why this wrapper exists at all ────────────────────────────────────────
 * Reference-based modelling makes almost every create a multi-document write:
 * an account plus its contact plus its terms row. MongoDB enforces no
 * referential integrity, so a crash between those inserts leaves an account
 * whose invoices have nowhere to go — and nothing in the data says it is broken
 * (§6A.3 #3).
 *
 * ── Why it degrades instead of refusing ───────────────────────────────────
 * Transactions need a replica set. Atlas is one; a developer's local `mongod`
 * is not, and requiring every developer to convert theirs before the API will
 * start is a barrier that buys nothing — the correctness that matters is in
 * production, where Atlas provides it.
 *
 * So this takes the real path when it can and a sequential path when it cannot,
 * and it says which at `warn` every single time. The degraded path is not
 * silent, because the one thing worse than no transaction is a team that
 * believes it has one.
 *
 * ⚠️ On the degraded path a failure part-way through leaves earlier writes
 * committed. Callers that create dependent documents must therefore write the
 * PARENT FIRST and pass a `compensate` that removes it — a child with no parent
 * is invisible and harmless; a parent with no children is a visible, fixable
 * record the office can complete by hand.
 */
export async function withTransaction<T>(
  work: (session: ClientSession | undefined) => Promise<T>,
  options?: {
    /**
     * Undo already-committed writes when the degraded path fails part-way.
     *
     * Never called on the transactional path — there the abort does it, and
     * calling both would delete a document the rollback already removed.
     */
    compensate?: () => Promise<void>;
    /** Named in the log line, so a degraded write is traceable to its caller. */
    label?: string;
  },
): Promise<T> {
  const label = options?.label ?? 'unlabelled';

  if (await supportsTransactions()) {
    const session = await mongoose.startSession();
    try {
      let result: T | undefined;
      let assigned = false;

      await session.withTransaction(async () => {
        result = await work(session);
        assigned = true;
      });

      // `withTransaction` can retry its callback, so the flag — not a truthiness
      // check on `result` — is what proves the body ran. A legitimate `null`
      // return would otherwise look like a failure.
      if (!assigned) throw new Error(`Transaction for "${label}" completed without a result`);
      return result as T;
    } finally {
      await session.endSession();
    }
  }

  log.warn(
    { label },
    'writing WITHOUT a transaction — this deployment is standalone. A failure part-way ' +
      'through will leave partial data. Use a replica set or Atlas before production.',
  );

  try {
    // `undefined` rather than a session: passing one to a driver that cannot
    // honour it fails with "retryable writes are not supported", which is the
    // error that sent us down this path in the first place.
    return await work(undefined);
  } catch (error) {
    if (options?.compensate) {
      try {
        await options.compensate();
        log.warn({ label }, 'compensated a partial write after a non-transactional failure');
      } catch (cleanupError) {
        // Logged at `error` and swallowed: the ORIGINAL failure is what the
        // caller needs to see, and a cleanup problem must not replace it.
        log.error(
          { err: cleanupError, label },
          'compensation FAILED — a partial record may remain and needs manual review',
        );
      }
    }
    throw error;
  }
}
