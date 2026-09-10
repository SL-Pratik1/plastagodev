import mongoose from 'mongoose';
import { connectMongo, disconnectMongo, isMongoConnected } from '../db/mongo.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'seed-reset' });

/**
 * Empties the database so a seed run starts from nothing.
 *
 * ── Why this is its own script ─────────────────────────────────────────────
 * `seed-auth` and `seed-settings` upsert, which is right for them: re-running
 * either must not duplicate anyone or reset a counter. But upserting cannot
 * remove what is no longer wanted, and a demo database that has been poked at
 * by hand for a fortnight is mostly rows nobody meant to keep. Wiping is a
 * separate decision from seeding, so it is a separate command — you have to ask
 * for it.
 *
 * ⚠️ This DELETES EVERYTHING, sessions included, so everyone signed in is
 * signed out and has to request a fresh code. Refuses to run against
 * production, where that sentence is the whole argument against it.
 *
 * Collections are dropped one at a time rather than `dropDatabase()`, because
 * dropping the database on Atlas needs a privilege the application user does
 * not have — and quietly needing an admin connection is how a script works
 * locally and fails in the one place it matters.
 *
 *   npm --workspace @plastago/api run seed:reset
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-reset refuses to run with NODE_ENV=production');
  }

  await connectMongo();
  if (!isMongoConnected()) {
    throw new Error('Could not reach MongoDB — is it running?');
  }

  const { db } = mongoose.connection;
  if (!db) throw new Error('no database handle on the connection');

  const collections = await db.listCollections().toArray();
  const names = collections
    .map((collection) => collection.name)
    // Mongo's own bookkeeping is not ours to drop.
    .filter((name) => !name.startsWith('system.'))
    .sort();

  let dropped = 0;
  for (const name of names) {
    // `drop` takes the indexes and any schema validator with it, which is what
    // we want: the seeders reinstate both, and a stale validator left behind
    // rejects the very documents the new seed is trying to write.
    await db.collection(name).drop();
    dropped += 1;
    log.debug({ collection: name }, 'dropped');
  }

  log.info({ collections: dropped, database: mongoose.connection.name }, 'database emptied');

  // eslint-disable-next-line no-console
  console.log(
    `\nDropped ${String(dropped)} collections from "${mongoose.connection.name}".\n` +
      `Everyone signed in has been signed out — sign in again to get a fresh session.\n`,
  );
}

await main()
  .catch((error: unknown) => {
    log.fatal({ err: error }, 'reset failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectMongo();
  });
