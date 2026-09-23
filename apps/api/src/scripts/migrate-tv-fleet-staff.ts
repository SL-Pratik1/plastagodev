/**
 * TransVirtual migration, Phase 3 — vehicles and staff.
 *
 * Idempotent on `rego` (vehicles) and `email`/`phoneNumber` (staff) — the
 * exact pattern `seed-auth.ts` already uses. Uses the repository layer
 * directly (`vehicleRepository`, `userRepository`), never the service layer:
 * `userService.create()` sends a real invitation email/SMS per person, which
 * is wrong for a bulk historical sync; the repository's `create()` does not.
 *
 * Usage:
 *   tsx src/scripts/migrate-tv-fleet-staff.ts --target=local-test [--dry-run]
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrandId, Role } from '@plastago/shared';
import { connectMongo, disconnectMongo, isMongoConnected } from '../db/mongo.js';
import { vehicleRepository } from '../domains/fleet/vehicle.repository.js';
import { userRepository } from '../domains/users/user.repository.js';
import { UserModel } from '../domains/auth/auth.model.js';
import { VehicleModel } from '../domains/fleet/vehicle.model.js';
import { assertTargetMatchesConnection, parseMigrationCli } from './transvirtual/cli.js';
import { MigrationReport } from './transvirtual/report.js';
import { assertColumns, readGridDump } from './transvirtual/source-reader.js';
import { resolveVehicleType } from './transvirtual/vehicle-type-map.js';

const SCRIPT_NAME = 'migrate-tv-fleet-staff';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)); // apps/api

/** Deliberately a PAST sentinel — see the plan: makes a vehicle read as
 *  "expired" immediately, the safe failure mode for a compliance field,
 *  rather than a future date that would make an unknown-risk truck look
 *  permanently fine. Written once only; never overwritten on re-run. */
const REGO_EXPIRY_PLACEHOLDER = '1900-01-01';

const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function main(): Promise<void> {
  const cli = parseMigrationCli(process.argv.slice(2));
  const defaultInputDir = join(ROOT, 'migration-data', 'transvirtual', 'fleet-staff');
  const inputDir = cli.inputDir ?? defaultInputDir;

  await connectMongo();
  if (!isMongoConnected()) throw new Error('Could not reach MongoDB — is it running?');
  assertTargetMatchesConnection(cli);

  const report = new MigrationReport({
    script: SCRIPT_NAME,
    target: cli.target,
    database: process.env.MONGODB_DB_NAME ?? '(default)',
    dryRun: cli.dryRun,
  });

  await migrateVehicles(inputDir, cli.dryRun, report);
  await migrateStaff(inputDir, cli.dryRun, report);

  report.printSummary();
  report.writeToDisk(join(ROOT, 'migration-data', 'reports'));
}

async function migrateVehicles(inputDir: string, dryRun: boolean, report: MigrationReport): Promise<void> {
  const rows = readGridDump(join(inputDir, 'vehicles.json'));
  assertColumns(rows, ['Name', 'Rego'], 'vehicles.json');
  report.read('vehicle', rows.length);

  for (const row of rows) {
    const name = (row.Name ?? '').trim();
    const rego = (row.Rego ?? '').trim().toUpperCase();

    if (rego === '') {
      report.block({ entity: 'vehicle', key: name || '(no name)', code: 'NO_REGO', message: 'No rego in TransVirtual row.', rawRow: row });
      continue;
    }

    const type = resolveVehicleType(row.VehicleTypeTag ?? '');
    if (!type) {
      report.block({
        entity: 'vehicle',
        key: rego,
        code: 'VEHICLE_TYPE_NOT_IN_MAP',
        message: `TransVirtual type "${row.VehicleTypeTag ?? ''}" is not in vehicle-type-map.ts. This system only has crane-truck/hooklift/ute — decide which one this vehicle actually is and add it there before re-running.`,
        rawRow: row,
      });
      continue;
    }

    const yearMatch = /^(19|20)\d{2}\b/.exec(name);
    const year = yearMatch ? Number(yearMatch[0]) : null;
    const odometerKm = Number.parseInt(row.VehicleCurrentOdometer ?? '', 10) || 0;

    const input = {
      rego,
      label: name,
      type,
      make: (row.VehicleMake ?? '').trim(),
      model: (row.VehicleModel ?? '').trim(),
      year,
      odometerKm,
      registrationExpiresOn: REGO_EXPIRY_PLACEHOLDER,
      registrationPeriodMonths: 12,
      purchasedOn: null,
      notes: '',
    };

    const existing = await VehicleModel.findOne({ rego }).lean<{ _id: unknown } | null>();

    if (!existing) {
      if (!dryRun) await vehicleRepository.create(input);
      report.created('vehicle');
      report.flag({
        entity: 'vehicle',
        key: rego,
        code: 'REGO_EXPIRY_PLACEHOLDER',
        message: `No registration-expiry date in TransVirtual — stored as ${REGO_EXPIRY_PLACEHOLDER} (shows as expired until corrected). Enter the real date.`,
      });
    } else {
      if (!dryRun) {
        // registrationExpiresOn deliberately excluded — write-once, never
        // overwritten once a real date has been entered.
        await VehicleModel.updateOne(
          { rego },
          { $set: { label: input.label, make: input.make, model: input.model, year: input.year, odometerKm: input.odometerKm } },
        );
      }
      report.updated('vehicle');
    }
  }
}

