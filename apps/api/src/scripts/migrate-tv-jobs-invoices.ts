/**
 * TransVirtual migration, Phase 4 — historical jobs and invoices.
 *
 * The bigger, later, separate piece: real TransVirtual consignment/invoice
 * numbers are kept (they're already what builders' AP systems have on
 * file), and this system's own sequence counters are advanced past the
 * highest imported number afterward — never the reverse of that order.
 *
 * Data source: unlike Phases 1-3, this was NOT captured via TransVirtual's
 * per-screen grid alone — the Consignment Search screen's column selector
 * was used to add TransVirtual's own pricing/zone/item columns directly to
 * the bulk list (still pure reading, no Export click), which is what makes
 * importing 5,280 jobs and 5,233 invoices with full detail practical at all
 * without visiting each one's detail page individually.
 *
 * Uses `jobRepository.create()` / `invoiceRepository.create()` directly —
 * never `jobService.create()` / `invoiceService.*` (those geocode live, run
 * the live pricing engine, and send real customer emails/Xero pushes, all
 * wrong for a historical backfill).
 *
 * Usage:
 *   tsx src/scripts/migrate-tv-jobs-invoices.ts --target=local-test [--dry-run] [--only=jobs|invoices]
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InvoiceStatus } from '@plastago/shared';
import { connectMongo, disconnectMongo, isMongoConnected } from '../db/mongo.js';
import { AccountModel } from '../domains/accounts/account.model.js';
import { invoiceRepository } from '../domains/invoices/invoice.repository.js';
import { InvoiceModel } from '../domains/invoices/invoice.model.js';
import { jobRepository } from '../domains/jobs/job.repository.js';
import { JobModel } from '../domains/jobs/job.model.js';
import { SettingsModel, SETTINGS_SINGLETON_ID } from '../domains/settings/settings.model.js';
import { settingsRepository } from '../domains/settings/settings.repository.js';
import { assertTargetMatchesConnection, parseMigrationCli } from './transvirtual/cli.js';
import { resolveFreightItem } from './transvirtual/freight-item-map.js';
import { MigrationReport } from './transvirtual/report.js';
import { assertColumns, readGridDump, type SourceRow } from './transvirtual/source-reader.js';
import { resolveStatus } from './transvirtual/status-map.js';
import { resolveZone, ZONE_CENTRE } from './transvirtual/zone-map.js';

const SCRIPT_NAME = 'migrate-tv-jobs-invoices';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)); // apps/api
const FALLBACK_ZONE_SLUG = 'sydney'; // see zone-map.ts — covers 5,279 of 5,280 jobs directly anyway

function parseTvDate(value: string): string | null {
  // TV dates are "DD/MM/YYYY" or "DD/MM/YYYY H:MM AM/PM NZST" — only the date part is used.
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(value.trim());
  if (!m) return null;
  const [, d, mo, y] = m;
  if (!d || !mo || !y) return null;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function parseMoney(value: string): string {
  const cleaned = value.replace(/[$,]/g, '').trim();
  return cleaned === '' ? '0' : cleaned;
}

/** `SourceRow` is a plain string-keyed record — this just keeps every call
 *  site a clean `string` instead of `string | undefined` everywhere. Safe
 *  because `assertColumns` already confirmed the file has these columns. */
function s(row: SourceRow, key: string): string {
  return row[key] ?? '';
}

