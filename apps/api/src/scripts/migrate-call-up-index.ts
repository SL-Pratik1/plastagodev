import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { CallUpModel } from '../domains/queues/call-up.model.js';

const log = logger.child({ script: 'migrate-call-up-index' });

/**
 * Replace the `sparse` unique index on `callups.externalId` with a partial one.
 *
 * ── The bug this fixes ────────────────────────────────────────────────────
 * The index was declared `sparse`, with a comment saying that was what let the
 * many call-ups with no external id coexist. It is not. `sparse` skips documents
 * where the field is ABSENT; an explicitly stored `null` is a value, and gets
 * indexed like any other. The service writes `externalId: null` for every
 * call-up keyed in by hand or raised from the portal — so the first one took the
 * slot and every one after it failed with a raw duplicate-key error.
 *
 * In practice: the office could book an order "waiting for a date" exactly once.
 * The second attempt, and every one after it, returned a 500 that read
 * "Something went wrong" on screen.
 *
 * ── Why a script ──────────────────────────────────────────────────────────
 * Mongoose creates indexes that are missing; it never alters one that already
 * exists. Changing the schema fixes new environments and does nothing for any
 * database that has already run. So the old index is dropped explicitly, the
 * stored nulls are unset, and `syncIndexes` builds the partial one.
 *
 *     npm run migrate:call-up-index --workspace=@plastago/api
 */
async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });
  log.info({ db: env.MONGODB_DB_NAME }, 'connected');

  const collection = mongoose.connection.collection('callups');

  const existing = await collection.indexes();
  const stale = existing.find((index) => index.name === 'call_up_external_unique');

  if (stale && stale.partialFilterExpression === undefined) {
    await collection.dropIndex('call_up_external_unique');
    log.info('dropped the sparse unique index');
  } else {
    log.info('index is already partial — nothing to drop');
  }

  /*
   * The stored nulls have to go too, or the rebuild indexes them again and
   * fails on the second row. Unset rather than deleted: these are real
   * call-ups, and the field simply does not apply to them.
   */
  const cleared = await collection.updateMany(
    { externalId: null },
    { $unset: { externalId: '' } },
  );
  log.info({ rowsCleared: cleared.modifiedCount }, 'stored nulls unset');

  await CallUpModel.syncIndexes();

  const after = await collection.indexes();
  const rebuilt = after.find((index) => index.name === 'call_up_external_unique');
  log.info(
    { partialFilterExpression: rebuilt?.partialFilterExpression ?? null },
    'migration complete',
  );

  await mongoose.disconnect();
}

main().catch((error: unknown) => {
  log.error({ err: error }, 'migration failed');
  process.exitCode = 1;
});
