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