async function main(): Promise<void> {
  const cli = parseMigrationCli(process.argv.slice(2));
  const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
  const inputDir = cli.inputDir ?? join(ROOT, 'migration-data', 'transvirtual', 'jobs-invoices');

  await connectMongo();
  if (!isMongoConnected()) throw new Error('Could not reach MongoDB — is it running?');
  assertTargetMatchesConnection(cli);

  const report = new MigrationReport({
    script: SCRIPT_NAME,
    target: cli.target,
    database: process.env.MONGODB_DB_NAME ?? '(default)',
    dryRun: cli.dryRun,
  });

  // Zones must already exist (Phase 1). Resolve the ids this phase needs once.
  const zoneIdBySlug = new Map<string, string>();
  for (const slug of Object.keys(ZONE_CENTRE)) {
    const z = await settingsRepository.findZoneBySlug(slug);
    if (z) zoneIdBySlug.set(slug, z.id);
  }
  if (!zoneIdBySlug.has(FALLBACK_ZONE_SLUG)) {
    throw new Error(`Zone "${FALLBACK_ZONE_SLUG}" does not exist yet — run migrate-tv-reference-data.ts first.`);
  }

  // Account lookups, built once rather than per-row.
  const accountsByCode = new Map<string, { id: string; name: string }>();
  const accountsByName = new Map<string, { id: string; name: string; code: string }>();
  for (const a of await AccountModel.find({}, { code: 1, name: 1 }).lean<Array<{ _id: unknown; code: string; name: string }>>()) {
    accountsByCode.set(a.code, { id: String(a._id), name: a.name });
    accountsByName.set(a.name.trim().toLowerCase(), { id: String(a._id), name: a.name, code: a.code });
  }

  let maxJobNumber = 0;
  let maxInvoiceNumber = 0;

  if (!only || only === 'jobs') {
    maxJobNumber = await migrateJobs(inputDir, cli.dryRun, report, accountsByCode, zoneIdBySlug);
  }
  if (!only || only === 'invoices') {
    maxInvoiceNumber = await migrateInvoices(inputDir, cli.dryRun, report, accountsByName);
  }

  // ── Sequence rebase — guarded, forward-only. See the plan for why a blind
  // $set here would be dangerous: it must never rewind past numbers a real,
  // live booking has already used since an earlier migration run.
  if (!cli.dryRun) {
    if (maxJobNumber > 0) {
      await SettingsModel.updateOne(
        { _id: SETTINGS_SINGLETON_ID, nextJobNumber: { $lt: maxJobNumber + 1 } },
        { $set: { nextJobNumber: maxJobNumber + 1 } },
      );
    }
    if (maxInvoiceNumber > 0) {
      await SettingsModel.updateOne(
        { _id: SETTINGS_SINGLETON_ID, nextInvoiceNumber: { $lt: maxInvoiceNumber + 1 } },
        { $set: { nextInvoiceNumber: maxInvoiceNumber + 1 } },
      );
    }
  }
  console.log(`\n[sequence rebase] highest imported job=${maxJobNumber || 'n/a'}, invoice=${maxInvoiceNumber || 'n/a'} — counters advanced past these (forward-only, no-op if already past).`);

  report.printSummary();
  report.writeToDisk(join(ROOT, 'migration-data', 'reports'));
}

