/**
 * APP TEST data — a full week of driver work for the Flutter developer.
 *
 * ── What it builds ─────────────────────────────────────────────────────────
 * For "Test Driver" (the fixed-code test login, `auth/test-login.ts`), one run
 * on each Sydney day from 2026-10-06 to 2026-10-10, five jobs on each, every
 * job left at `assigned` so the developer walks every step on the phone:
 *
 *   1. Normal          — travel, arrive, photos, weights, complete
 *   2. Full site card  — urgent, induction, crane, gate hours, site contact,
 *                        risk assessment
 *   3. Futile          — mark it futile (no access)
 *   4. Contamination   — raise a contamination report
 *   5. Extras          — record more bags than booked, send a message
 *
 * Plus two customers (`APT001`, and `APT002` whose jobs need a risk assessment
 * — that rule is per account, not per job) and a truck paired to the driver,
 * which the pre-start and defect screens need.
 *
 * ── Why through the services ───────────────────────────────────────────────
 * Every row is created by the same `accountService` / `jobService` /
 * `dispatchService` calls the office uses, so the jobs are priced, zoned and
 * staffed exactly like real ones — including the driver stamp on every stop.
 *
 * ── Why nobody is messaged ─────────────────────────────────────────────────
 * This process forces SMS and email to the stub, Xero and the extractor off.
 * And the data itself is unreachable: the customers have no portal users and
 * no contacts, except job 2's site contact, whose fictional mobile
 * (0491 570 157, ACMA's drama range) is an account contact with SMS and email
 * switched OFF — so the live server's own notices for these jobs are skipped.
 *
 * ── Usage (from apps/api) ──────────────────────────────────────────────────
 *   npx tsx src/scripts/app-test-data.ts                  local DB (.env)
 *   npx tsx src/scripts/app-test-data.ts --live           live DB (.env.live)
 *   add --reset to wipe the APP TEST jobs and runs, and everything the phone
 *   recorded against them, then build them fresh.
 *   add --add-price when a zone has no price on the default card, so no job
 *   can be booked there (see `addMissingPrices`).
 *
 * Only ever touches APP TEST data: the two APT accounts, their jobs, runs named
 * "APP TEST", the APPTEST1 truck, and what Test Driver recorded on those. The
 * one exception is --add-price, which changes the default card — and only by
 * filling a zone that has no price at all.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Safe to load first: mongoose reads none of our environment.
import mongoose from 'mongoose';

const args = new Set(process.argv.slice(2));
const LIVE = args.has('--live');
const RESET = args.has('--reset');
const ADD_PRICE = args.has('--add-price');

if (LIVE) {
  const file = fileURLToPath(new URL('../../.env.live', import.meta.url));
  const uri = /^MONGODB_URI\s*=\s*(.+)$/m.exec(readFileSync(file, 'utf8'))?.[1]?.trim();
  if (!uri) throw new Error('apps/api/.env.live has no MONGODB_URI line');
  process.env.MONGODB_URI = uri;
}

// Before ANY app module loads: env.ts reads these once, at import.
Object.assign(process.env, {
  NODE_ENV: 'development',
  SMS_PROVIDER: 'stub',
  MAIL_PROVIDER: 'stub',
  STORAGE_PROVIDER: 'stub',
  XERO_PROVIDER: 'off',
  EXTRACTOR_PROVIDER: 'off',
  SCHEDULER_ENABLED: 'false',
  ENABLE_QUEUES: 'false',
});

const { connectMongo, disconnectMongo, isMongoConnected } = await import('../db/mongo.js');
const { AccountModel, ContactModel } = await import('../domains/accounts/account.model.js');
const { accountService } = await import('../domains/accounts/account.service.js');
const { UserModel } = await import('../domains/auth/auth.model.js');
const { dispatchService } = await import('../domains/dispatch/dispatch.service.js');
const { RunModel } = await import('../domains/dispatch/run.model.js');
const { driverRepository } = await import('../domains/driver/driver.repository.js');
const { VehicleModel } = await import('../domains/fleet/vehicle.model.js');
const { vehicleService } = await import('../domains/fleet/vehicle.service.js');
const { JobModel } = await import('../domains/jobs/job.model.js');
const { jobService } = await import('../domains/jobs/job.service.js');
const { PlaceModel } = await import('../domains/places/place.model.js');
const { pricingService } = await import('../domains/settings/pricing.service.js');
const { settingsRepository } = await import('../domains/settings/settings.repository.js');
const { settingsService } = await import('../domains/settings/settings.service.js');

type JobDraft = Parameters<typeof jobService.create>[0];

const TEST_DRIVER_MOBILE = '0491570156';
const SITE_CONTACT_MOBILE = '0491570157';
const DATES = ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'];
const RUN_PREFIX = 'APP TEST';
const NOTE = 'APP TEST — fake data for the mobile app. Do not invoice, cancel or reschedule.';
const ACTOR = 'APP TEST script';

const ACCOUNTS = {
  main: { code: 'APT001', name: 'APP TEST – Mobile Dev', abn: '99000000000', risk: false },
  safety: { code: 'APT002', name: 'APP TEST – Mobile Dev (Safety)', abn: '98000000470', risk: true },
} as const;

const TRUCK = { rego: 'APPTEST1', label: 'APP TEST TRUCK' };

/** The standard zone prices `seed-settings.ts` ships with, used only to fill a gap. */
const STANDARD_PRICES: Record<string, { serviceCharge: string; ratePerM2: string }> = {
  sydney: { serviceCharge: '220.00', ratePerM2: '0.16' },
  wollongong: { serviceCharge: '250.00', ratePerM2: '0.18' },
  newcastle: { serviceCharge: '250.00', ratePerM2: '0.20' },
};
const PRICE_FROM = '2026-10-01';

