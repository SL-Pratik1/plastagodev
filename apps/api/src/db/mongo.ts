import type { Db, MongoClient } from 'mongodb';
import mongoose from 'mongoose';
import { env, requireDatabase } from '../config/env.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'mongo' });

/**
 * Mongo connection.
 *
 * ⚠️ Two structural rules from §6A.3 that this file exists to support:
 *
 *  #5  Only the repository layer may touch Mongoose. Referential integrity now
 *      lives in application code, so it must live in exactly one place.
 *  #1  Every monetary field is `Decimal128`, never `double`. Mongoose will
 *      happily store a JS number as a double — the schema is the only guard.
 *
 * `strictQuery` is on so a typo in a filter key throws instead of silently
 * matching every document.
 */
mongoose.set('strictQuery', true);

export async function connectMongo(): Promise<void> {
  mongoose.connection.on('connected', () => log.info('connected'));
  mongoose.connection.on('disconnected', () => log.warn('disconnected'));
  mongoose.connection.on('error', (error: unknown) =>
    log.error({ err: error }, 'connection error'),
  );

  try {
    await mongoose.connect(env.MONGODB_URI, {
      ...(env.MONGODB_DB_NAME ? { dbName: env.MONGODB_DB_NAME } : {}),
      serverSelectionTimeoutMS: 5_000,
      // Transactions around invoice generation need a genuine replica set
      // (§6A.3 #3) — Atlas provides one; a standalone local mongod does not.
      retryWrites: true,
    });
  } catch (error) {
    if (requireDatabase) {
      log.fatal({ err: error }, 'could not reach MongoDB — refusing to start');
      throw error;
    }
    log.warn(
      { err: error, uri: redactUri(env.MONGODB_URI) },
      'could not reach MongoDB. Continuing without it because NODE_ENV is not production — ' +
        '/readyz will report degraded.',
    );
  }
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.connection.close(false);
}

export function isMongoConnected(): boolean {
  return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
}

/**
 * The native driver handles, borrowed from the Mongoose connection.
 *
 * ── Why borrow rather than open a second client ─────────────────────────────
 * Better Auth speaks to the native driver, not to Mongoose. Giving it its own
 * `MongoClient` would mean two connection pools, two sets of retry semantics,
 * and two things to close on shutdown — and, worse, writes to the SAME `users`
 * collection through two independent clients. One pool, one lifecycle.
 *
 * These are the only two functions permitted to reach past Mongoose, and they
 * exist for that single integration. Domain code uses models (§6A.3 #5).
 */
export function getMongoDb(): Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB is not connected — call connectMongo() first');
  return db;
}

export function getMongoClient(): MongoClient {
  if (!isMongoConnected()) {
    throw new Error('MongoDB is not connected — call connectMongo() first');
  }
  return mongoose.connection.getClient();
}

/**
 * Whether this deployment can run multi-document transactions (§6A.3 #3).
 *
 * Detected rather than configured: a standalone `mongod` reports no replica set
 * name, and asking it for a session throws at the moment it matters. Atlas and
 * a local replica set both report one. Cached because it cannot change without
 * a reconnect, and because this runs on the sign-in path.
 *
 * ⚠️ Invoicing MUST NOT be built against a topology where this is false.
 */
let transactionSupport: boolean | undefined;

export async function supportsTransactions(): Promise<boolean> {
  if (transactionSupport !== undefined) return transactionSupport;
  if (!isMongoConnected()) return false;

  try {
    const hello = await getMongoDb().admin().command({ hello: 1 });
    // `setName` on a replica set; `msg: 'isdbgrid'` on a sharded cluster.
    transactionSupport =
      typeof hello.setName === 'string' || hello.msg === 'isdbgrid';
  } catch (error) {
    log.warn({ err: error }, 'could not determine transaction support — assuming none');
    transactionSupport = false;
  }

  if (!transactionSupport) {
    log.warn(
      'MongoDB is standalone: multi-document transactions are unavailable (§6A.3 #3). ' +
        'Fine for auth; move to Atlas or a local replica set before building invoicing.',
    );
  }

  return transactionSupport;
}

/** Round-trips a `ping` so readiness reflects reality, not just socket state. */
export async function pingMongo(): Promise<number> {
  const startedAt = performance.now();
  const admin = mongoose.connection.db?.admin();
  if (!admin) throw new Error('No active MongoDB connection');
  await admin.command({ ping: 1 });
  return Math.round(performance.now() - startedAt);
}

function redactUri(uri: string): string {
  return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:[redacted]@');
}