async function migrateJobs(
  inputDir: string,
  dryRun: boolean,
  report: MigrationReport,
  accountsByCode: Map<string, { id: string; name: string }>,
  zoneIdBySlug: Map<string, string>,
): Promise<number> {
  const rows = readGridDump(join(inputDir, 'jobs.json'));
  assertColumns(rows, ['ConsignmentNumber', 'CustomerCode'], 'jobs.json');
  report.read('job', rows.length);

  let maxJobNumber = 0;

  for (const row of rows) {
    const jobNumber = Number.parseInt(s(row, 'ConsignmentNumber'), 10);
    if (!Number.isFinite(jobNumber)) {
      report.block({ entity: 'job', key: s(row, 'ConsignmentNumber') || '(blank)', code: 'BAD_NUMBER', message: 'Consign Number did not parse as a number.', rawRow: row });
      continue;
    }
    maxJobNumber = Math.max(maxJobNumber, jobNumber);

    const account = accountsByCode.get(s(row, 'CustomerCode').trim().toUpperCase());
    if (!account) {
      report.block({ entity: 'job', key: String(jobNumber), code: 'ACCOUNT_NOT_FOUND', message: `Customer code "${s(row, 'CustomerCode')}" has no migrated account — run migrate-tv-accounts.ts first, or this row was excluded there.`, rawRow: row });
      continue;
    }

    const freightItem = resolveFreightItem(s(row, 'ConsignmentDescDisplaySummary'));
    if (!freightItem) {
      report.block({ entity: 'job', key: String(jobNumber), code: 'FREIGHT_ITEM_NOT_IN_MAP', message: `"${s(row, 'ConsignmentDescDisplaySummary')}" doesn't match the hand-load/bagged classifier in freight-item-map.ts — this job's item description is genuinely unrecognised, not just unusual.`, rawRow: row });
      continue;
    }

    const zoneResolved = resolveZone(s(row, 'ConsignmentCustomerPriceFromZone'));
    const zoneSlug = zoneResolved && zoneIdBySlug.has(zoneResolved.slug) ? zoneResolved.slug : FALLBACK_ZONE_SLUG;
    const zoneId = zoneIdBySlug.get(zoneSlug);
    const centre = ZONE_CENTRE[zoneSlug];
    if (!zoneId || !centre) {
      report.block({ entity: 'job', key: String(jobNumber), code: 'ZONE_NOT_RESOLVED', message: `Neither "${s(row, 'ConsignmentCustomerPriceFromZone')}" nor the fallback zone "${FALLBACK_ZONE_SLUG}" exist yet.`, rawRow: row });
      continue;
    }

    const readyDate = parseTvDate(s(row, 'ConsignmentPickupBookingTime')) ?? parseTvDate(s(row, 'ConsignmentDate'));
    const targetDate = parseTvDate(s(row, 'ConsignExpectedDeliveryDate')) ?? readyDate;
    if (!readyDate || !targetDate) {
      report.block({ entity: 'job', key: String(jobNumber), code: 'NO_DATE', message: 'Could not parse a ready/target date from this row.', rawRow: row });
      continue;
    }

    const rawStatus = s(row, 'ConsignmentStatus');
    const statusResolution = resolveStatus(rawStatus, Boolean(s(row, 'ConsignmentDeliveryFirstCompleteDate') || s(row, 'ConsignmentPickupCompleteDate')));
    const completedAtDate = parseTvDate(s(row, 'ConsignmentDeliveryFirstCompleteDate')) ?? parseTvDate(s(row, 'ConsignmentPickupCompleteDate'));

    const senderName = s(row, 'SenderName');
    const senderSuburb = s(row, 'SenderSuburb');
    const senderAddress = s(row, 'SenderAddress');
    const lotMatch = /Lot\s+([A-Za-z0-9]+)/i.exec(senderAddress);

    const existing = await JobModel.findOne({ jobNumber }).lean<{ _id: unknown } | null>();

    if (!existing) {
      if (!dryRun) {
        const created = await jobRepository.create({
          jobNumber,
          accountId: account.id,
          accountName: account.name,
          brandId: 'plastago',
          builderName: senderName,
          siteName: senderName ? `${senderName} — ${senderSuburb}` : senderSuburb,
          lotNumber: lotMatch?.[1] ?? null,
          addressLine: senderAddress,
          suburb: senderSuburb,
          postcode: s(row, 'SenderPostcode'),
          zoneId,
          latitude: centre.latitude,
          longitude: centre.longitude,
          locationSource: 'suburb',
          accessNotes: '',
          gateHours: null,
          inductionRequired: false,
          craneAvailable: false,
          siteContactName: s(row, 'ConsignmentSenderContact') || null,
          siteContactMobile: s(row, 'ConsignmentSenderPhone') || null,
          siteContactEmail: null,
          poNumber: s(row, 'SenderReference') || null,
          purchaseOrderId: null,
          bookedByName: null,
          bookedByUserId: null,
          bookedBySource: 'office',
          readyDate,
          targetDate,
          serviceLevel: 'standard',
          freightItem,
          expectedAreaM2: null,
          bagCount: 0,
          notes: statusResolution.confident ? '' : `[TV-MIGRATION] raw status: ${rawStatus} — unmapped, verify.`,
          totalExGst: parseMoney(s(row, 'ConsignmentCustomerPreTaxTotal')),
          gst: parseMoney(s(row, 'ConsignmentCustomerTaxTotal')),
          totalIncGst: parseMoney(s(row, 'ConsignmentCustomerGrandTotal')),
          appliedRate: null,
          riskAssessmentRequired: false,
        });

        await JobModel.updateOne(
          { _id: created.id },
          {
            $set: {
              status: statusResolution.status,
              /*
               * ⚠️ Always 'not-invoiced', never 'invoiced' — found during
               * app-level testing, not left as a TODO. TransVirtual's
               * invoice list carries no consignment-number column, so there
               * is no reliable way to say WHICH invoice covers this job (see
               * migrateInvoices' NO_JOB_LINK flag). Claiming 'invoiced'
               * without a real invoiceNumber/invoicedAt to back it up showed
               * up in the app as "STATE: Invoiced" next to "INVOICE NUMBER:
               * Not issued" — confusing, not just internally inconsistent.
               * 'not-invoiced' is the honest default; a human can mark
               * specific jobs invoiced once the real link is known.
               */
              invoiceStatus: 'not-invoiced',
              completedAt: completedAtDate ? new Date(completedAtDate) : null,
            },
          },
        );
      }
      report.created('job');
    } else {
      // Re-run: refresh only what TV stays authoritative for pre-cutover.
      // `invoiceStatus` included here too, deliberately — this is also how
      // an already-migrated job from before this fix gets corrected.
      if (!dryRun) {
        await JobModel.updateOne(
          { jobNumber },
          {
            $set: {
              status: statusResolution.status,
              invoiceStatus: 'not-invoiced',
              totalExGst: parseMoney(s(row, 'ConsignmentCustomerPreTaxTotal')),
              gst: parseMoney(s(row, 'ConsignmentCustomerTaxTotal')),
              totalIncGst: parseMoney(s(row, 'ConsignmentCustomerGrandTotal')),
            },
          },
        );
      }
      report.updated('job');
    }

    if (zoneSlug === FALLBACK_ZONE_SLUG && !zoneResolved) {
      report.flag({ entity: 'job', key: String(jobNumber), code: 'ZONE_FALLBACK', message: `TV rating zone "${s(row, 'ConsignmentCustomerPriceFromZone')}" was blank/unrecognised — defaulted to "${FALLBACK_ZONE_SLUG}".` });
    }
    report.flag({ entity: 'job', key: String(jobNumber), code: 'APPROXIMATE_COORDINATES', message: `Coordinates are a zone-centre approximation, not a real geocode — this is a completed historical job (never re-routed), so this is intentional, not a data-quality gap to chase.` });
    if (!statusResolution.confident) {
      report.flag({ entity: 'job', key: String(jobNumber), code: 'STATUS_UNMAPPED', message: `Raw TV status "${rawStatus}" wasn't recognised — derived a best-effort status instead of guessing blindly.` });
    }
  }

  return maxJobNumber;
}