/** Suburbs tried first, so the jobs land somewhere familiar when they exist. */
const PREFERRED_SUBURBS = ['Parramatta', 'Blacktown', 'Penrith', 'Liverpool', 'Castle Hill'];

/**
 * Collections the phone (or the office, around these jobs) writes against a
 * job id. Cleared on --reset; every one is optional — a collection that does
 * not exist yet simply has nothing to clear.
 */
const BY_JOB_ID = [
  'jobevents',
  'jobphotos',
  'jobcharges',
  'contaminationreports',
  'futilereviews',
  'jobcomments',
  'jobprestarts',
  'jobriskassessments',
  'jobdocuments',
  'certificates',
  'notifications',
  'outboundmessages',
] as const;

async function main(): Promise<void> {
  await connectMongo();
  if (!isMongoConnected()) throw new Error('no database connection');
  const db = mongoose.connection.db;
  if (!db) throw new Error('no database handle');
  console.log(`database: ${db.databaseName}${LIVE ? '  (LIVE)' : ''}`);

  const driver = await UserModel.findOne({ phoneNumber: TEST_DRIVER_MOBILE }).lean<{
    _id: mongoose.Types.ObjectId;
    name: string;
    roles: string[];
    status: string;
  }>();
  if (!driver) throw new Error(`no user with mobile ${TEST_DRIVER_MOBILE}`);
  if (driver.status !== 'active' || driver.roles.some((role) => role !== 'driver')) {
    throw new Error(`${driver.name} must be an active, driver-only account`);
  }
  const driverId = String(driver._id);

  // The office identity the trail records. Named for the script, so nobody
  // reads the job history and thinks a person booked these.
  const admin = await UserModel.findOne({ roles: 'super-admin', status: 'active' }).lean<{
    _id: mongoose.Types.ObjectId;
  }>();
  const caller = {
    userId: String(admin?._id ?? driver._id),
    name: ACTOR,
    roles: ['super-admin'] as const,
    accountId: null,
  };

  const existingRuns = await RunModel.find({ name: new RegExp(`^${RUN_PREFIX}`), date: { $in: DATES } })
    .select({ _id: 1 })
    .lean<Array<{ _id: mongoose.Types.ObjectId }>>();

  if (existingRuns.length > 0 && !RESET) {
    throw new Error(`APP TEST runs already exist (${existingRuns.length}) — rerun with --reset`);
  }

  if (ADD_PRICE) await addMissingPrices(caller);
  const place = await pickPlace();
  console.log(`suburb: ${place.suburb} ${place.postcode}`);

  const mainAccount = await ensureAccount(ACCOUNTS.main, place.zoneId, caller);
  const safety = await ensureAccount(ACCOUNTS.safety, place.zoneId, caller);
  await ensureSiteContact(safety);
  await ensureTruck(driver.name, caller);

  if (RESET) await wipe(db, [mainAccount, safety], driver._id);

  let created = 0;
  for (const date of DATES) {
    const jobIds: string[] = [];
    for (const draft of draftsFor(date, place._id, mainAccount, safety)) {
      const job = await jobService.create(draft, caller);
      jobIds.push(job.id);
      created += 1;
    }

    // Created unstaffed, then assigned — `assignRun` is the path that stamps
    // the driver on every stop and moves them booked → assigned.
    const run = await dispatchService.createRun({
      name: `${RUN_PREFIX} – ${date}`,
      date,
      driverId: null,
      jobIds,
    });
    if (run.stops.length !== jobIds.length) {
      throw new Error(`run ${date} took ${run.stops.length} of ${jobIds.length} jobs`);
    }
    await dispatchService.assignRun(run.id, driverId);
  }

  await verify(db, driverId, [mainAccount, safety], created);
}

