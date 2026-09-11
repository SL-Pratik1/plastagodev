import mongoose from 'mongoose';
import { connectMongo, disconnectMongo, isMongoConnected } from '../db/mongo.js';
import { AccountModel } from '../domains/accounts/account.model.js';
import { InvoiceModel } from '../domains/invoices/invoice.model.js';
import {
  InvoiceTemplateModel,
  RateCardModel,
  SETTINGS_SINGLETON_ID,
  SettingsModel,
  ZoneRateModel,
} from '../domains/settings/settings.model.js';
import { startOfSydneyDay } from '../lib/business-day.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'migrate-rate-schedules' });

/**
 * M6.2 — turn one-rate-per-zone into effective-dated rate SCHEDULES.
 *
 * ── Why this migration is not optional ────────────────────────────────────
 * `zonerates` used to carry a unique index on `{rateCardId, zone}`. That is
 * precisely the constraint that made versioning impossible: two rows for
 * "Sydney on Tier 1" could not both exist, so a rate could only ever be
 * overwritten — and overwriting reprices history, because a job is priced by
 * the rates in force on its own date.
 *
 * ⚠️ Mongo does NOT drop an index because a Mongoose schema stopped declaring
 * one. Until `card_zone_unique` is gone, the first "issue a new schedule" on
 * any card fails with E11000 — which surfaces as a 500 on the settings screen,
 * not as anything an administrator could interpret.
 *
 * ── What it does, in order ────────────────────────────────────────────────
 *  1. Backfills `effectiveFrom` on every existing rate row, from its card's own
 *     start date. The rows predate schedules and have no date of their own; the
 *     card's date is the only honest answer, and it is the one the seed used.
 *  2. Backfills `effectiveTo: null` — open-ended, which is what those rows were
 *     implicitly claiming by being the only row for their card and zone.
 *  3. Drops `card_zone_unique`.
 *  4. Builds the three indexes the new model declares, so the first write after
 *     this runs is already protected rather than relying on autoIndex timing.
 *
 * Idempotent: re-running finds nothing to backfill and no index to drop, and
 * says so. Safe to leave in a deploy pipeline.
 *
 *   npm --workspace @plastago/api run migrate:rate-schedules
 */

/** The index that forbade versioning. Its exact name, as Mongoose created it. */
const LEGACY_INDEX = 'card_zone_unique';