async function migrateInvoices(
  inputDir: string,
  dryRun: boolean,
  report: MigrationReport,
  accountsByName: Map<string, { id: string; name: string; code: string }>,
): Promise<number> {
  const rows = readGridDump(join(inputDir, 'invoices.json'));
  assertColumns(rows, ['Number', 'Name'], 'invoices.json');
  report.read('invoice', rows.length);

  let maxInvoiceNumber = 0;

  for (const row of rows) {
    const rawNumber = s(row, 'Number');
    const numRaw = rawNumber.replace(/^PGT-/i, '').trim();
    const invoiceNumber = Number.parseInt(numRaw, 10);
    if (!Number.isFinite(invoiceNumber)) {
      report.block({ entity: 'invoice', key: rawNumber || '(blank)', code: 'BAD_NUMBER', message: 'Invoice number did not parse.', rawRow: row });
      continue;
    }
    maxInvoiceNumber = Math.max(maxInvoiceNumber, invoiceNumber);

    const customerName = s(row, 'Name');
    const account = accountsByName.get(customerName.trim().toLowerCase());
    if (!account) {
      report.block({ entity: 'invoice', key: String(invoiceNumber), code: 'ACCOUNT_NOT_FOUND', message: `Customer name "${customerName}" has no migrated account (matched by name, not code — invoices carry no customer code).`, rawRow: row });
      continue;
    }

    const issuedOn = parseTvDate(s(row, 'Date'));
    const dueOn = parseTvDate(s(row, 'DueDate'));
    if (!issuedOn) {
      report.block({ entity: 'invoice', key: String(invoiceNumber), code: 'NO_DATE', message: 'Could not parse the invoice date.', rawRow: row });
      continue;
    }

    let status: InvoiceStatus;
    const pay = s(row, 'InvoicePaymentStatus').trim().toLowerCase();
    if (pay === 'paid') status = 'paid';
    else status = 'unknown'; // includes TV's own "Unknown" and "Failed" — see the plan: don't assert "overdue" without knowing TV's real semantics for "Failed"

    const subtotalExGst = parseMoney(s(row, 'PreTaxTotal'));
    const gst = parseMoney(s(row, 'TaxTotal'));
    const totalIncGst = parseMoney(s(row, 'GrandTotal'));

    const existing = await InvoiceModel.findOne({ invoiceNumber }).lean<{ _id: unknown } | null>();

    if (!existing) {
      if (!dryRun) {
        await invoiceRepository.create({
          invoiceNumber,
          kind: 'base',
          status,
          accountId: account.id,
          accountName: account.name,
          brandId: 'plastago',
          jobId: null,
          jobNumber: null,
          poNumber: null,
          issuedOn,
          dueOn,
          paymentTermsDays: 7,
          subtotalExGst,
          gst,
          totalIncGst,
          templateName: 'Standard',
          notes: '',
          // One summary line — TransVirtual's invoice list gives a single
          // total, not a line-item breakdown, so this is honestly one line,
          // not a fabricated itemisation.
          lines: [
            {
              description: `Migrated from TransVirtual invoice ${rawNumber}`,
              quantity: 1,
              unitRate: subtotalExGst,
              amount: subtotalExGst,
              raisedBy: null,
              sourceChargeId: null,
            },
          ],
        });
      }
      report.created('invoice');
      report.flag({ entity: 'invoice', key: String(invoiceNumber), code: 'NO_JOB_LINK', message: 'TransVirtual\'s invoice list has no consignment-number column, so this invoice is not linked to a specific migrated job — both exist, just not cross-referenced.' });
    } else {
      if (!dryRun) {
        await InvoiceModel.updateOne({ invoiceNumber }, { $set: { status, subtotalExGst, gst, totalIncGst } });
      }
      report.updated('invoice');
    }
  }

  return maxInvoiceNumber;
}

main()
  .catch((error: unknown) => {
    console.error('[migrate-tv-jobs-invoices] failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectMongo();
  });