/** First serviceable suburb that actually prices on the first run date. */
/**
 * Gives every active zone with NO price on the default card the standard one,
 * from 2026-10-01, through the same `settingsService` call as the settings
 * screen. A zone that already has a price keeps it exactly — the new schedule
 * carries its figures over, because a schedule must price every zone.
 */
async function addMissingPrices(caller: { roles: readonly ['super-admin']; accountId: null }) {
  const zones = await settingsRepository.activeZones();
  const missing: string[] = [];

  const rates = [];
  for (const zone of zones) {
    const current = await settingsRepository.resolveRate('default', zone.id, PRICE_FROM);
    if (current) {
      rates.push({ zoneId: zone.id, serviceCharge: current.serviceCharge, ratePerM2: current.ratePerM2 });
    } else {
      const standard = STANDARD_PRICES[zone.slug] ?? STANDARD_PRICES.sydney;
      rates.push({ zoneId: zone.id, ...(standard as { serviceCharge: string; ratePerM2: string }) });
      missing.push(`${zone.label} ($${standard?.serviceCharge} + $${standard?.ratePerM2}/m²)`);
    }
  }

  if (missing.length === 0) {
    console.log('prices: every zone already has one — nothing added');
    return;
  }

  if (await settingsRepository.findRateCard('default')) {
    await settingsService.issueSchedule('default', { effectiveFrom: PRICE_FROM, zones: rates }, caller);
  } else {
    await settingsService.createRateCard(
      { id: 'default', label: 'Standard', effectiveFrom: PRICE_FROM, zones: rates },
      caller,
    );
  }
  console.log(`prices added from ${PRICE_FROM}: ${missing.join(', ')}`);
}

