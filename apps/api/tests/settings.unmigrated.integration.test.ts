import { SettingsSchema } from '@plastago/shared';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  InvoiceTemplateModel,
  RateCardModel,
  SETTINGS_SINGLETON_ID,
  SettingsModel,
  ZoneRateModel,
} from '../src/domains/settings/settings.model.js';
import { settingsRepository } from '../src/domains/settings/settings.repository.js';

/**
 * Reading settings out of a database that predates the fields (M6.2, M7.5).
 *
 * ── Why this one has to be an integration test ────────────────────────────
 * The bug it exists for lived entirely in Mongoose's read semantics, and no
 * fake could reproduce it.
 *
 * ⚠️ **`.lean()` does not apply schema defaults.** Mongoose fills a `default`
 * when a DOCUMENT IS CREATED; a lean read hands back the stored document
 * verbatim. So every field added to the settings singleton after it was first
 * written comes back `undefined` — not as its default — and `undefined`
 * reaching a `z.string()` fails `SettingsSchema` for the WHOLE payload.
 *
 * The symptom was not a missing colour swatch. It was the settings screen
 * showing "Something went wrong" with no way to reach any tab, because one
 * absent optional field took the entire contract down.
 *
 * The migration backfills these, but the read must tolerate an unmigrated
 * database too: a deploy where the migration has not run yet must degrade to a
 * plainer invoice, not to a dead screen.
 *
 * Skips itself when Mongo is unreachable, so the suite still runs on a machine
 * with no database rather than failing for the wrong reason.
 */

const MONGO_URL = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const TEST_DB = 'plastago_unmigrated_test';

let reachable = false;

beforeAll(async () => {
  try {
    // `dbName`, not a path segment: MONGODB_URI may already name a database,
    // and appending one builds an invalid namespace rather than overriding it.
    // It also pins `dropDatabase()` below to the TEST database, whatever the
    // environment points at.
    await mongoose.connect(MONGO_URL, { dbName: TEST_DB, serverSelectionTimeoutMS: 2000 });
    reachable = true;
  } catch {
    reachable = false;
  }
});

