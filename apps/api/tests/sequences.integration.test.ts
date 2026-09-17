import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SEQUENCE_STARTS,
  SETTINGS_SINGLETON_ID,
  SettingsModel,
} from '../src/domains/settings/settings.model.js';
import { settingsRepository } from '../src/domains/settings/settings.repository.js';

/**
 * Number sequences, against a REAL MongoDB (M1.4).
 *
 * ── Why this one is an integration test ───────────────────────────────────
 * Every other suite runs against fake repositories, which is right for business
 * rules — but the bug this file exists for lived entirely in the database
 * operation. A fake `takeNextNumber` returns whatever it is told to; only real
 * Mongo reproduces what `$inc` does to a field that is not there.
 *
 * That bug: adding a new sequence to a settings document that already existed
 * made the first allocation throw AND silently restart the sequence at 1.
 * Harmless for run numbers. For invoices it is the thing M1.4 forbids outright —
 * three years of numbers are quoted in builders' AP systems.
 *
 * Skips itself when Mongo is not reachable, so the suite still runs on a machine
 * with no database rather than failing for the wrong reason.
 */

const MONGO_URL = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const TEST_DB = 'plastago_sequences_test';

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
  if (reachable) await SettingsModel.deleteMany({});
});

/** A settings document written the way a real deployment has one. */
async function seedSettings(overrides: Record<string, unknown> = {}): Promise<void> {
  await SettingsModel.create({
    _id: SETTINGS_SINGLETON_ID,
    assumedCostPerJob: mongoose.Types.Decimal128.fromString('120.00'),
    ...overrides,
  });
}

describe.runIf(process.env.SKIP_INTEGRATION !== '1')('number sequences', () => {
  it('hands out consecutive numbers and never repeats one', async () => {
    if (!reachable) return;
    await seedSettings();

    const first = await settingsRepository.takeNextNumber('nextJobNumber');
    const second = await settingsRepository.takeNextNumber('nextJobNumber');

    expect(first).toBe(SEQUENCE_STARTS.nextJobNumber);
    expect(second).toBe(SEQUENCE_STARTS.nextJobNumber + 1);
  });

  /*
   * The point of the atomic allocation. Twenty simultaneous bookings must get
   * twenty different numbers — a read-then-write would hand duplicates out here.
   */
  it('never hands the same number to two simultaneous callers', async () => {
    if (!reachable) return;
    await seedSettings();

    const numbers = await Promise.all(
      Array.from({ length: 20 }, () => settingsRepository.takeNextNumber('nextInvoiceNumber')),
    );

    expect(new Set(numbers).size).toBe(20);
    expect(Math.min(...numbers)).toBe(SEQUENCE_STARTS.nextInvoiceNumber);
    expect(Math.max(...numbers)).toBe(SEQUENCE_STARTS.nextInvoiceNumber + 19);
  });

  describe('a sequence added to a document that already exists', () => {
    /*
     * ⚠️ The regression. Reproduced exactly as it happened in QA: the settings
     * document predates the field, so `$inc` has nothing to increment.
     */
    it('starts a brand-new sequence at its declared start, not at 1', async () => {
      if (!reachable) return;
      await seedSettings();
      // Strip the field, so the stored document is one written before the
      // sequence was added to the schema.
      await SettingsModel.updateOne(
        { _id: SETTINGS_SINGLETON_ID },
        { $unset: { nextRunNumber: 1 } },
      );

      const allocated = await settingsRepository.takeNextNumber('nextRunNumber');

      expect(allocated).toBe(SEQUENCE_STARTS.nextRunNumber);
      expect(await settingsRepository.takeNextNumber('nextRunNumber')).toBe(
        SEQUENCE_STARTS.nextRunNumber + 1,
      );
    });

    /*
     * The version of the same bug that would actually cost money. An invoice
     * sequence that restarts at 1 collides with three years of history.
     */
    it('does not restart invoice numbering at 1', async () => {
      if (!reachable) return;
      await seedSettings();
      await SettingsModel.updateOne(
        { _id: SETTINGS_SINGLETON_ID },
        { $unset: { nextInvoiceNumber: 1 } },
      );

      const allocated = await settingsRepository.takeNextNumber('nextInvoiceNumber');

      expect(allocated).toBe(SEQUENCE_STARTS.nextInvoiceNumber);
      expect(allocated).toBeGreaterThan(100_000);
    });

    it('does not throw on the first allocation', async () => {
      if (!reachable) return;
      await seedSettings();
      await SettingsModel.updateOne(
        { _id: SETTINGS_SINGLETON_ID },
        { $unset: { nextRunNumber: 1 } },
      );

      await expect(settingsRepository.takeNextNumber('nextRunNumber')).resolves.toBeTypeOf(
        'number',
      );
    });
  });

  /*
   * A brand-new database, with no settings document at all.
   *
   * ── Why this no longer expects a refusal ──────────────────────────────────
   * It used to assert that an unseeded install was refused and told to run
   * `seed:settings`, on the reasoning that inventing a number would let a
   * misconfigured environment invoice real customers. The reasoning held for
   * the NUMBER and not for the DOCUMENT: `seed:settings` refuses to run with
   * NODE_ENV=production, so on a fresh production database the instruction was
   * impossible to follow and the first job anyone raised returned a 500.
   *
   * Nothing is invented here. The document is created from the SCHEMA's own
   * declared defaults, so the first job number is the one M1.4 specifies —
   * 61,300, continuing TransVirtual — and not 1.
   */
  it('creates the settings document when there is none, and starts at the declared number', async () => {
    if (!reachable) return;
    expect(await SettingsModel.countDocuments()).toBe(0);

    const first = await settingsRepository.takeNextNumber('nextJobNumber');
    const second = await settingsRepository.takeNextNumber('nextJobNumber');

    expect(first).toBe(SEQUENCE_STARTS.nextJobNumber);
    expect(second).toBe(SEQUENCE_STARTS.nextJobNumber + 1);
    expect(first).toBeGreaterThan(61_000);
  });

  /*
   * ⚠️ The document it creates has to be COMPLETE, not just the one sequence.
   *
   * A pipeline upsert would write `_id` and `nextJobNumber` alone. `get()`
   * falls back to defaults only when the document is ENTIRELY absent, so a
   * partial one reaches the settings contract with `undefined` where it
   * declares a number — and the settings screen goes down. That is the failure
   * this assertion exists to catch.
   */
  it('creates a complete document, not just the sequence it needed', async () => {
    if (!reachable) return;
    await settingsRepository.takeNextNumber('nextJobNumber');

    const settings = await settingsRepository.get();

    expect(settings.invoicing.defaultPaymentTermsDays).toBe(7);
    expect(settings.invoicing.splitAdditionalCharges).toBe(true);
    expect(await settingsRepository.slaBusinessDays()).toBe(5);
    // The other sequences are present too, at their own declared starts.
    expect(await settingsRepository.takeNextNumber('nextInvoiceNumber')).toBe(
      SEQUENCE_STARTS.nextInvoiceNumber,
    );
  });

  /*
   * Two first bookings landing together on an empty database: both find no
   * document, both try to insert, and one loses on a duplicate `_id`. The
   * loser must still get its own number rather than an error or a repeat.
   */
  it('hands out distinct numbers when several first bookings race the creation', async () => {
    if (!reachable) return;

    const allocated = await Promise.all(
      Array.from({ length: 20 }, () => settingsRepository.takeNextNumber('nextJobNumber')),
    );

    expect(new Set(allocated).size).toBe(20);
    expect(Math.min(...allocated)).toBe(SEQUENCE_STARTS.nextJobNumber);
  });
});
