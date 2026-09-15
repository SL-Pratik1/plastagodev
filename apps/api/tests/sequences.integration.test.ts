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

  it('refuses when there is no settings document at all', async () => {
    if (!reachable) return;
    // A genuinely unseeded install is a deployment problem, and inventing a
    // number here would let a misconfigured environment invoice real customers.
    await expect(settingsRepository.takeNextNumber('nextJobNumber')).rejects.toThrow(
      /not been seeded/,
    );
  });
});