afterAll(async () => {
  if (reachable) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

beforeEach(async () => {
  if (!reachable) return;

  await Promise.all([
    SettingsModel.deleteMany({}),
    RateCardModel.deleteMany({}),
    ZoneRateModel.deleteMany({}),
    InvoiceTemplateModel.deleteMany({}),
  ]);
});

/**
 * Write the settings singleton EXACTLY as it looked before M7.5.
 *
 * ⚠️ Inserted through the raw driver, not through `SettingsModel.create`.
 * Creating a Mongoose document would apply every current default and store the
 * new fields — which is precisely the state this test needs to NOT be in.
 */
async function insertPreM7Settings(): Promise<void> {
  await mongoose.connection.collection('settings').insertOne({
    _id: SETTINGS_SINGLETON_ID as unknown as mongoose.Types.ObjectId,
    slaBusinessDays: 5,
    nextJobNumber: 61_300,
    nextInvoiceNumber: 104_100,
    nextRunNumber: 1,
    splitAdditionalCharges: true,
    defaultPaymentTermsDays: 7,
    invoiceNumberPrefix: '',
    footerText: '',
    bankBsb: '',
    bankAccount: '',
    showGbcaBadge: false,
    assumedCostPerJob: mongoose.Types.Decimal128.fromString('100.00'),
    // Deliberately absent: logoKey, companyName, companyAbn, companyAddress,
    // companyPhone, companyEmail, termsText, bankAccountName.
  });
}

/** A template row as it looked before it carried a layout or a colour. */
async function insertPreM7Template(): Promise<void> {
  await mongoose.connection.collection('invoicetemplates').insertOne({
    _id: 'pg-m2' as unknown as mongoose.Types.ObjectId,
    name: 'PlastaGo Recycling Invoice (m²)',
    brandId: 'plastago',
    showsWeight: false,
    // Deliberately absent: layout, accentColour.
  });
}

describe('reading settings from a database the migration has not touched', () => {
  it('returns a payload the contract accepts', async () => {
    if (!reachable) return;

    await insertPreM7Settings();
    await insertPreM7Template();

    const settings = await settingsRepository.get();

    /*
     * The whole point. Before the read coalesced, this threw — and the screen
     * had no way to render anything at all.
     */
    expect(() => SettingsSchema.parse(settings)).not.toThrow();
  });

  it('reads an absent branding field as empty, not undefined', async () => {
    if (!reachable) return;

    await insertPreM7Settings();
    const settings = await settingsRepository.get();

    // Empty is the right answer as well as the safe one: the renderer omits an
    // empty field from the page rather than printing a placeholder.
    expect(settings.invoicing.companyName).toBe('');
    expect(settings.invoicing.companyAbn).toBe('');
    expect(settings.invoicing.bankAccountName).toBe('');
    expect(settings.invoicing.termsText).toBe('');
    expect(settings.invoicing.logoKey).toBe('');
  });

  it('gives an undated template a layout and a colour it can render with', async () => {
    if (!reachable) return;

    await insertPreM7Settings();
    await insertPreM7Template();

    const settings = await settingsRepository.get();
    const [template] = settings.invoicing.templates;

    // `undefined` here would fail the layout enum and the hex colour both.
    expect(template?.layout).toBe('standard');
    expect(template?.accentColour).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('does not invent values a later save would then have to undo', async () => {
    if (!reachable) return;

    /*
     * A coalesced read must not write anything back. If it did, an
     * administrator opening the screen would silently persist eight empty
     * strings — and a later `$setOnInsert` in the seed would then skip fields
     * it should have filled.
     */
    await insertPreM7Settings();
    await settingsRepository.get();

    const stored = await mongoose.connection
      .collection('settings')
      .findOne({ _id: SETTINGS_SINGLETON_ID as unknown as mongoose.Types.ObjectId });

    expect(stored && 'companyName' in stored).toBe(false);
  });
});

describe('pricing from a database the migration has not touched', () => {
  it('prices nothing for an undated rate row, rather than pricing it wrongly', async () => {
    if (!reachable) return;

    await insertPreM7Settings();
    await RateCardModel.create({
      _id: 'tier-1',
      label: 'Tier 1',
      effectiveFrom: new Date('2026-04-01T00:00:00.000Z'),
      effectiveTo: null,
    });

    /*
     * ⚠️ A rate row with no `effectiveFrom`, written before schedules existed.
     *
     * `findRateOn` filters on `effectiveFrom: { $lte: at }`, and Mongo matches
     * nothing when the path is absent — so this row prices NOTHING until the
     * migration dates it.
     *
     * That is the correct failure: refusing to price is a booking the office
     * can see fail, whereas guessing a date would silently apply rates nobody
     * had agreed on that day. This test exists so the behaviour is a stated
     * decision rather than an accident of a query.
     */
    const zoneId = new mongoose.Types.ObjectId();

    await mongoose.connection.collection('zonerates').insertOne({
      rateCardId: 'tier-1',
      zoneId,
      serviceCharge: mongoose.Types.Decimal128.fromString('220.00'),
      ratePerM2: mongoose.Types.Decimal128.fromString('0.16'),
    });

    await expect(
      settingsRepository.resolveRate('tier-1', zoneId.toString(), '2026-09-11'),
    ).resolves.toBeNull();
  });

  /**
   * A zone id that is not an id at all.
   *
   * ⚠️ The same class of unmigrated state as the row above, one layer out: a
   * caller holding the OLD slug — a stale tab, a replayed request, a bookmark
   * from before zones were records. Mongoose casts the value into the query and
   * `new ObjectId('sydney')` throws, so without a guard this surfaced as a 500.
   *
   * Null is the honest answer, and it becomes the 503 that names the problem:
   * "no rate is configured", which the office can act on.
   */
  it('prices nothing for a zone id that is not an id, rather than throwing', async () => {
    if (!reachable) return;

    await expect(
      settingsRepository.resolveRate('tier-1', 'sydney', '2026-09-11'),
    ).resolves.toBeNull();
  });
});
