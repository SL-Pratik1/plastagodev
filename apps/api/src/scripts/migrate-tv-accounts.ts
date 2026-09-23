/**
 * TransVirtual migration, Phase 2 — customers → accounts.
 *
 * ⚠️ TransVirtual's own Customer List export has NO suburb/postcode/contact
 * columns at all (confirmed against the real captured file, 2026-09-22) —
 * the plan's original "resolve the zone from the customer's suburb" approach
 * has no data to work from. Every account gets `DEFAULT_ZONE_SLUG` instead,
 * flagged individually, rather than silently guessing or blocking all 61.
 * Same story for contacts: none are created here (no name/email column to
 * read), each account is flagged "no contact captured".
 *
 * Idempotent on `code` (TransVirtual's own Customer Code, already the right
 * shape — e.g. "CLA001"). First run: `accountService.provision()`, which
 * validates the rate card and zone exist and sends no email. Re-run: a
 * narrow refresh of only the fields TransVirtual stays authoritative for
 * (name/abn/status) — `accountType`/`rateCardId`/`primaryZoneId`/`poPolicy`/
 * `captureMode`/`paymentTermsDays` are set once at creation only, so a staff
 * correction in the admin UI sticks.
 *
 * Usage:
 *   tsx src/scripts/migrate-tv-accounts.ts --target=local-test [--dry-run]
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectMongo, disconnectMongo, isMongoConnected } from '../db/mongo.js';
import { AccountModel } from '../domains/accounts/account.model.js';
import { accountService } from '../domains/accounts/account.service.js';
import { authRepository } from '../domains/auth/auth.repository.js';
import { settingsRepository } from '../domains/settings/settings.repository.js';
import { DEFAULT_RATE_CARD_ID } from '@plastago/shared';
import { assertTargetMatchesConnection, parseMigrationCli } from './transvirtual/cli.js';
import { MigrationReport } from './transvirtual/report.js';
import { assertColumns, readGridDump } from './transvirtual/source-reader.js';
import { isLikelyTestRow } from './transvirtual/test-row-filter.js';

const SCRIPT_NAME = 'migrate-tv-accounts';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)); // apps/api

/** No source data resolves a real zone per customer — see the file header. */
const DEFAULT_ZONE_SLUG = 'sydney';
const ABN_PLACEHOLDER = 'ABN NOT PROVIDED — TV IMPORT';

async function main(): Promise<void> {
  const cli = parseMigrationCli(process.argv.slice(2));
  const inputDir = cli.inputDir ?? join(ROOT, 'migration-data', 'transvirtual', 'accounts');

  await connectMongo();
  if (!isMongoConnected()) throw new Error('Could not reach MongoDB — is it running?');
  assertTargetMatchesConnection(cli);

  const report = new MigrationReport({
    script: SCRIPT_NAME,
    target: cli.target,
    database: process.env.MONGODB_DB_NAME ?? '(default)',
    dryRun: cli.dryRun,
  });

  if (!cli.dryRun) await authRepository.seedBrands();

  const defaultZone = await settingsRepository.findZoneBySlug(DEFAULT_ZONE_SLUG);
  if (!defaultZone) {
    throw new Error(
      `Zone "${DEFAULT_ZONE_SLUG}" does not exist yet — run migrate-tv-reference-data.ts first.`,
    );
  }
  const defaultRateCard = await settingsRepository.findRateCard(DEFAULT_RATE_CARD_ID);
  if (!defaultRateCard) {
    throw new Error(`Rate card "${DEFAULT_RATE_CARD_ID}" does not exist yet — run migrate-tv-reference-data.ts first.`);
  }

  const rows = readGridDump(join(inputDir, 'customers.json'));
  assertColumns(rows, ['Name', 'CustomerCode'], 'customers.json');
  report.read('account', rows.length);

  for (const row of rows) {
    const name = (row.Name ?? '').trim();
    const codeRaw = (row.CustomerCode ?? '').trim();

    if (isLikelyTestRow(name)) {
      report.excludeTestRow({ entity: 'account', key: name, code: 'TEST_ROW', message: 'name matches the test-row pattern', rawRow: row });
      continue;
    }

    if (codeRaw === '') {
      report.block({
        entity: 'account',
        key: name || '(no name)',
        code: 'NO_CUSTOMER_CODE',
        message: 'TransVirtual row has no Customer Code — nothing to use as this account\'s unique code.',
        rawRow: row,
      });
      continue;
    }

    const code = codeRaw.toUpperCase();
    const abnRaw = (row.TaxNumber ?? '').trim();
    const abn = abnRaw || ABN_PLACEHOLDER;
    const onHold =
      (row.AccountOnHold ?? '').trim().toLowerCase() === 'yes' ||
      (row.DeliveriesOnHold ?? '').trim().toLowerCase() === 'yes' ||
      (row.ConCreateOnHold ?? '').trim().toLowerCase() === 'yes';
    const status: 'active' | 'inactive' = onHold ? 'inactive' : 'active';

    const existing = await AccountModel.findOne({ code }).lean<{ _id: unknown } | null>();

    if (!existing) {
      if (!cli.dryRun) {
        try {
          const created = await accountService.provision({
            customerCode: code,
            legalName: name,
            abn,
            accountType: 'builder',
            brandId: 'plastago',
            rateCardId: DEFAULT_RATE_CARD_ID,
            poPolicy: 'not-required',
            captureMode: 'area-only',
            paymentTermsDays: 7,
            primaryZoneId: defaultZone.id,
            accountsContactName: '',
            accountsContactEmail: '',
            notes: '',
            sendInvitation: false,
          });
          if (status !== 'active') {
            // provision()/accountRepository.create() hardcodes 'active' — see
            // the migration report/plan for why this needs a second write.
            await AccountModel.updateOne({ _id: created.id }, { $set: { status } });
          }
        } catch (error) {
          report.block({
            entity: 'account',
            key: code,
            code: 'PROVISION_FAILED',
            message: (error as Error).message,
            rawRow: row,
          });
          continue;
        }
      }
      report.created('account');
    } else {
      if (!cli.dryRun) {
        await AccountModel.updateOne({ code }, { $set: { name, abn, status } });
      }
      report.updated('account');
    }

    if (!abnRaw) {
      report.flag({
        entity: 'account',
        key: code,
        code: 'ABN_PLACEHOLDER',
        message: `No Tax Number in TransVirtual — stored as "${ABN_PLACEHOLDER}". Enter the real ABN before this account is invoiced.`,
      });
    }
    report.flag({
      entity: 'account',
      key: code,
      code: 'ZONE_DEFAULTED',
      message: `TransVirtual's customer export has no suburb/postcode — zone defaulted to "${DEFAULT_ZONE_SLUG}". Verify and correct if this account's work is actually in a different zone.`,
    });
    report.flag({
      entity: 'account',
      key: code,
      code: 'NO_CONTACT_CAPTURED',
      message: 'TransVirtual\'s customer export has no contact name/email column — no contact was created. Add one via the admin UI.',
    });
  }

  report.printSummary();
  report.writeToDisk(join(ROOT, 'migration-data', 'reports'));
}

main()
  .catch((error: unknown) => {
    console.error('[migrate-tv-accounts] failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectMongo();
  });
