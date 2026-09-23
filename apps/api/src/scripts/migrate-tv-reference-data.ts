/**
 * TransVirtual migration, Phase 1 — reference data.
 *
 * Zones → the `default` rate card → TransVirtual's 8 rate cards (placeholder
 * $0 pricing — see `rate-card-map.ts`) → additional services.
 *
 * Safe to run repeatedly: every write is the upsert-by-business-key pattern
 * this codebase already uses (`settingsRepository.seed()`), and rate cards
 * intentionally do NOT price any live account yet — every account Phase 2
 * creates points at `default`, never its own TransVirtual-derived card —
 * so a placeholder here is inert until a human deliberately re-prices and
 * re-points it.
 *
 * Usage:
 *   tsx src/scripts/migrate-tv-reference-data.ts --target=local-test [--dry-run]
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RATE_CARD_ID } from '@plastago/shared';
import { connectMongo, disconnectMongo, isMongoConnected } from '../db/mongo.js';
import { settingsRepository } from '../domains/settings/settings.repository.js';
import { assertTargetMatchesConnection, parseMigrationCli } from './transvirtual/cli.js';
import { resolveChargeCode } from './transvirtual/charge-code-map.js';
import { MigrationReport } from './transvirtual/report.js';
import { resolveRateCard } from './transvirtual/rate-card-map.js';
import { assertColumns, readGridDump } from './transvirtual/source-reader.js';
import { isLikelyTestRow } from './transvirtual/test-row-filter.js';
import { resolveZone } from './transvirtual/zone-map.js';

const SCRIPT_NAME = 'migrate-tv-reference-data';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)); // apps/api

/** Same placeholder value `seed-settings.ts` already uses — not a guess. */
const ASSUMED_COST_PER_JOB = '100.00';

