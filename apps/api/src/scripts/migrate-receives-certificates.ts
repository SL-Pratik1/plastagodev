import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { ACCOUNTS_COLLECTION } from '../domains/accounts/account.model.js';
import { CERTIFICATES_COLLECTION } from '../domains/reports/certificate.model.js';

const log = logger.child({ script: 'migrate-receives-certificates' });

/**
 * Sets "Receives certificates" on the accounts that existed before it (21 Oct).
 *
 * Matt: certificates go *"only to certain customers"*. An account with no
 * value reads as NOT ticked — nothing is sent and the portal hides the tab. So
 * a customer who has already been issued a certificate is ticked here, keeping
 * the certificates they have; everyone else is set to not ticked, explicitly.
 *
 * ⚠️ Only where the tick is VALID — m² + kg and a certificate email, the rule
 * the account service enforces. Ticking any other account would leave the
 * office unable to save it until they had changed something unrelated.
 *
 * Only accounts with no value are touched, so it is safe to run twice and
 * never overrides a tick the office set by hand.
 *
 *     npm run migrate:receives-certificates --workspace=@plastago/api
 */
async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });
  log.info({ db: env.MONGODB_DB_NAME }, 'connected');

  const accounts = mongoose.connection.collection(ACCOUNTS_COLLECTION);
  const certificates = mongoose.connection.collection(CERTIFICATES_COLLECTION);

  const issuedTo = (await certificates.distinct('accountId', {
    state: 'issued',
  })) as mongoose.Types.ObjectId[];

  const unset = { receivesCertificates: { $exists: false } };

  const ticked = await accounts.updateMany(
    {
      ...unset,
      _id: { $in: issuedTo },
      captureMode: 'area-and-weight',
      certificateEmail: { $nin: [null, ''] },
    },
    { $set: { receivesCertificates: true } },
  );
  const notTicked = await accounts.updateMany(unset, { $set: { receivesCertificates: false } });

  log.info(
    { ticked: ticked.modifiedCount, notTicked: notTicked.modifiedCount },
    'migration complete',
  );

  await mongoose.disconnect();
}

main().catch((error: unknown) => {
  log.error({ err: error }, 'migration failed');
  process.exitCode = 1;
});
