import { isAustralianMobile, normaliseMobile } from '@plastago/shared';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ script: 'migrate-supervisor-mobiles' });

/**
 * Rewrites login mobiles into the form sign-in looks them up in.
 *
 * ── Why this is needed ────────────────────────────────────────────────────
 * Site supervisors provisioned from a purchase order were saved with the number
 * AS PRINTED — "0427 821 430". Sign-in normalises what is typed to
 * "0427821430" and matches exactly, so those logins could never be signed in
 * to, and the next order printing the number without spaces created the same
 * person a second login. Provisioning now stores the normalised form; this
 * fixes the rows written before it did.
 *
 * ── What it will not do ───────────────────────────────────────────────────
 * Merge people. Where the normalised number already belongs to another login,
 * both are PRINTED and neither is touched: which one owns the jobs, the account
 * and the sign-in history is a decision for a person, and a unique clash
 * written by a script is how somebody loses access to their own jobs.
 *
 * Safe to run repeatedly — an already-normalised number is left alone.
 *
 *     npm run migrate:supervisor-mobiles --workspace=@plastago/api -- --dry-run
 *     npm run migrate:supervisor-mobiles --workspace=@plastago/api
 */
async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });
  log.info({ db: mongoose.connection.db?.databaseName, dryRun }, 'connected');

  const users = mongoose.connection.db!.collection<{
    _id: mongoose.Types.ObjectId;
    name?: string;
    phoneNumber?: string | null;
  }>('users');

  // Anything carrying a character sign-in would strip, or the +61 form.
  const pending = await users
    .find({ phoneNumber: { $regex: /[\s()-]|^\+?61/ } }, { projection: { name: 1, phoneNumber: 1 } })
    .toArray();

  let fixed = 0;
  const clashes: string[] = [];
  const unusable: string[] = [];

  for (const user of pending) {
    const printed = user.phoneNumber ?? '';
    const normalised = normaliseMobile(printed);

    if (!isAustralianMobile(normalised)) {
      unusable.push(`${user._id.toHexString()} ${user.name ?? ''} "${printed}"`);
      continue;
    }

    const owner = await users.findOne(
      { phoneNumber: normalised, _id: { $ne: user._id } },
      { projection: { name: 1 } },
    );
    if (owner) {
      clashes.push(
        `${user._id.toHexString()} ${user.name ?? ''} "${printed}"  ↔  ${owner._id.toHexString()} ${owner.name ?? ''} "${normalised}"`,
      );
      continue;
    }

    if (!dryRun) {
      await users.updateOne({ _id: user._id }, { $set: { phoneNumber: normalised } });
    }
    fixed++;
  }

  log.info(
    { candidates: pending.length, fixed, clashes: clashes.length, unusable: unusable.length, dryRun },
    dryRun ? 'dry run — nothing written' : 'mobiles normalised',
  );

  // Printed rather than logged: these are the rows a person has to decide about.
  if (clashes.length > 0) {
    console.warn(`\nSame person, two logins — merge by hand, then re-run:\n  ${clashes.join('\n  ')}`);
  }
  if (unusable.length > 0) {
    console.warn(`\nNot an Australian mobile, left as it is:\n  ${unusable.join('\n  ')}`);
  }
}

await main()
  .catch((error: unknown) => {
    log.error({ err: error }, 'migrate-supervisor-mobiles failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
