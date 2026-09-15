import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { PoExtractionModel } from '../domains/queues/purchase-order.model.js';

const log = logger.child({ script: 'migrate-po-review-reasons' });

/**
 * Retire `below-threshold`, and the confidence scores it was derived from.
 *
 * ── Why the reason had to go ──────────────────────────────────────────────
 * It rendered as "Low OCR confidence" — the one reason on the review screen a
 * person could do nothing with. It described the model's opinion of itself, not
 * the document in front of them, and a high score invited waving an order
 * through without opening the PDF. Every extraction was always read by a human
 * (nothing ever auto-accepted); the score only decided which label the row wore.
 *
 * So the reason becomes `awaiting-check` — "nobody has read this yet", which is
 * both true and actionable — and the scores are dropped from the documents.
 *
 * ── Why this is a script and not a migration framework ────────────────────
 * There is no migration runner in this project, and one collection with one
 * enum value is not the thing to introduce one for. It is idempotent: running
 * it twice changes nothing the second time.
 *
 *     npm run migrate:po-review-reasons --workspace=@plastago/api
 */
async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });
  log.info({ db: env.MONGODB_DB_NAME }, 'connected');

  /*
   * Cast, because the whole point is to match a value the enum no longer has:
   * `below-threshold` is gone from `PO_REVIEW_REASONS`, so a typed filter cannot
   * name the rows this script exists to find.
   */
  const reasons = await PoExtractionModel.updateMany(
    { reason: 'below-threshold' } as Record<string, unknown>,
    { $set: { reason: 'awaiting-check' } },
  );

  /*
   * `$unset` across the three places a score was stored. The nested ones need
   * the positional-all operator: they live inside arrays.
   */
  const scores = await PoExtractionModel.updateMany(
    {
      $or: [
        { overallConfidence: { $exists: true } },
        { 'fields.confidence': { $exists: true } },
        { 'accountCandidates.confidence': { $exists: true } },
        { 'jobCandidates.confidence': { $exists: true } },
      ],
    },
    {
      $unset: {
        overallConfidence: '',
        'fields.$[].confidence': '',
        'accountCandidates.$[].confidence': '',
        'jobCandidates.$[].confidence': '',
      },
    },
  );

  log.info(
    {
      reasonsRewritten: reasons.modifiedCount,
      documentsStrippedOfScores: scores.modifiedCount,
    },
    'migration complete',
  );

  await mongoose.disconnect();
}

main().catch((error: unknown) => {
  log.error({ err: error }, 'migration failed');
  process.exitCode = 1;
});