async function migrateStaff(inputDir: string, dryRun: boolean, report: MigrationReport): Promise<void> {
  const rows = readGridDump(join(inputDir, 'staff.json'));
  assertColumns(rows, ['DisplayName', 'LoginName'], 'staff.json');
  report.read('user', rows.length);

  for (const row of rows) {
    const name = (row.DisplayName ?? '').trim();
    const loginName = (row.LoginName ?? '').trim();
    const tvEmail = (row.EmailAddress ?? '').trim();
    const mobile = (row.MobileNumber ?? '').trim() || null;

    // Prefer a real, deliverable address. "Login Name" values like
    // "ash@plastago" have no TLD and are TransVirtual-internal identifiers,
    // not real emails — only used here if they happen to look like one.
    let email: string | null = null;
    if (EMAIL_LIKE.test(tvEmail)) email = tvEmail.toLowerCase();
    else if (EMAIL_LIKE.test(loginName)) email = loginName.toLowerCase();

    if (!email && !mobile) {
      report.block({
        entity: 'user',
        key: loginName || name,
        code: 'NO_REACHABLE_IDENTIFIER',
        message: `Neither a real email nor a mobile number found for "${name}" (TransVirtual login "${loginName}") — this system needs at least one to sign somebody in. Get their real contact details before this person can be added.`,
        rawRow: row,
      });
      continue;
    }

    const isSuperAdmin = /\(SuperAdmin\)/i.test(row.ItOnly ?? '');
    const role: Role = isSuperAdmin ? 'super-admin' : 'office-staff';

    const input = {
      name,
      email,
      mobile,
      role,
      roles: [role],
      jobTitle: null,
      brandIds: ['plastago'] as BrandId[],
      accountId: null,
      notes: '',
    };

    const existing = await UserModel.findOne(email ? { email } : { phoneNumber: mobile }).lean<{ _id: unknown } | null>();

    if (!existing) {
      if (!dryRun) await userRepository.create({ ...input, invitedBy: 'TransVirtual migration' });
      report.created('user');
    } else {
      /*
       * ⚠️ `name` and `role`/`roles` are deliberately EXCLUDED here — not
       * refreshed like the account-side fields are.
       *
       * TransVirtual has at least one real case of two login rows sharing one
       * real email: a legacy "Matthew Old EasyLift" row and the current
       * "matthew@plastago.com.au" row are the same person. Whichever row this
       * script processes SECOND would otherwise silently overwrite the
       * FIRST row's correctly-derived name/role — in the real data this
       * meant a confirmed SuperAdmin getting quietly downgraded to
       * office-staff by an old duplicate login. Established once at
       * creation, correctable via the admin UI, never silently reset by a
       * later row or a later run.
       */
      if (!dryRun) {
        await UserModel.updateOne(
          { _id: existing._id },
          { $set: { phoneNumber: mobile, brandIds: input.brandIds } },
        );
      }
      report.updated('user');
    }

    // Only on creation — an update no longer touches role at all (see the
    // comment above), so claiming a "default" happened on that path would
    // be describing something that didn't occur.
    if (!existing && !isSuperAdmin) {
      report.flag({
        entity: 'user',
        key: email ?? mobile ?? loginName,
        code: 'ROLE_DEFAULTED',
        message: `TransVirtual's Staff list has no role/security-group column — defaulted to "office-staff" (the lowest-privilege option). This person may actually be Operations, Allocator, or Driver — confirm their real role.`,
      });
    }
    if (!email) {
      report.flag({
        entity: 'user',
        key: mobile ?? loginName,
        code: 'NO_EMAIL_ONLY_MOBILE',
        message: `No usable email found — created with mobile "${mobile ?? ''}" only.`,
      });
    }
  }
}

main()
  .catch((error: unknown) => {
    console.error('[migrate-tv-fleet-staff] failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectMongo();
  });