async function main(): Promise<void> {
  const cli = parseMigrationCli(process.argv.slice(2));
  const inputDir = cli.inputDir ?? join(ROOT, 'migration-data', 'transvirtual', 'reference');

  await connectMongo();
  if (!isMongoConnected()) throw new Error('Could not reach MongoDB — is it running?');
  assertTargetMatchesConnection(cli);

  const report = new MigrationReport({
    script: SCRIPT_NAME,
    target: cli.target,
    database: process.env.MONGODB_DB_NAME ?? '(default)',
    dryRun: cli.dryRun,
  });

  // ── Zones ──────────────────────────────────────────────────────────────
  const zoneRows = readGridDump(join(inputDir, 'zones.json'));
  assertColumns(zoneRows, ['Zone Name'], 'zones.json');
  report.read('zone', zoneRows.length);

  const zonesToSeed: Array<{ slug: string; label: string; displayOrder: number }> = [];
  zoneRows.forEach((row, index) => {
    const name = row['Zone Name'] ?? '';
    const resolved = resolveZone(name);
    if (!resolved) {
      report.block({
        entity: 'zone',
        key: name || `row ${String(index)}`,
        code: 'ZONE_NOT_IN_MAP',
        message: `"${name}" is not in zone-map.ts's ZONE_SLUG_MAP — TransVirtual may have added a zone since this table was written. Add it there before re-running.`,
        rawRow: row,
      });
      return;
    }
    zonesToSeed.push({ slug: resolved.slug, label: resolved.label, displayOrder: index });
  });

  if (!cli.dryRun) {
    // Zones only, first — rate-card zone rates below need the real ids this creates.
    await settingsRepository.seed({
      zones: zonesToSeed,
      rateCards: [],
      zoneRates: [],
      additionalServices: [],
      invoiceTemplates: [],
      assumedCostPerJob: ASSUMED_COST_PER_JOB,
    });
  }
  zonesToSeed.forEach(() => report.created('zone')); // upsert — "created" here means "ensured present"

  const zoneIdBySlug = new Map<string, string>();
  if (!cli.dryRun) {
    for (const z of zonesToSeed) {
      const found = await settingsRepository.findZoneBySlug(z.slug);
      if (found) zoneIdBySlug.set(z.slug, found.id);
    }
  }

  // ── Rate cards (placeholder pricing) ─────────────────────────────────────
  const rateCardRows = readGridDump(join(inputDir, 'rate-cards.json'));
  assertColumns(rateCardRows, ['Name'], 'rate-cards.json');
  report.read('rateCard', rateCardRows.length);

  const effectiveFrom = new Date().toISOString().slice(0, 10);
  const rateCardsToSeed: Array<{ id: string; label: string; effectiveFrom: Date }> = [];
  const zoneRatesToSeed: Array<{
    rateCardId: string;
    zoneId: string;
    serviceCharge: string;
    ratePerM2: string;
    effectiveFrom: string;
  }> = [];

  // The `default` card must exist regardless of what TransVirtual's own
  // export contains — Phase 2 accounts point at it unconditionally, and
  // this migration must not silently depend on `seed-settings.ts` having
  // been run first.
  rateCardsToSeed.push({
    id: DEFAULT_RATE_CARD_ID,
    label: 'Default Customer Rates',
    effectiveFrom: new Date(),
  });

  for (const row of rateCardRows) {
    const name = row.Name ?? '';
    if (isLikelyTestRow(name)) {
      report.excludeTestRow({ entity: 'rateCard', key: name, code: 'TEST_ROW', message: 'name matches the test-row pattern', rawRow: row });
      continue;
    }
    const resolved = resolveRateCard(name);
    if (!resolved) {
      report.block({
        entity: 'rateCard',
        key: name,
        code: 'RATE_CARD_NOT_IN_MAP',
        message: `"${name}" is not in rate-card-map.ts's RATE_CARD_ID_MAP. Add it there before re-running.`,
        rawRow: row,
      });
      continue;
    }
    if (resolved.id === DEFAULT_RATE_CARD_ID) continue; // already added above
    rateCardsToSeed.push({ id: resolved.id, label: resolved.label, effectiveFrom: new Date() });
    report.flag({
      entity: 'rateCard',
      key: resolved.id,
      code: 'PLACEHOLDER_PRICING',
      message: `Created with $0.00 service charge / $0.0000 per m² in every zone — TransVirtual's pricing math (weight/cubic, multi-method) has no honest translation into this system's shape. Real numbers need to be entered via Settings → "Issue new schedule" before any account is re-pointed at this card.`,
    });
  }

  for (const card of rateCardsToSeed) {
    for (const zoneId of zoneIdBySlug.values()) {
      zoneRatesToSeed.push({
        rateCardId: card.id,
        zoneId,
        serviceCharge: '0.00',
        ratePerM2: '0.0000',
        effectiveFrom,
      });
    }
  }

  // ── Additional services ───────────────────────────────────────────────
  const serviceRows = readGridDump(join(inputDir, 'additional-services.json'));
  assertColumns(serviceRows, ['Name'], 'additional-services.json');
  report.read('additionalService', serviceRows.length);

  const additionalServicesToSeed: Array<{
    code: string;
    label: string;
    kind: 'fixed' | 'percentage';
    value: string;
    requiresApproval: boolean;
    driverRaisable: boolean;
    systemGenerated: boolean;
  }> = [];

  for (const row of serviceRows) {
    const name = row.Name ?? '';
    const resolved = resolveChargeCode(name);
    if (!resolved) {
      report.block({
        entity: 'additionalService',
        key: name,
        code: 'CHARGE_CODE_NOT_IN_MAP',
        message: `"${name}" is not in charge-code-map.ts's CHARGE_CODE_MAP. Add it there before re-running.`,
        rawRow: row,
      });
      continue;
    }
    const flatRate = (row.CustomerRate ?? '').trim();
    const pctRate = (row.CustomerPercRate ?? '').trim().replace('%', '');
    const kind: 'fixed' | 'percentage' = pctRate !== '' ? 'percentage' : 'fixed';
    const value = kind === 'percentage' ? pctRate : flatRate || '0';

    additionalServicesToSeed.push({
      code: resolved.code,
      label: resolved.label,
      kind,
      value,
      requiresApproval: resolved.requiresApproval,
      driverRaisable: resolved.driverRaisable,
      systemGenerated: false,
    });
  }

  /*
   * ⚠️ Not TransVirtual-sourced — added after app-level testing found that
   * with zero templates, PDF rendering (and therefore emailing) fails for
   * EVERY invoice, migrated or brand new, until one exists. One plain
   * default is enough to unblock the feature; a real branded one can
   * replace it later via Settings without this script's involvement.
   */
  const invoiceTemplatesToSeed = [
    {
      id: 'default',
      name: 'Standard',
      brandId: 'plastago' as const,
      showsWeight: false,
      layout: 'standard' as const,
      accentColour: '#1a4d3a',
    },
  ];

  if (!cli.dryRun) {
    await settingsRepository.seed({
      zones: zonesToSeed,
      rateCards: rateCardsToSeed,
      zoneRates: zoneRatesToSeed,
      additionalServices: additionalServicesToSeed,
      invoiceTemplates: invoiceTemplatesToSeed,
      assumedCostPerJob: ASSUMED_COST_PER_JOB,
    });
  }
  rateCardsToSeed.forEach(() => report.created('rateCard'));
  additionalServicesToSeed.forEach(() => report.created('additionalService'));
  invoiceTemplatesToSeed.forEach(() => report.created('invoiceTemplate'));

  report.printSummary();
  report.writeToDisk(join(ROOT, 'migration-data', 'reports'));
}

main()
  .catch((error: unknown) => {
    console.error('[migrate-tv-reference-data] failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectMongo();
  });
