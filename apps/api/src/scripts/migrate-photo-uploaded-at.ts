import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { JobPhotoModel } from '../domains/jobs/job.model.js';
import { getStorage } from '../integrations/storage.js';

const log = logger.child({ script: 'migrate-photo-uploaded-at' });

/**
 * Backfill `jobphotos.uploadedAt` for photos taken before the field existed.
 *
 * ── Why this is needed ────────────────────────────────────────────────────
 * `uploaded` used to be derived from `storageKey !== null`. That key is
 * assigned while the upload URL is being SIGNED, before a single byte exists,
 * so every photo claimed to be safely uploaded from the instant it was
 * registered — including ones whose PUT never happened.
 *
 * The honest version is `uploadedAt`, set by the phone once its PUT returns.
 * But every photo already in the database predates that field and would read as
 * "still sending" forever, with no thumbnail, which is the opposite lie.
 *
 * ── Why it asks the bucket rather than assuming ───────────────────────────
 * The whole point of the change is to stop inferring upload state from the
 * record. Defaulting the backfill to "these are all fine" would write the old
 * assumption into the data permanently, where no later fix could tell a real
 * confirmation from a guess. So each key is checked against storage, and only
 * objects that actually exist are marked.
 *
 * `updatedAt` is used as the timestamp rather than now: it is the closest thing
 * on the record to when the upload happened, and stamping today's date onto a
 * photo taken in March would make the audit trail read as a fabrication.
 *
 * Safe to run repeatedly — only rows with a null `uploadedAt` are considered.
 *
 *     npm run migrate:photo-uploaded-at --workspace=@plastago/api
 */
async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });
  log.info({ db: env.MONGODB_DB_NAME, storage: getStorage().name }, 'connected');

  const pending = await JobPhotoModel.find({
    uploadedAt: null,
    storageKey: { $ne: null },
  })
    .select({ _id: 1, storageKey: 1, updatedAt: 1 })
    .lean<{ _id: mongoose.Types.ObjectId; storageKey: string; updatedAt?: Date }[]>();

  log.info({ candidates: pending.length }, 'photos with a key but no confirmation');

  const storage = getStorage();
  let confirmed = 0;
  let missing = 0;

  for (const photo of pending) {
    /*
     * Sequential on purpose. This runs once, against a bucket, and a burst of
     * parallel HEADs on a large history is the kind of thing that gets an
     * access key rate-limited mid-migration — leaving a half-finished backfill
     * that is indistinguishable from a complete one.
     */
    const exists = await storage.exists(photo.storageKey).catch((error: unknown) => {
      log.warn({ err: error, photoId: photo._id.toHexString() }, 'could not check storage');
      return false;
    });

    if (!exists) {
      missing++;
      continue;
    }

    await JobPhotoModel.updateOne(
      { _id: photo._id, uploadedAt: null },
      { $set: { uploadedAt: photo.updatedAt ?? new Date() } },
    );
    confirmed++;
  }

  /*
   * The gap is worth printing rather than swallowing: these are photo RECORDS
   * with no object behind them, which means a driver was once told a shot was
   * saved when it was not. They will now show as still sending, which is at
   * least true, but somebody should know the evidence is not there.
   */
  log.info({ confirmed, missing }, 'migration complete');
  if (missing > 0) {
    log.warn({ missing }, 'photo records whose bytes never reached storage');
  }

  await mongoose.disconnect();
}

main().catch((error: unknown) => {
  log.error({ err: error }, 'migration failed');
  process.exitCode = 1;
});
