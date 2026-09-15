import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SETTINGS_SINGLETON_ID,
  SettingsModel,
} from '../src/domains/settings/settings.model.js';
import { settingsRepository } from '../src/domains/settings/settings.repository.js';

/**
 * Saving the invoicing block, and reading back what was saved (M7.5).
 *
 * ── Why this has to be an integration test ────────────────────────────────
 * ⚠️ It exists for a bug a fake could not have caught, and did not.
 *
 * `saveInvoicing` wrote a hand-written `$set` that had drifted from the
 * contract: seven fields were missing — the whole company block, the terms
 * wording and the bank ACCOUNT NAME. They were still READ back from the stored
 * document, so the screen showed the old value and the administrator who had
 * just typed their ABN watched it silently revert.
 *
 * The in-memory fake stored whatever it was handed, so every service test
 * passed while no invoice this system rendered could carry a company name or an
 * ABN — and an invoice without an ABN is not a tax invoice, which a customer
 * may lawfully refuse to pay.
 *
 * The lesson is the shape of this file: a fake proves the SERVICE's rules, and
 * only a database proves the repository actually persists them. Anything whose
 * failure mode is "saved successfully, stored nothing" belongs here.
 *
 * Skips itself when Mongo is unreachable, so the suite still runs on a machine
 * with no database rather than failing for the wrong reason.
 */

const MONGO_URL = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const TEST_DB = 'plastago_invoicing_roundtrip_test';

let reachable = false;

beforeAll(async () => {
  try {
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
  await SettingsModel.deleteMany({});
  await SettingsModel.create({ _id: SETTINGS_SINGLETON_ID, assumedCostPerJob: '120.00' });
});

/** Every field of the invoicing block, each with a value nothing else would produce. */
const FULL = {
  templates: [],
  invoiceNumberPrefix: 'PGA',
  splitAdditionalCharges: false,
  defaultPaymentTermsDays: 30,
  logoKey: '',
  companyName: 'PlastaGo Group Pty Ltd',
  companyAbn: '51 824 753 556',
  companyAddress: '1 Recycling Way, Smithfield NSW 2164',
  companyPhone: '02 9111 2222',
  companyEmail: 'accounts@plastago.com.au',
  termsText: 'Payment due within 30 days.',
  footerText: 'Thank you for recycling with us.',
  bankBsb: '062-000',
  bankAccount: '12345678',
  bankAccountName: 'PlastaGo Group Pty Ltd',
  showGbcaBadge: true,
  /*
   * Deliberately not `as const`: that makes `templates` a `readonly []`, which
   * the repository's mutable parameter rejects at every call site below. The
   * literal types it would buy are not used — the assertions compare values.
   */
} satisfies Parameters<typeof settingsRepository.saveInvoicing>[0];

describe('saving the invoicing block', () => {
  it('persists every field the contract carries', async ({ skip }) => {
    if (!reachable) return skip();

    await settingsRepository.saveInvoicing({ ...FULL });

    const stored = await settingsRepository.get();

    /*
     * Asserted field by field rather than with one deep equal, so a future
     * omission names the field it dropped instead of printing two large
     * objects and leaving the reader to diff them.
     */
    for (const [field, expected] of Object.entries(FULL)) {
      if (field === 'templates' || field === 'logoKey') continue;
      expect({ [field]: stored.invoicing[field as keyof typeof FULL] }).toEqual({
        [field]: expected,
      });
    }
  });

  /*
   * ⚠️ The exact shape of the original bug: the company block round-trips.
   * Kept as its own case because these two fields are what make the document a
   * tax invoice, and a regression here is not cosmetic.
   */
  it('round-trips the company name and ABN', async ({ skip }) => {
    if (!reachable) return skip();

    await settingsRepository.saveInvoicing({ ...FULL });
    const first = await settingsRepository.get();

    expect(first.invoicing.companyName).toBe('PlastaGo Group Pty Ltd');
    expect(first.invoicing.companyAbn).toBe('51 824 753 556');

    // And a second save does not lose them again.
    await settingsRepository.saveInvoicing({ ...FULL, companyPhone: '02 9000 0000' });
    const second = await settingsRepository.get();

    expect(second.invoicing.companyName).toBe('PlastaGo Group Pty Ltd');
    expect(second.invoicing.companyPhone).toBe('02 9000 0000');
  });

  /*
   * `logoKey` is deliberately NOT in the write. It is set by its own endpoints
   * once the bytes have landed, so a client echoing back a stale key cannot
   * repoint the logo — or blank it by sending the read shape back verbatim.
   */
  it('does not let a save touch the logo', async ({ skip }) => {
    if (!reachable) return skip();

    await settingsRepository.setLogoKey('plastago/settings/singleton/logo/real.png');
    await settingsRepository.saveInvoicing({ ...FULL, logoKey: '' });

    expect(await settingsRepository.logoKey()).toBe(
      'plastago/settings/singleton/logo/real.png',
    );
  });
});