async function main(): Promise<void> {
  await connectMongo();
  if (!isMongoConnected()) {
    throw new Error('Could not reach MongoDB — is it running?');
  }

  const collection = ZoneRateModel.collection;

  /* ── 1 & 2 · Backfill the window onto rows that predate it ─────────────── */

  const undated = await ZoneRateModel.countDocuments({ effectiveFrom: { $exists: false } });

  if (undated === 0) {
    log.info('no undated rate rows — backfill already done');
  } else {
    /*
     * Per CARD rather than one blanket date. Cards can legitimately have
     * different start dates, and stamping them all with today would claim
     * every historical rate began this morning — which would then make the
     * back-dating guard refuse a schedule the office is entitled to issue.
     */
    const cards = await RateCardModel.find()
      .select({ effectiveFrom: 1 })
      .lean<Array<{ _id: string; effectiveFrom: Date }>>();

    let stamped = 0;
    for (const card of cards) {
      const result = await ZoneRateModel.updateMany(
        { rateCardId: card._id, effectiveFrom: { $exists: false } },
        {
          $set: {
            // Normalised through `startOfSydneyDay` so a card stored at UTC
            // midnight does not leave its rates starting eleven hours early.
            effectiveFrom: startOfSydneyDay(
              card.effectiveFrom.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }),
            ),
            effectiveTo: null,
          },
        },
      );
      stamped += result.modifiedCount;
    }

    log.info({ stamped, cards: cards.length }, 'backfilled effectiveFrom onto rate rows');

    /*
     * A row whose card no longer exists cannot be dated from anything, and it
     * prices nothing — `resolveRate` looks up by `rateCardId`. Reported rather
     * than deleted: this script does not remove data, and an orphan is a signal
     * that something else went wrong.
     */
    const orphans = await ZoneRateModel.countDocuments({ effectiveFrom: { $exists: false } });
    if (orphans > 0) {
      log.warn(
        { orphans },
        'rate rows reference a card that does not exist — they were left untouched and price nothing',
      );
    }
  }

  /* ── 3 · Drop the index that forbade a second version ──────────────────── */

  const existing = await collection.indexes();
  const legacy = existing.find((index) => index.name === LEGACY_INDEX);

  if (legacy) {
    await collection.dropIndex(LEGACY_INDEX);
    log.info({ index: LEGACY_INDEX }, 'dropped the index that prevented rate versioning');
  } else {
    log.info({ index: LEGACY_INDEX }, 'legacy index already gone');
  }

  /* ── 4 · Build the replacements now, not on first write ────────────────── */

  await ZoneRateModel.syncIndexes();
  const after = await collection.indexes();


  /* ── 5 · Backfill the invoicing fields added for M7.5 ──────────────────── */

  /*
   * ⚠️ Why a backfill is needed for fields that HAVE schema defaults.
   *
   * Mongoose applies a `default` when a DOCUMENT IS CREATED, never when a read
   * finds the path missing — and every settings read is `.lean()`, which hands
   * back the stored document verbatim. So a singleton written before these
   * fields existed returns `undefined` for each of them, `undefined` reaches a
   * `z.string()` on the contract, and the whole settings payload is refused.
   *
   * That is exactly what put "Something went wrong" on the settings screen.
   * The repository now coalesces on read as well, so the screen works either
   * way; this makes the stored data honest so the next person reading the
   * collection is not misled about what a settings document contains.
   */
  const BRANDING_DEFAULTS: Record<string, string> = {
    logoKey: '',
    companyName: '',
    companyAbn: '',
    companyAddress: '',
    companyPhone: '',
    companyEmail: '',
    termsText: '',
    bankAccountName: '',
  };

  const storedSettings = await SettingsModel.findById(SETTINGS_SINGLETON_ID).lean<
    Record<string, unknown>
  >();

  let brandingFilled = 0;

  if (storedSettings) {
    /*
     * ⚠️ Only the ABSENT paths are written.
     *
     * A blanket `$set` of the defaults would erase a company name or a terms
     * paragraph somebody had already typed — turning a migration meant to fix
     * a crash into one that silently empties the letterhead. Re-running has to
     * be a no-op once the fields exist, which is what makes it safe to put in
     * a deploy step.
     */
    const patch = Object.fromEntries(
      Object.entries(BRANDING_DEFAULTS).filter(([field]) => !(field in storedSettings)),
    );

    if (Object.keys(patch).length > 0) {
      await SettingsModel.updateOne({ _id: SETTINGS_SINGLETON_ID }, { $set: patch });
      brandingFilled = Object.keys(patch).length;
    }
  }

  /*
   * Templates gain a layout and an accent colour.
   *
   * The layout is INFERRED rather than defaulted flat: a template that prints
   * kilograms is one whose accounts reconcile against a docket, so it wants
   * the detailed drawing. The RCTI is recognised by its id, because printing
   * an ordinary "Tax Invoice" heading on one makes the document invalid.
   */
  const templates = await InvoiceTemplateModel.find().lean<
    Array<{ _id: string; showsWeight?: boolean; layout?: string; accentColour?: string }>
  >();

  let templatesFilled = 0;

  for (const template of templates) {
    const patch: Record<string, string> = {};

    if (template.layout === undefined) {
      patch.layout = template._id.includes('rcti')
        ? 'rcti'
        : template.showsWeight === true
          ? 'detailed'
          : 'standard';
    }

    if (template.accentColour === undefined) {
      // EasyLift is visibly a different brand; the RCTI is visibly a different
      // DOCUMENT, so nobody files it as an ordinary invoice.
      patch.accentColour = template._id.startsWith('el-')
        ? '#0f5c7a'
        : template._id.includes('rcti')
          ? '#7a4a0f'
          : '#1a4d3a';
    }

    if (Object.keys(patch).length === 0) continue;

    await InvoiceTemplateModel.updateOne({ _id: template._id }, { $set: patch });
    templatesFilled += 1;
  }

  /*
   * Accounts gain `invoiceTemplateId: null`.
   *
   * Explicitly null rather than absent, because null MEANS something here —
   * "follow the brand" — and the render path branches on it. Narrowed to
   * documents where the path is missing, so an assignment already made is
   * never cleared.
   */
  const accountsResult = await AccountModel.updateMany(
    { invoiceTemplateId: { $exists: false } },
    { $set: { invoiceTemplateId: null } },
  );

  /* Invoices gain `pdfKey: null` — "no PDF rendered yet". */
  const invoicesResult = await InvoiceModel.updateMany(
    { pdfKey: { $exists: false } },
    { $set: { pdfKey: null, templateId: null, pdfRenderedAt: null } },
  );

  log.info(
    {
      brandingFilled,
      templatesFilled,
      accountsFilled: accountsResult.modifiedCount,
      invoicesFilled: invoicesResult.modifiedCount,
    },
    'invoicing fields backfilled',
  );

  log.info('migration complete');

  // eslint-disable-next-line no-console
  console.log(`
Migrated "${mongoose.connection.name}".

  Pricing (M6.2)
    Rate rows backfilled   ${String(undated)}
    Legacy index           ${legacy ? 'dropped' : 'already absent'}
    Indexes now            ${after.map((index) => index.name ?? '?').join(', ')}

  Invoicing (M7.5)
    Branding fields added  ${String(brandingFilled)}
    Templates dated        ${String(templatesFilled)}
    Accounts touched       ${String(accountsResult.modifiedCount)}
    Invoices touched       ${String(invoicesResult.modifiedCount)}

Rates are effective-dated from here: issuing a schedule adds a dated version
and closes the previous one. Nothing already priced can move.
`);
}

await main()
  .catch((error: unknown) => {
    log.fatal({ err: error }, 'migration failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectMongo();
  });