async function pickPlace() {
  const places = await PlaceModel.find({ archived: false })
    .lean<Array<{ _id: mongoose.Types.ObjectId; suburb: string; postcode: string; zoneId: mongoose.Types.ObjectId }>>();
  const rank = (suburb: string) => {
    const index = PREFERRED_SUBURBS.indexOf(suburb);
    return index === -1 ? PREFERRED_SUBURBS.length : index;
  };
  places.sort((a, b) => rank(a.suburb) - rank(b.suburb));

  // Every reason a suburb was passed over, counted — so a failure says WHY
  // rather than leaving someone to guess at the rate schedules.
  const reasons = new Map<string, number>();

  // Priced exactly as the jobs will be: the APT accounts use the default card,
  // and every run date must be covered, not just the first.
  for (const place of places) {
    try {
      for (const onDate of DATES) {
        await pricingService.quoteWithAppliedRate({
          rateCardId: 'default',
          zoneId: String(place.zoneId),
          expectedAreaM2: 120,
          bagCount: 10,
          onDate,
        });
      }
      return place;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }

  const summary = [...reasons].map(([reason, count]) => `  ×${count}  ${reason}`).join('\n');
  throw new Error(
    `no suburb can be priced for ${DATES[0]}–${DATES.at(-1)} (${places.length} suburbs checked)\n${summary || '  there are no active suburbs at all'}`,
  );
}

async function ensureAccount(
  spec: (typeof ACCOUNTS)[keyof typeof ACCOUNTS],
  zoneId: mongoose.Types.ObjectId,
  caller: { name: string; roles: readonly ['super-admin']; accountId: null },
): Promise<string> {
  const found = await AccountModel.findOne({ code: spec.code }).lean<{
    _id: mongoose.Types.ObjectId;
    name: string;
  }>();
  if (found) {
    if (!found.name.startsWith('APP TEST')) {
      throw new Error(`${spec.code} belongs to "${found.name}" — not touching it`);
    }
    return String(found._id);
  }

  const { account } = await accountService.create(
    {
      customerCode: spec.code,
      legalName: spec.name,
      abn: spec.abn,
      accountType: 'builder',
      brandId: 'plastago',
      rateCardId: 'default',
      // Two brakes on billing: no invoice can be sent without a PO number.
      poPolicy: 'required-before-invoice',
      // So the phone asks for kilograms — job 1 tests weights.
      captureMode: 'area-and-weight',
      paymentTermsDays: 30,
      primaryZoneId: String(zoneId),
      accountsContactName: '',
      accountsContactEmail: '',
      sendInvitation: false,
      notes: NOTE,
    },
    { name: ACTOR },
  );

  if (spec.risk) await accountService.setRiskAssessmentRequired(account.id, true, caller);
  console.log(`created customer ${spec.code} ${spec.name}`);
  return account.id;
}

/** Job 2's site contact — on file with every channel OFF, so it is never messaged. */
async function ensureSiteContact(accountId: string): Promise<void> {
  await ContactModel.updateOne(
    { accountId: new mongoose.Types.ObjectId(accountId), mobile: SITE_CONTACT_MOBILE },
    {
      $set: {
        name: 'APP TEST Site Contact',
        role: 'site',
        email: null,
        notifyBySms: false,
        notifyByEmail: false,
      },
    },
    { upsert: true },
  );
}

/** The truck the pre-start and defect screens need, paired to the driver by name. */
async function ensureTruck(driverName: string, caller: { userId: string; name: string; roles: readonly ['super-admin'] }) {
  let truck = await VehicleModel.findOne({ rego: TRUCK.rego }).lean<{ _id: mongoose.Types.ObjectId }>();
  if (!truck) {
    const created = await vehicleService.create(
      {
        rego: TRUCK.rego,
        label: TRUCK.label,
        type: 'crane-truck',
        make: '',
        model: '',
        year: null,
        odometerKm: 0,
        registrationExpiresOn: '2027-10-06',
        registrationPeriodMonths: 12,
        purchasedOn: null,
        notes: NOTE,
      },
      caller,
    );
    truck = { _id: new mongoose.Types.ObjectId(created.id) };
    console.log(`created truck ${TRUCK.rego}`);
  }
  await vehicleService.assignDriver(String(truck._id), driverName, caller);
}

function draftBase(readyDate: string, placeId: string) {
  return {
    lotNumber: '',
    placeId,
    builderName: '',
    accessNotes: '',
    gateHours: '',
    inductionRequired: false,
    craneAvailable: true,
    siteContactName: '',
    siteContactMobile: '',
    siteContactEmail: '',
    poNumber: '',
    purchaseOrderId: null,
    readyDate,
    serviceLevel: 'standard' as const,
    freightItem: 'plasterboard-bagged' as const,
    expectedAreaM2: 0,
    bagCount: 0,
    notes: NOTE,
  };
}

/** The five jobs of one day — each one there to exercise a different screen. */
function draftsFor(date: string, placeId: mongoose.Types.ObjectId, main: string, safety: string): JobDraft[] {
  const base = draftBase(date, String(placeId));
  const day = date.slice(8);
  return [
    {
      ...base,
      accountId: main,
      siteName: `APP TEST ${day}/1 – Normal job`,
      addressLine: '1 Test Street',
      expectedAreaM2: 120,
      bagCount: 10,
      notes: `${NOTE}\nJob 1: travel, arrive, photos, weights, complete.`,
    },
    {
      ...base,
      accountId: safety,
      siteName: `APP TEST ${day}/2 – Full site card`,
      addressLine: '2 Test Street',
      lotNumber: 'Lot 22',
      builderName: 'APP TEST Builders',
      accessNotes: 'Enter via the side gate. Hi-vis and hard hat required.',
      gateHours: '6:30am – 3:30pm',
      inductionRequired: true,
      craneAvailable: true,
      siteContactName: 'APP TEST Site Contact',
      siteContactMobile: SITE_CONTACT_MOBILE,
      poNumber: 'APP-TEST-PO',
      serviceLevel: 'urgent',
      expectedAreaM2: 200,
      bagCount: 15,
      notes: `${NOTE}\nJob 2: urgent, induction, crane, gate hours, site contact, risk assessment.`,
    },
    {
      ...base,
      accountId: main,
      siteName: `APP TEST ${day}/3 – Futile`,
      addressLine: '3 Test Street',
      accessNotes: 'Gate is locked — use this job to test FUTILE (no access).',
      expectedAreaM2: 80,
      bagCount: 6,
      notes: `${NOTE}\nJob 3: mark it futile (no access) with a photo.`,
    },
    {
      ...base,
      accountId: main,
      siteName: `APP TEST ${day}/4 – Contamination`,
      addressLine: '4 Test Street',
      craneAvailable: false,
      freightItem: 'plasterboard-hand-load',
      expectedAreaM2: 90,
      bagCount: 0,
      notes: `${NOTE}\nJob 4: raise a contamination report with evidence photos.`,
    },
    {
      ...base,
      accountId: main,
      siteName: `APP TEST ${day}/5 – Extras`,
      addressLine: '5 Test Street',
      expectedAreaM2: 60,
      bagCount: 5,
      notes: `${NOTE}\nJob 5: record MORE than 5 bags (extra-bags charge) and send a message.`,
    },
  ];
}

/**
 * Removes the APP TEST jobs and runs and every row recorded against them, so
 * they can be built fresh. Scoped three ways and nothing wider: the two APT
 * accounts' jobs, runs named APP TEST, and what Test Driver recorded.
 */
async function wipe(db: NonNullable<typeof mongoose.connection.db>, accountIds: string[], driverId: mongoose.Types.ObjectId) {
  const accounts = accountIds.map((id) => new mongoose.Types.ObjectId(id));
  const jobIds = (
    await JobModel.find({ accountId: { $in: accounts } }).select({ _id: 1 }).lean<Array<{ _id: mongoose.Types.ObjectId }>>()
  ).map((job) => job._id);
  const runIds = (
    await RunModel.find({ name: new RegExp(`^${RUN_PREFIX}`) }).select({ _id: 1 }).lean<Array<{ _id: mongoose.Types.ObjectId }>>()
  ).map((run) => run._id);

  const removed: Record<string, number> = {};
  const clear = async (collection: string, filter: Record<string, unknown>) => {
    const result = await db.collection(collection).deleteMany(filter);
    if (result.deletedCount > 0) removed[collection] = (removed[collection] ?? 0) + result.deletedCount;
  };

  for (const collection of BY_JOB_ID) await clear(collection, { jobId: { $in: jobIds } });
  await clear('runtipoffs', { runId: { $in: runIds } });
  await clear('jobprestarts', { driverId });
  await clear('vehicledefects', { reportedByUserId: driverId });
  await clear('idempotencykeys', { userId: String(driverId) });
  await clear('invoicelines', { jobId: { $in: jobIds } });
  await clear('invoices', { accountId: { $in: accounts } });
  await clear('jobs', { _id: { $in: jobIds } });
  await clear('runs', { _id: { $in: runIds } });

  console.log('reset removed:', JSON.stringify(removed));
}

async function verify(
  db: NonNullable<typeof mongoose.connection.db>,
  driverId: string,
  accountIds: string[],
  created: number,
): Promise<void> {
  const accounts = accountIds.map((id) => new mongoose.Types.ObjectId(id));
  const jobs = await JobModel.find({ accountId: { $in: accounts } })
    .select({ _id: 1, status: 1, driverId: 1, runId: 1 })
    .lean<Array<{ _id: mongoose.Types.ObjectId; status: string; driverId: unknown; runId: unknown }>>();
  const ready = jobs.filter((job) => job.status === 'assigned' && String(job.driverId) === driverId && job.runId);

  console.log(`\njobs created: ${created} · APP TEST jobs assigned to Test Driver on a run: ${ready.length}/${jobs.length}`);
  for (const date of DATES) {
    const sheet = await driverRepository.runSheet(driverId, date);
    console.log(`  ${date}: ${sheet.runs.length} run, ${sheet.stops.length} jobs on the driver's run sheet`);
  }

  const sent = await db
    .collection('outboundmessages')
    .countDocuments({ jobId: { $in: jobs.map((job) => job._id) }, outcome: { $ne: 'skipped' } });
  console.log(`messages actually sent for these jobs: ${sent}`);
}

try {
  await main();
} finally {
  await disconnectMongo();
}
