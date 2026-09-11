import {
  type BrandId,
  type CredentialType,
  type ExceptionReason,
  type FreightItem,
  type RateCardId,
  type Zone,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { connectMongo, disconnectMongo, isMongoConnected } from '../db/mongo.js';
import {
  AccountModel,
  ContactModel,
  TermsAcceptanceModel,
} from '../domains/accounts/account.model.js';
import { UserModel } from '../domains/auth/auth.model.js';
import { RunModel, RunTipOffModel } from '../domains/dispatch/run.model.js';
import { VehicleDefectModel } from '../domains/driver/defect.model.js';
import { VehicleExpenseModel, VehicleModel } from '../domains/fleet/vehicle.model.js';
import { InvoiceLineModel, InvoiceModel } from '../domains/invoices/invoice.model.js';
import {
  JobChargeModel,
  JobCommentModel,
  JobDocumentModel,
  JobEventModel,
  JobModel,
  JobPhotoModel,
  JobPreStartModel,
  JobRiskAssessmentModel,
} from '../domains/jobs/job.model.js';
import {
  NotificationModel,
  OutboundMessageModel,
} from '../domains/notifications/notification.model.js';
import { PlaceModel } from '../domains/places/place.model.js';
import { ChangeRequestModel, ReadinessCertificationModel } from '../domains/portal/portal.model.js';
import { FutileReviewModel } from '../domains/queues/futile-review.model.js';
import { LeadModel, LeadNoteModel } from '../domains/queues/lead.model.js';
import { CallUpModel } from '../domains/queues/call-up.model.js';
import { PoExtractionModel, PurchaseOrderModel } from '../domains/queues/purchase-order.model.js';
import { CertificateModel } from '../domains/reports/certificate.model.js';
import {
  DriverCredentialModel,
  DriverRosterModel,
  DriverTrainingModel,
} from '../domains/roster/roster.model.js';
import {
  SETTINGS_SINGLETON_ID,
  SettingsModel,
  ZoneRateModel,
} from '../domains/settings/settings.model.js';
import { UserDeviceModel, UserSignInModel } from '../domains/users/user.model.js';
import { startOfSydneyDay, todayInSydney } from '../lib/business-day.js';
import { logger } from '../lib/logger.js';
import { centsToMoney, fromDecimal128, moneyToCents, toDecimal128 } from '../lib/money.js';

const log = logger.child({ module: 'seed-demo' });

/**
 * A full, connected demo dataset — every panel, every role, every state.
 *
 * ── What this is for, and why it is not the other seeders ──────────────────
 * `seed-auth`, `seed-settings` and `seed-places` seed the FOUNDATIONS: the
 * accounts you sign in with, the rates that price a job, the suburbs a job can
 * be at. Nothing in them is a job, and so nothing in them fills a screen. This
 * script writes the working data on top: ~120 jobs across twelve weeks, the
 * runs that carried them, the invoices that followed, and the queues,
 * exceptions and compliance records that hang off the whole thing.
 *
 * It exists because a screen with no rows on it cannot be reviewed. "Is the
 * futile queue right" is not a question anybody can answer against an empty
 * table, and twelve blank panels read as a broken build rather than an unused
 * one.
 *
 * ── The one rule the shape obeys ───────────────────────────────────────────
 * Every state a screen can render has at least one row in it, and the rows
 * AGREE with each other. A completed job has a completion timestamp, a driver,
 * a run, photos and a weight; its invoice quotes its job number and its
 * account; its tonnage is in that account's diversion certificate; its
 * tip-off docket weighs what its run's stops recovered. Data that is only
 * right per-table falls apart on the first detail page anybody clicks into,
 * which is exactly where a demo goes.
 *
 * ── Deterministic ──────────────────────────────────────────────────────────
 * The generator is seeded, so two runs on the same day produce the same
 * database. Being able to rehearse against it is worth more than novelty, and
 * "it looked different yesterday" is not a bug report anyone can act on.
 *
 * Dates anchor to TODAY IN SYDNEY and are recomputed every run, so the
 * dashboard's "completed today" and the driver's run sheet are never empty —
 * see `lib/business-day.ts` for why UTC midnight is the wrong boundary.
 *
 * ⚠️ DEVELOPMENT ONLY, and it ASSUMES AN EMPTY DATABASE. It inserts rather than
 * upserts, so a second run over its own output collides on `jobNumber`. Use
 * `seed:all`, which resets first.
 *
 *   npm --workspace @plastago/api run seed:all     ← reset + foundations + this
 *   npm --workspace @plastago/api run seed:demo    ← this alone, onto an empty db
 */
/* ══ Deterministic randomness ═══════════════════════════════════════════════ */
/**
 * mulberry32 — small, fast, and seedable.
 *
 * `Math.random()` cannot be seeded, which would make every run a different
 * database. Reproducible beats realistic here: the point is being able to say
 * "open job 61,412" twice and mean the same job.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const random = makeRandom(20_260_909);

/** Inclusive at both ends — the reading everyone expects from `int(1, 6)`. */
function int(min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

function pick<T>(values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) throw new Error('pick() called with an empty array');
  return value;
}

function chance(probability: number): boolean {
  return random() < probability;
}

/** One decimal place, which is how an area is quoted. */
function area(min: number, max: number): number {
  return Math.round((min + random() * (max - min)) * 10) / 10;
}

/* ══ Dates ══════════════════════════════════════════════════════════════════ */
const TODAY = todayInSydney();

/** Sydney-local `YYYY-MM-DD`, `offset` days from today. Negative is the past. */
function day(offset: number): string {
  const [y, m, d] = TODAY.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

/** An instant on a Sydney day: `at('2026-09-09', 14, 30)` is 2:30pm there. */
function at(isoDate: string, hour: number, minute = 0): Date {
  return new Date(startOfSydneyDay(isoDate).getTime() + (hour * 60 + minute) * 60_000);
}

/** 0 = Sunday. The schedule stays off weekends, like the real one. */
function isWeekend(isoDate: string): boolean {
  const dow = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * The SLA in BUSINESS days (M2.4a) — five, matching the seeded
 * `slaBusinessDays`. Counting calendar days would put a Thursday booking's
 * target on a Tuesday and flag it late on the Monday, which is how a
 * perfectly-run week shows up red.
 */
function addBusinessDays(isoDate: string, days: number): string {
  let cursor = isoDate;
  let remaining = days;
  while (remaining > 0) {
    const [y, m, d] = cursor.split('-').map(Number);
    const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
    date.setUTCDate(date.getUTCDate() + 1);
    cursor = date.toISOString().slice(0, 10);
    if (!isWeekend(cursor)) remaining -= 1;
  }
  return cursor;
}

/** The nearest working day at or before `isoDate`. */
function toWeekday(isoDate: string): string {
  let cursor = isoDate;
  while (isWeekend(cursor)) {
    const [y, m, d] = cursor.split('-').map(Number);
    const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
    date.setUTCDate(date.getUTCDate() - 1);
    cursor = date.toISOString().slice(0, 10);
  }
  return cursor;
}

/* ══ Money ══════════════════════════════════════════════════════════════════ */
/** 10%, rounded to the cent — the ATO's rounding, not the float's. */
function gstOf(cents: number): number {
  return Math.round(cents / 10);
}

function decimal(cents: number): mongoose.Types.Decimal128 {
  return toDecimal128(centsToMoney(cents));
}

const oid = (): mongoose.Types.ObjectId => new mongoose.Types.ObjectId();

/* ══ Reference data ═════════════════════════════════════════════════════════ */
interface AccountSeed {
  code: string;
  name: string;
  tradingName: string | null;
  accountType: 'builder' | 'contractor';
  brandId: BrandId;
  rateCardId: RateCardId;
  poPolicy: 'not-required' | 'required-before-invoice';
  captureMode: 'area-only' | 'area-and-weight';
  status: 'active' | 'inactive';
  abn: string;
  paymentTermsDays: number;
  primaryZone: Zone;
  riskAssessmentRequired: boolean;
  approveNewSupervisors: boolean;
  certificateEmail: string | null;
  preferredPickupWindow: string | null;
  notes: string;
}

/**
 * Nine accounts, chosen to cover the axes the office actually filters on
 * rather than to be nine names: both account types, three brands, five rate
 * cards, both PO policies, both capture modes, all three zones, and one
 * inactive account so the status filter has something to hide.
 *
 * The two PO-required builders are the ones with real orders behind them —
 * Wisdom is the fixed-price case Matt described at 31:04, where the order
 * carries a line item and no square metres at all.
 */
const ACCOUNTS: readonly AccountSeed[] = [
  {
    code: 'CLA001',
    name: 'Clarendon Homes',
    tradingName: 'Clarendon Residential Group',
    accountType: 'builder',
    brandId: 'plastago',
    rateCardId: 'clarendon-domaine',
    poPolicy: 'required-before-invoice',
    captureMode: 'area-only',
    status: 'active',
    abn: '54 003 361 550',
    paymentTermsDays: 30,
    primaryZone: 'sydney',
    riskAssessmentRequired: true,
    approveNewSupervisors: true,
    certificateEmail: 'sustainability@clarendonhomes.com.au',
    preferredPickupWindow: '7am–11am',
    notes: 'Site supervisors book their own pickups. PO must be on the invoice.',
  },
  {
    code: 'DOM001',
    name: 'Domaine Homes',
    tradingName: null,
    accountType: 'builder',
    brandId: 'plastago',
    rateCardId: 'clarendon-domaine',
    poPolicy: 'not-required',
    captureMode: 'area-only',
    status: 'active',
    abn: '19 108 217 342',
    paymentTermsDays: 30,
    primaryZone: 'sydney',
    riskAssessmentRequired: false,
    approveNewSupervisors: false,
    certificateEmail: 'admin@domainehomes.com.au',
    preferredPickupWindow: null,
    notes: '',
  },
  {
    code: 'WIS001',
    name: 'Wisdom Properties Group',
    tradingName: 'Wisdom Homes',
    accountType: 'builder',
    brandId: 'plastago',
    rateCardId: 'wisdom',
    poPolicy: 'required-before-invoice',
    captureMode: 'area-only',
    status: 'active',
    abn: '84 095 253 200',
    paymentTermsDays: 45,
    primaryZone: 'sydney',
    riskAssessmentRequired: true,
    approveNewSupervisors: true,
    certificateEmail: 'accounts@wisdomhomes.com.au',
    preferredPickupWindow: '6:30am–2pm',
    notes: 'Fixed price per pickup — their order carries a line item, not m².',
  },
  {
    code: 'IPL001',
    name: 'iPlasta Pty Ltd',
    tradingName: null,
    accountType: 'contractor',
    brandId: 'plastago',
    rateCardId: 'tier-1',
    poPolicy: 'not-required',
    captureMode: 'area-and-weight',
    status: 'active',
    abn: '31 621 704 118',
    paymentTermsDays: 14,
    primaryZone: 'sydney',
    riskAssessmentRequired: false,
    // ⚠️ On, because `accounts@iplasta.com.au` is one of the two portal logins
    // this seeder prints. The approval gate is only demonstrable from an
    // account you can actually sign in to.
    approveNewSupervisors: true,
    certificateEmail: 'accounts@iplasta.com.au',
    preferredPickupWindow: null,
    notes: 'Plasterers — books across several builders. Weight captured for GBCA.',
  },
  {
    code: 'FOR001',
    name: 'Fornari Group',
    tradingName: null,
    accountType: 'contractor',
    brandId: 'plastago',
    rateCardId: 'tier-2',
    poPolicy: 'not-required',
    captureMode: 'area-and-weight',
    status: 'active',
    abn: '77 165 942 883',
    paymentTermsDays: 14,
    primaryZone: 'wollongong',
    riskAssessmentRequired: false,
    approveNewSupervisors: false,
    certificateEmail: null,
    preferredPickupWindow: null,
    notes: '',
  },
  {
    code: 'NEW001',
    name: 'Newlands Constructions Pty Ltd',
    tradingName: null,
    accountType: 'builder',
    brandId: 'plastago',
    rateCardId: 'tier-3',
    poPolicy: 'required-before-invoice',
    captureMode: 'area-only',
    status: 'active',
    abn: '42 138 006 771',
    paymentTermsDays: 30,
    primaryZone: 'newcastle',
    riskAssessmentRequired: true,
    approveNewSupervisors: false,
    certificateEmail: 'office@newlandsconstructions.com.au',
    preferredPickupWindow: null,
    notes: 'Newcastle estates. Induction required on most sites.',
  },
  {
    code: 'RAW001',
    name: 'Rawson Homes',
    tradingName: null,
    accountType: 'builder',
    brandId: 'easylift',
    rateCardId: 'tier-2',
    poPolicy: 'not-required',
    captureMode: 'area-only',
    status: 'active',
    abn: '68 003 258 111',
    paymentTermsDays: 30,
    primaryZone: 'sydney',
    riskAssessmentRequired: false,
    approveNewSupervisors: false,
    certificateEmail: null,
    preferredPickupWindow: null,
    notes: 'EasyLift brand — brick and tile lifts as well as board.',
  },
  {
    code: 'ALL001',
    name: 'Allcastle Homes',
    tradingName: null,
    accountType: 'builder',
    brandId: 'easylift',
    rateCardId: 'tier-3',
    poPolicy: 'not-required',
    captureMode: 'area-only',
    status: 'active',
    abn: '23 099 471 620',
    paymentTermsDays: 30,
    primaryZone: 'newcastle',
    riskAssessmentRequired: false,
    approveNewSupervisors: false,
    certificateEmail: null,
    preferredPickupWindow: null,
    notes: '',
  },
  {
    code: 'MPD001',
    name: 'Marsden Park Developments',
    tradingName: null,
    accountType: 'builder',
    brandId: 'plastago',
    rateCardId: 'tier-4',
    poPolicy: 'not-required',
    captureMode: 'area-only',
    status: 'inactive',
    abn: '90 604 118 255',
    paymentTermsDays: 30,
    primaryZone: 'sydney',
    riskAssessmentRequired: false,
    approveNewSupervisors: false,
    certificateEmail: null,
    preferredPickupWindow: null,
    notes: 'Estate finished in 2025 — kept for invoice history.',
  },
];

interface DriverSeed {
  name: string;
  mobile: string;
  brandIds: BrandId[];
  status: 'active' | 'invited' | 'suspended';
  employment: 'subcontractor' | 'employee';
  dailyJobCapacity: number;
  startedOn: string;

  /** Drives the credential mix below — see `CREDENTIAL_PLANS`. */
  credentialPlan: 'clean' | 'due-soon' | 'expired' | 'missing-medical';
}

/**
 * Five more drivers on top of Troy Holm, who `seed-auth` already creates.
 *
 * The compliance states are the point of the list. Fleet's whole reason for
 * existing is answering "who is legal to send out tomorrow", and a roster where
 * everybody is compliant cannot demonstrate that it would notice if somebody
 * were not — so one licence is expiring, one crane ticket has lapsed, and one
 * driver has no medical on file at all.
 */
const DRIVERS: readonly DriverSeed[] = [
  {
    name: 'Jason Whitfield',
    mobile: '0455220011',
    brandIds: ['plastago'],
    status: 'active',
    employment: 'employee',
    dailyJobCapacity: 9,
    startedOn: '2023-02-13',
    credentialPlan: 'clean',
  },
  {
    name: 'Sione Tupou',
    mobile: '0455330022',
    brandIds: ['plastago', 'easylift'],
    status: 'active',
    employment: 'employee',
    dailyJobCapacity: 8,
    startedOn: '2024-07-01',
    credentialPlan: 'due-soon',
  },
  {
    name: 'Craig Mullins',
    mobile: '0455440033',
    brandIds: ['plastago', 'easylift'],
    status: 'active',
    employment: 'subcontractor',
    dailyJobCapacity: 7,
    startedOn: '2022-09-19',
    credentialPlan: 'expired',
  },
  {
    name: 'Dylan Roach',
    mobile: '0455550044',
    brandIds: ['plastago'],
    status: 'active',
    employment: 'subcontractor',
    dailyJobCapacity: 6,
    startedOn: '2025-11-03',
    credentialPlan: 'missing-medical',
  },
  {
    name: 'Ben Ashcroft',
    mobile: '0455660055',
    brandIds: ['plastago'],
    status: 'suspended',
    employment: 'subcontractor',
    dailyJobCapacity: 8,
    startedOn: '2021-04-06',
    credentialPlan: 'expired',
  },
];

/**
 * Credential dates, expressed as days from today so the expiry states stay
 * true whenever the seeder is run. `null` means the credential is not on file,
 * which is a different failure from an expired one and shows differently.
 */
const CREDENTIAL_PLANS: Record<
  DriverSeed['credentialPlan'],
  ReadonlyArray<{ type: CredentialType; expiresInDays: number | null }>
> = {
  clean: [
    { type: 'drivers-licence', expiresInDays: 640 },
    { type: 'white-card', expiresInDays: 900 },
    { type: 'crane-ticket-class-3', expiresInDays: 410 },
    { type: 'hvnl-medical', expiresInDays: 300 },
  ],
  'due-soon': [
    { type: 'drivers-licence', expiresInDays: 21 },
    { type: 'white-card', expiresInDays: 700 },
    { type: 'crane-ticket-class-4', expiresInDays: 260 },
    { type: 'hvnl-medical', expiresInDays: 12 },
  ],
  expired: [
    { type: 'drivers-licence', expiresInDays: 520 },
    { type: 'white-card', expiresInDays: 1100 },
    { type: 'crane-ticket-class-3', expiresInDays: -34 },
    { type: 'hvnl-medical', expiresInDays: 180 },
  ],
  'missing-medical': [
    { type: 'drivers-licence', expiresInDays: 380 },
    { type: 'white-card', expiresInDays: 640 },
    { type: 'crane-ticket-class-3', expiresInDays: 95 },
    { type: 'hvnl-medical', expiresInDays: null },
  ],
};

interface VehicleSeed {
  rego: string;
  label: string;
  type: 'crane-truck' | 'hooklift' | 'ute';
  make: string;
  model: string;
  year: number;
  odometerKm: number;
  active: boolean;
  driverName: string | null;
  regoExpiresInDays: number;
  serviceDueInDays: number | null;
  notes: string;
}

/** Registration and service dates are relative for the same reason as above. */
const VEHICLES: readonly VehicleSeed[] = [
  {
    rego: 'BQ12AB',
    label: 'Truck 1 — Isuzu crane',
    type: 'crane-truck',
    make: 'Isuzu',
    model: 'FVZ 260-300',
    year: 2021,
    odometerKm: 214_880,
    active: true,
    driverName: 'Troy Holm',
    regoExpiresInDays: 168,
    serviceDueInDays: 24,
    notes: 'Palfinger PK 12.001 crane, 3.2t at 3m.',
  },
  {
    rego: 'CD34EF',
    label: 'Truck 2 — Hino crane',
    type: 'crane-truck',
    make: 'Hino',
    model: '500 FG 1628',
    year: 2022,
    odometerKm: 149_320,
    active: true,
    driverName: 'Jason Whitfield',
    regoExpiresInDays: 19,
    serviceDueInDays: -6,
    notes: 'Service overdue — booked in at Blacktown.',
  },
  {
    rego: 'EF56GH',
    label: 'Truck 3 — Isuzu hooklift',
    type: 'hooklift',
    make: 'Isuzu',
    model: 'FVR 165-300',
    year: 2020,
    odometerKm: 301_455,
    active: true,
    driverName: 'Sione Tupou',
    regoExpiresInDays: 292,
    serviceDueInDays: 61,
    notes: 'Carries the 5m, 10m and 15m hook bins.',
  },
  {
    rego: 'GH78IJ',
    label: 'Truck 4 — Fuso crane',
    type: 'crane-truck',
    make: 'Fuso',
    model: 'Fighter 1627',
    year: 2019,
    odometerKm: 388_110,
    active: true,
    driverName: 'Craig Mullins',
    regoExpiresInDays: -11,
    serviceDueInDays: 40,
    notes: 'Registration lapsed — off the road until renewed.',
  },
  {
    rego: 'JK90LM',
    label: 'Ute — site checks',
    type: 'ute',
    make: 'Toyota',
    model: 'Hilux SR',
    year: 2023,
    odometerKm: 62_740,
    active: true,
    driverName: 'Dylan Roach',
    regoExpiresInDays: 233,
    serviceDueInDays: 118,
    notes: '',
  },
  {
    rego: 'MN12OP',
    label: 'Truck 5 — spare',
    type: 'crane-truck',
    make: 'Isuzu',
    model: 'FVZ 260-300',
    year: 2016,
    odometerKm: 522_006,
    active: false,
    driverName: null,
    regoExpiresInDays: -240,
    serviceDueInDays: null,
    notes: 'Retired from the run roster, kept for parts.',
  },
];

/** The builder on the ground, which is rarely the account being invoiced. */
const BUILDERS = [
  'GJ Gardner',
  'Metricon',
  'Masterton Homes',
  'Eden Brae Homes',
  'McDonald Jones',
  'Coral Homes',
  'Beechwood Homes',
  '',
] as const;

const STREETS = [
  'Allambie Circuit',
  'Kingsbury Road',
  'Fairwater Drive',
  'Sundance Way',
  'Pembroke Parade',
  'Braeburn Street',
  'Tallowwood Avenue',
  'Grazier Crescent',
  'Riverbank Drive',
  'Halloran Street',
  'Cudgegong Road',
  'Bunya Close',
  'Wattlebird Grove',
  'Emerald Hills Boulevard',
  'Ridgeline Drive',
  'Stonecutters Way',
] as const;

/* ══ Working types ══════════════════════════════════════════════════════════ */
interface SeededAccount extends AccountSeed {
  id: mongoose.Types.ObjectId;
}

interface SeededDriver {
  id: mongoose.Types.ObjectId;
  name: string;
  capacity: number;
}

interface SeededPlace {
  suburb: string;
  postcode: string;
  zone: Zone;
  latitude: number;
  longitude: number;
}

/** `serviceCharge` and `ratePerM2` in integer cents, keyed `card:zone`. */
type RateTable = Map<string, { serviceCharge: number; ratePerM2: number }>;

interface JobDraft {
  id: mongoose.Types.ObjectId;
  jobNumber: number;
  status: string;
  account: SeededAccount;
  place: SeededPlace;
  readyDate: string;
  targetDate: string;
  driver: SeededDriver | null;
  runId: mongoose.Types.ObjectId | null;
  runSequence: number | null;
  completedAt: Date | null;
  expectedAreaM2: number | null;
  recoveredWeightKg: number | null;
  totalExGstCents: number;
  exceptionReason: ExceptionReason | null;
  exceptionNote: string | null;
  invoiceNumber: number | null;
  doc: Record<string, unknown>;
}

/* ══ Section 1 — accounts, their contacts and their terms ═══════════════════ */
async function seedAccounts(): Promise<SeededAccount[]> {
  const seeded: SeededAccount[] = [];
  const accountDocs: Record<string, unknown>[] = [];
  const contactDocs: Record<string, unknown>[] = [];
  const termsDocs: Record<string, unknown>[] = [];
  for (const seed of ACCOUNTS) {
    const id = oid();
    seeded.push({ ...seed, id });
    const slug = seed.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    accountDocs.push({
      _id: id,
      code: seed.code,
      name: seed.name,
      tradingName: seed.tradingName,
      accountType: seed.accountType,
      brandId: seed.brandId,
      rateCardId: seed.rateCardId,
      poPolicy: seed.poPolicy,
      captureMode: seed.captureMode,
      status: seed.status,
      abn: seed.abn,
      paymentTermsDays: seed.paymentTermsDays,
      primaryZone: seed.primaryZone,
      riskAssessmentRequired: seed.riskAssessmentRequired,
      approveNewSupervisors: seed.approveNewSupervisors,
      certificateEmail: seed.certificateEmail,
      preferredPickupWindow: seed.preferredPickupWindow,
      addressLine: `Unit ${String(int(1, 24))}, ${String(int(2, 180))} ${pick(STREETS)}`,
      suburb: pick(['Norwest', 'Rouse Hill', 'Campbelltown', 'Warabrook', 'Unanderra']),
      postcode: pick(['2153', '2155', '2560', '2304', '2526']),
      notes: seed.notes,
    });

    /*
     * Three contact roles, because they are three different jobs at the
     * customer: the site contact takes the "driver is on the way" text, accounts
     * gets the invoice, and sustainability is who the diversion certificate is
     * addressed to. Only the accounts contact is universal — a small contractor
     * has no sustainability officer, and pretending otherwise puts a certificate
     * in a mailbox nobody reads.
     */
    contactDocs.push({
      accountId: id,
      name: pick(['Dave Miller', 'Karen Whitby', 'Nick Farrugia', 'Sarah Nguyen']),
      role: 'site',
      email: `site@${slug}.com.au`,
      mobile: `04${String(int(10, 99))}${String(int(100_000, 999_999))}`,
      notifyBySms: true,
      notifyByEmail: false,
    });
    contactDocs.push({
      accountId: id,
      name: pick(['Angela Fitzgerald', 'Peter Lam', 'Robyn Cassidy', 'Tomas Herrera']),
      role: 'accounts',
      email: `accounts@${slug}.com.au`,
      mobile: null,
      notifyBySms: false,
      notifyByEmail: true,
    });
    if (seed.certificateEmail) {
      contactDocs.push({
        accountId: id,
        name: pick(['Lucy Bartlett', 'Marcus Reed', 'Hannah Doyle']),
        role: 'sustainability',
        email: seed.certificateEmail,
        mobile: null,
        notifyBySms: false,
        notifyByEmail: true,
      });
    }

    /*
     * Terms are accepted by everyone except Newlands, so the portal's
     * awaiting-terms gate has a live example behind it rather than only a code
     * path.
     */
    if (seed.code !== 'NEW001') {
      termsDocs.push({
        accountId: id,
        acceptedAt: at(day(-int(60, 400)), 10, int(0, 59)),
        acceptedByName: pick(['Angela Fitzgerald', 'Robert Clarendon', 'Peter Lam']),
        acceptedByRole: 'Accounts Manager',
        termsVersion: '2026-01',
      });
    }
  }
  await AccountModel.insertMany(accountDocs);
  await ContactModel.insertMany(contactDocs);
  await TermsAcceptanceModel.insertMany(termsDocs);
  log.info({ accounts: accountDocs.length, contacts: contactDocs.length }, 'accounts seeded');
  return seeded;
}

/* ══ Section 2 — the people ═════════════════════════════════════════════════ */
interface People {
  drivers: SeededDriver[];

  /** Every office-side user, for authoring comments and approvals. */
  staff: Map<string, { id: mongoose.Types.ObjectId; name: string; role: string }>;
  portalUsers: Array<{
    id: mongoose.Types.ObjectId;
    name: string;
    accountId: mongoose.Types.ObjectId;
    role: string;
    /**
     * Whether this person could actually have raised a booking.
     *
     * Somebody still on an invitation has never signed in, and somebody
     * awaiting their administrator's approval cannot act yet — so neither can
     * be the booker of a job that already exists. Attributing work to them
     * also thins out the share belonging to the supervisors you CAN sign in
     * as, which is how a demo login ends up showing two jobs.
     */
    canBook: boolean;
  }>;
}

async function seedPeople(accounts: readonly SeededAccount[]): Promise<People> {
  const byCode = new Map(accounts.map((account) => [account.code, account]));
  const requireAccount = (code: string): SeededAccount => {
    const account = byCode.get(code);
    if (!account) throw new Error(`no seeded account ${code}`);
    return account;
  };

  /*
   * `seed-auth` owns the sign-in accounts and has already written them. This
   * script must not recreate them — a second Matthew Browne would collide on
   * the unique email index, and re-seeding them here would mean two places
   * decide what the demo logins are.
   */
  const existing = await UserModel.find(
    {},
    { name: 1, email: 1, phoneNumber: 1, role: 1, roles: 1, status: 1 },
  ).lean<
    Array<{
      _id: mongoose.Types.ObjectId;
      name: string;
      email: string | null;
      phoneNumber: string | null;
      role: string;
      roles: string[];
      status: string;
    }>
  >();
  if (existing.length === 0) {
    throw new Error('no users — run `npm run seed:auth` before this script');
  }
  const staff = new Map<string, { id: mongoose.Types.ObjectId; name: string; role: string }>();
  for (const user of existing) {
    staff.set(user.name, { id: user._id, name: user.name, role: user.role });
  }

  /*
   * The two portal identities `seed-auth` creates carry no `accountId` — it
   * cannot set one, because accounts do not exist until this script runs. An
   * unlinked customer user signs in to a portal with nothing in it, so linking
   * them is the first thing here rather than an afterthought.
   */
  const iplasta = requireAccount('IPL001');
  await UserModel.updateMany(
    { email: 'accounts@iplasta.com.au' },
    { $set: { accountId: iplasta.id } },
  ).exec();
  await UserModel.updateMany(
    { phoneNumber: '0466778899' },
    { $set: { accountId: iplasta.id } },
  ).exec();
  /*
   * ⚠️ BOTH of them, not just the administrator.
   *
   * A site supervisor's scope is the jobs they RAISED (`bookedByUserId`) — with
   * sites removed there is nothing else left to scope on. So a supervisor who
   * is not in this list is never chosen as a booker, and signing in as them
   * shows a portal with nothing in it. `0466778899` is one of the two portal
   * logins the seeder prints, which makes that a demo that fails on the second
   * click.
   */
  const portalUsers: People['portalUsers'] = [];
  for (const user of existing) {
    if (user.email === 'accounts@iplasta.com.au') {
      portalUsers.push({
        id: user._id,
        name: user.name,
        accountId: iplasta.id,
        role: 'customer-administrator',
        canBook: true,
      });
    }
    if (user.phoneNumber === '0466778899') {
      portalUsers.push({
        id: user._id,
        name: user.name,
        accountId: iplasta.id,
        role: 'customer-site-supervisor',
        canBook: true,
      });
    }
  }
  const userDocs: Record<string, unknown>[] = [];

  /* ── More portal people, so the portal is not a single account ─────────── */
  const portalSeeds = [
    {
      name: 'Robert Clarendon',
      email: 'admin@clarendonhomes.com.au',
      mobile: null,
      role: 'customer-administrator',
      code: 'CLA001',
      status: 'active',
      awaitingApproval: false,
      jobTitle: 'Construction Manager',
    },
    {
      name: 'Sam Farrar',
      email: null,
      mobile: '0400777666',
      role: 'customer-site-supervisor',
      code: 'CLA001',
      status: 'active',
      awaitingApproval: false,
      jobTitle: 'Site Supervisor',
    },
    {
      // Invited but never signed in — the state the supervisors screen exists
      // to chase up.
      name: 'Josh Petrie',
      email: null,
      mobile: '0400777555',
      role: 'customer-site-supervisor',
      code: 'CLA001',
      status: 'invited',
      awaitingApproval: false,
      jobTitle: 'Site Supervisor',
    },
    {
      // Clarendon has `approveNewSupervisors`, so this one is waiting on their
      // administrator rather than on us.
      name: 'Nadia Kaur',
      email: null,
      mobile: '0400777444',
      role: 'customer-site-supervisor',
      code: 'CLA001',
      status: 'active',
      awaitingApproval: true,
      jobTitle: 'Site Supervisor',
    },
    {
      /*
       * iPlasta's own supervisors. `seed-auth` gives the account one
       * (Dave Nguyen) and a list of one cannot show a list: no invite to
       * chase, no approval to grant, nothing to sort. These three put the
       * screen in every state it has.
       */
      name: 'Leah Brennan',
      email: null,
      mobile: '0466778111',
      role: 'customer-site-supervisor',
      code: 'IPL001',
      status: 'active',
      awaitingApproval: false,
      jobTitle: 'Site Supervisor',
    },
    {
      name: 'Ryan Tuiloma',
      email: null,
      mobile: '0466778222',
      role: 'customer-site-supervisor',
      code: 'IPL001',
      status: 'invited',
      awaitingApproval: false,
      jobTitle: 'Site Supervisor',
    },
    {
      // Waiting on Angela, not on us — iPlasta approves its own supervisors.
      name: 'Chris Halvorsen',
      email: null,
      mobile: '0466778333',
      role: 'customer-site-supervisor',
      code: 'IPL001',
      status: 'active',
      awaitingApproval: true,
      jobTitle: 'Site Supervisor',
    },
    {
      name: 'Peter Lam',
      email: 'admin@domainehomes.com.au',
      mobile: null,
      role: 'customer-administrator',
      code: 'DOM001',
      status: 'active',
      awaitingApproval: false,
      jobTitle: 'Accounts Manager',
    },
    {
      name: 'Robyn Cassidy',
      email: 'admin@wisdomhomes.com.au',
      mobile: null,
      role: 'customer-administrator',
      code: 'WIS001',
      status: 'active',
      awaitingApproval: false,
      jobTitle: 'Contract Administrator',
    },
    {
      name: 'Wayne Ellis',
      email: null,
      mobile: '0400888333',
      role: 'customer-site-supervisor',
      code: 'WIS001',
      status: 'active',
      awaitingApproval: false,
      jobTitle: 'Site Supervisor',
    },
    {
      name: 'Tomas Herrera',
      email: 'admin@rawsonhomes.com.au',
      mobile: null,
      role: 'customer-administrator',
      code: 'RAW001',
      status: 'active',
      awaitingApproval: false,
      jobTitle: 'Accounts Manager',
    },
    {
      name: 'Marco Fornari',
      email: 'marco@fornarigroup.com.au',
      mobile: null,
      role: 'customer-administrator',
      code: 'FOR001',
      status: 'active',
      awaitingApproval: false,
      jobTitle: 'Director',
    },
  ] as const;
  for (const seed of portalSeeds) {
    const id = oid();
    const account = requireAccount(seed.code);
    portalUsers.push({
      id,
      name: seed.name,
      accountId: account.id,
      role: seed.role,
      canBook: seed.status === 'active' && !seed.awaitingApproval,
    });
    userDocs.push({
      _id: id,
      name: seed.name,
      email: seed.email,
      emailVerified: seed.status === 'active' && seed.email !== null,
      phoneNumber: seed.mobile,
      phoneNumberVerified: seed.status === 'active' && seed.mobile !== null,
      image: null,
      role: seed.role,
      roles: [seed.role],
      status: seed.status,
      jobTitle: `${seed.jobTitle}, ${account.name}`,
      accountId: account.id,
      brandIds: [account.brandId],
      awaitingApproval: seed.awaitingApproval,
      lastSignedInAt:
        seed.status === 'invited' ? null : at(day(-int(0, 9)), int(7, 17), int(0, 59)),
      notes: '',
    });
  }

  /* ── One more office user, invited and never arrived ───────────────────── */
  userDocs.push({
    _id: oid(),
    name: 'Harriet Vaughn',
    email: 'harriet@plastago.com.au',
    emailVerified: false,
    phoneNumber: null,
    phoneNumberVerified: false,
    image: null,
    role: 'operations',
    roles: ['operations'],
    status: 'invited',
    jobTitle: 'Operations Coordinator',
    accountId: null,
    brandIds: ['plastago', 'easylift'],
    awaitingApproval: false,
    lastSignedInAt: null,
    notes: 'Starts next month.',
  });

  /* ── Drivers, and the compliance records behind them ───────────────────── */
  const drivers: SeededDriver[] = [];
  const rosterDocs: Record<string, unknown>[] = [];
  const credentialDocs: Record<string, unknown>[] = [];
  const trainingDocs: Record<string, unknown>[] = [];
  /*
   * The drivers `seed-auth` already created get their compliance records here
   * like everybody else — otherwise the one driver you can actually sign in as
   * is the one with nothing on file.
   */
  const inherited = existing.filter((user) => user.roles.includes('driver'));
  if (inherited.length === 0) {
    throw new Error('no driver from seed-auth — run `npm run seed:auth` first');
  }

  for (const user of inherited) {
    /*
     * ⚠️ Every driver, not just the one whose PRIMARY role is driver.
     *
     * Matt, 27:01 — an allocator who covers a shift holds both roles, and
     * `seed-auth` models that with Dean Kelly. The fleet screen lists anyone
     * who holds the role, so skipping him would put a driver on the roster
     * with no licence, no medical and no ticket: an unanswerable red row that
     * is a bug in the data rather than a compliance finding.
     */
    rosterDocs.push({
      userId: user._id,
      employment: 'subcontractor',
      dailyJobCapacity: 8,
      startedOn: '2022-03-14',
      notes: user.role === 'driver' ? 'South Coast run most mornings.' : 'Covers driver shifts.',
    });
    for (const credential of CREDENTIAL_PLANS.clean) {
      credentialDocs.push(buildCredential(user._id, credential));
    }
    // Only somebody whose actual job is driving gets put on a run. An
    // allocator covering the odd shift is not the roster's baseline.
    if (user.role === 'driver' && user.status === 'active') {
      drivers.push({ id: user._id, name: user.name, capacity: 8 });
    }
  }
  for (const seed of DRIVERS) {
    const id = oid();
    userDocs.push({
      _id: id,
      name: seed.name,
      // SMS-first, like Troy: a driver on a building site has no email to
      // check (§9 A2).
      email: null,
      emailVerified: false,
      phoneNumber: seed.mobile,
      phoneNumberVerified: seed.status === 'active',
      image: null,
      role: 'driver',
      roles: ['driver'],
      status: seed.status,
      jobTitle: 'Driver',
      accountId: null,
      brandIds: seed.brandIds,
      awaitingApproval: false,
      lastSignedInAt: seed.status === 'active' ? at(day(-int(0, 2)), int(5, 8), int(0, 59)) : null,
      notes: '',
    });
    rosterDocs.push({
      userId: id,
      employment: seed.employment,
      dailyJobCapacity: seed.dailyJobCapacity,
      startedOn: seed.startedOn,
      notes: '',
    });
    for (const credential of CREDENTIAL_PLANS[seed.credentialPlan]) {
      credentialDocs.push(buildCredential(id, credential));
    }
    trainingDocs.push({
      userId: id,
      name: 'Chain of Responsibility refresher',
      completedOn: day(-int(30, 500)),
      expiresOn: day(int(60, 700)),
      provider: 'NatRoad',
    });
    if (chance(0.6)) {
      trainingDocs.push({
        userId: id,
        name: 'Load restraint and crane safety',
        completedOn: day(-int(30, 400)),
        expiresOn: chance(0.5) ? day(int(20, 500)) : null,
        provider: 'SafeWork NSW',
      });
    }
    // Only active drivers can take a run.
    if (seed.status === 'active') {
      drivers.push({ id, name: seed.name, capacity: seed.dailyJobCapacity });
    }
  }
  await UserModel.insertMany(userDocs);
  await DriverRosterModel.insertMany(rosterDocs);
  await DriverCredentialModel.insertMany(credentialDocs);
  await DriverTrainingModel.insertMany(trainingDocs);

  /* ── Devices and sign-in history ───────────────────────────────────────── */
  const deviceDocs: Record<string, unknown>[] = [];
  drivers.forEach((driver, index) => {
    /*
     * One driver's queue is deliberately stuck. "Pending sync actions" is the
     * number the office looks at to know whether a driver's completions have
     * actually landed, and a column of zeroes proves nothing about whether it
     * would show a problem.
     */
    const stuck = index === 2;
    deviceDocs.push({
      userId: driver.id,
      label: pick(['iPhone 14', 'iPhone 13', 'Samsung Galaxy A54', 'Pixel 8']),
      platform: chance(0.6) ? 'ios' : 'android',
      deviceKey: `demo-device-${driver.id.toHexString().slice(-8)}`,
      lastSeenAt: at(TODAY, int(6, 10), int(0, 59)),
      lastSyncAt: stuck ? at(day(-1), 15, 42) : at(TODAY, int(6, 10), int(0, 59)),
      pendingSyncActions: stuck ? 4 : 0,
      revokedAt: null,
      revokedBy: null,
    });
  });
  await UserDeviceModel.insertMany(deviceDocs);
  const signInDocs: Record<string, unknown>[] = [];
  const signInPool: Array<{ id: mongoose.Types.ObjectId; channel: 'email' | 'sms' }> = drivers.map(
    (driver) => ({ id: driver.id, channel: 'sms' }),
  );
  for (const [name, user] of staff) {
    if (name === 'Former Staffer') continue;
    signInPool.push({ id: user.id, channel: 'email' });
  }
  for (let offset = -30; offset <= 0; offset += 1) {
    const date = day(offset);
    if (isWeekend(date)) continue;
    for (const entry of signInPool) {
      if (!chance(0.45)) continue;
      signInDocs.push({
        userId: entry.id,
        identifierMasked: entry.channel === 'sms' ? '04•• ••• •55' : '•••@plastago.com.au',
        at: at(date, int(6, 17), int(0, 59)),
        channel: entry.channel,
        outcome: chance(0.94) ? 'success' : pick(['failed-code', 'expired-code']),
        device: pick([
          'Chrome on Windows',
          'Safari on iOS',
          'Chrome on Android',
          'Edge on Windows',
        ]),
        ipPrefix: pick(['203.0.113', '198.51.100', '192.0.2']),
      });
    }
  }
  await UserSignInModel.insertMany(signInDocs);
  log.info(
    { users: userDocs.length, drivers: drivers.length, signIns: signInDocs.length },
    'people seeded',
  );
  return { drivers, staff, portalUsers };
}

/** A credential row, with `issuedOn` back-dated from the expiry it carries. */
function buildCredential(
  userId: mongoose.Types.ObjectId,
  credential: { type: CredentialType; expiresInDays: number | null },
): Record<string, unknown> {
  const expiresOn = credential.expiresInDays === null ? null : day(credential.expiresInDays);
  return {
    userId,
    type: credential.type,
    // A credential that is not on file has no reference either — an empty row
    // with a number on it reads as "we have it", which is the wrong answer.
    reference:
      expiresOn === null
        ? null
        : `${credential.type.slice(0, 3).toUpperCase()}-${String(int(100_000, 999_999))}`,
    issuedOn: expiresOn === null ? null : day((credential.expiresInDays ?? 0) - 365 * int(1, 5)),
    expiresOn,
    storageKey: null,
  };
}

/* ══ Section 3 — the fleet ══════════════════════════════════════════════════ */

interface AssignedTruck {
  rego: string;
  label: string;
}

async function seedFleet(people: People): Promise<Map<string, AssignedTruck>> {
  const vehicleDocs: Record<string, unknown>[] = [];
  const expenseDocs: Record<string, unknown>[] = [];
  const defectDocs: Record<string, unknown>[] = [];

  /*
   * driverName → the truck they drive, carrying BOTH identifiers.
   *
   * A run is labelled with the friendly name, because that is what the
   * allocator says out loud; a pre-start records the REGO, because that is
   * what the Chain of Responsibility record has to name. One map holding one
   * string cannot serve both, and either choice leaves a screen showing the
   * wrong kind of identifier.
   */
  const truckByDriver = new Map<string, AssignedTruck>();
  for (const seed of VEHICLES) {
    const id = oid();
    if (seed.driverName) {
      truckByDriver.set(seed.driverName, { rego: seed.rego, label: seed.label });
    }
    vehicleDocs.push({
      _id: id,
      rego: seed.rego,
      label: seed.label,
      type: seed.type,
      make: seed.make,
      model: seed.model,
      year: seed.year,
      odometerKm: seed.odometerKm,
      active: seed.active,
      assignedDriverName: seed.driverName,
      registrationExpiresOn: day(seed.regoExpiresInDays),
      registrationPeriodMonths: 12,
      nextServiceDueOn: seed.serviceDueInDays === null ? null : day(seed.serviceDueInDays),
      purchasedOn: `${String(seed.year)}-${String(int(1, 12)).padStart(2, '0')}-14`,
      notes: seed.notes,
    });

    /*
     * A year of running costs per truck. The cost-per-job figure on the reports
     * screen is derived from these, so a fleet with no expense history renders
     * a chart with no bars — which looks like the report is broken rather than
     * like the trucks are free.
     */
    for (let month = 1; month <= 12; month += 1) {
      if (!chance(0.7)) continue;
      const kind = pick(['service', 'repair', 'tyres', 'registration', 'other'] as const);
      const cents = {
        service: int(45_000, 120_000),
        repair: int(20_000, 380_000),
        tyres: int(90_000, 260_000),
        registration: int(85_000, 145_000),
        other: int(5_000, 40_000),
      }[kind];
      expenseDocs.push({
        vehicleId: id,
        incurredOn: day(-month * 30 + int(0, 20)),
        odometerKm: seed.odometerKm - month * int(1_500, 4_000),
        kind,
        description: {
          service: 'Scheduled service — oil, filters, crane inspection',
          repair: 'Repair — hydraulic hose and fitting',
          tyres: 'Two drive tyres replaced',
          registration: 'NSW registration renewal',
          other: 'Wash and detail',
        }[kind],
        amountExGst: decimal(cents),
        supplier: pick(['Suttons Trucks', 'Beaurepaires', 'Service NSW', 'Westside Diesel']),
        recordedBy: 'Priya Raman',
      });
    }
  }

  /*
   * Defects at every severity and every state. `unroadworthy` and `open`
   * together is the pairing the fleet screen is meant to shout about, so one
   * row sits in exactly that combination.
   */
  const driverForDefect = people.drivers[0] ?? null;
  const secondDriver = people.drivers[1] ?? driverForDefect;
  if (driverForDefect && secondDriver) {
    defectDocs.push(
      {
        vehicleRego: 'GH78IJ',
        reportedByUserId: secondDriver.id,
        reportedByName: secondDriver.name,
        severity: 'unroadworthy',
        summary: 'Registration lapsed — truck cannot leave the yard',
        detail: 'Picked up at pre-start. Renewal lodged, waiting on Service NSW.',
        photoIds: [],
        occurredAt: at(day(-2), 6, 15),
        latitude: -33.7602,
        longitude: 150.8931,
        preStartId: null,
        preStartItemKey: 'documents',
        status: 'open',
        scheduledFor: null,
        resolvedAt: null,
        resolutionNote: null,
      },
      {
        vehicleRego: 'CD34EF',
        reportedByUserId: driverForDefect.id,
        reportedByName: driverForDefect.name,
        severity: 'needs-attention',
        summary: 'Service brake feels soft below 20km/h',
        detail: 'Pedal travel longer than usual. Still stopping, but not right.',
        photoIds: [],
        occurredAt: at(day(-5), 6, 40),
        latitude: -33.7211,
        longitude: 150.9048,
        preStartId: null,
        preStartItemKey: 'brakes',
        status: 'scheduled',
        scheduledFor: at(day(3), 8, 0),
        resolvedAt: null,
        resolutionNote: null,
      },
      {
        vehicleRego: 'BQ12AB',
        reportedByUserId: driverForDefect.id,
        reportedByName: driverForDefect.name,
        severity: 'monitor',
        summary: 'Nearside mirror vibrates on the highway',
        detail: '',
        photoIds: [],
        occurredAt: at(day(-19), 7, 5),
        latitude: -34.4278,
        longitude: 150.8931,
        preStartId: null,
        preStartItemKey: 'mirrors',
        status: 'resolved',
        scheduledFor: null,
        resolvedAt: at(day(-12), 14, 30),
        resolutionNote: 'Mount re-tightened at the yard.',
      },
    );
  }
  await VehicleModel.insertMany(vehicleDocs);
  await VehicleExpenseModel.insertMany(expenseDocs);
  await VehicleDefectModel.insertMany(defectDocs);
  log.info(
    { vehicles: vehicleDocs.length, expenses: expenseDocs.length, defects: defectDocs.length },
    'fleet seeded',
  );
  return truckByDriver;
}

/* ══ Section 4 — jobs ═══════════════════════════════════════════════════════ */
interface JobOptions {
  account: SeededAccount;
  readyDate: string;
  status: string;
  driver: SeededDriver | null;
  runId: mongoose.Types.ObjectId | null;
  runSequence: number | null;
  completedAt: Date | null;

  /** Only set where the job is deliberately late — otherwise the SLA decides. */
  targetDate?: string;
  bookedBy?: { name: string; userId: mongoose.Types.ObjectId | null; source: string };
  exception?: { reason: ExceptionReason; note: string | null };
}

interface JobFactory {
  next: (options: JobOptions) => JobDraft;
  drafts: JobDraft[];
}

/** Hook bins are the minority of the work, so they are the minority here. */
function pickFreightItem(): FreightItem {
  const roll = random();
  if (roll < 0.55) return 'plasterboard-hand-load';
  if (roll < 0.85) return 'plasterboard-bagged';
  if (roll < 0.93) return 'hook-bin-5';
  if (roll < 0.98) return 'hook-bin-10';
  return 'hook-bin-15';
}

/**
 * Builds one job, priced off the real rate card for its account and zone.
 *
 * Pricing is looked up rather than invented because the job, its invoice and
 * the reports all have to agree, and three independent guesses at a number
 * agree only by accident. Where a card has no rate for a zone the default card
 * stands in, so a demo job is never priced by a rule the product does not have.
 */
function makeJobFactory(
  places: readonly SeededPlace[],
  rates: RateTable,
  startNumber: number,
): JobFactory {
  const drafts: JobDraft[] = [];
  let jobNumber = startNumber;
  const next = (options: JobOptions): JobDraft => {
    const { account } = options;
    // Contractors travel; a builder's work sits in the estates it is building.
    const local = places.filter((candidate) => candidate.zone === account.primaryZone);
    const place =
      account.accountType === 'builder' && local.length > 0 && chance(0.75)
        ? pick(local)
        : pick(places);
    const rate =
      rates.get(`${account.rateCardId}:${place.zone}`) ?? rates.get(`default:${place.zone}`);
    if (!rate) throw new Error(`no rate for ${account.rateCardId}/${place.zone}`);

    /*
     * Wisdom's fixed price, Matt 31:04: their order carries a line item and no
     * square metres, so the job genuinely does not know its area. Null, never
     * zero — zero would price it at the call-out alone and silently drop the
     * stop out of the m²-weighted tip-off split.
     */
    const fixedPrice = account.rateCardId === 'wisdom';
    const expectedAreaM2 = fixedPrice ? null : area(120, 1_100);
    const totalExGstCents = fixedPrice
      ? rate.serviceCharge
      : rate.serviceCharge + Math.round((expectedAreaM2 ?? 0) * rate.ratePerM2);
    const gstCents = gstOf(totalExGstCents);
    const isDone = options.status === 'completed' || options.status === 'admin-complete';

    /*
     * 8.6 kg per m² is plasterboard's areal density at 10mm. Deriving the
     * weight from the area rather than rolling it independently is what keeps a
     * certificate's tonnes consistent with the m² printed beside them.
     */
    const recoveredWeightKg = !isDone
      ? null
      : expectedAreaM2 === null
        ? int(900, 2_400)
        : Math.round(expectedAreaM2 * 8.6 * (0.9 + random() * 0.2));
    const lotNumber = String(int(101, 486));
    const street = pick(STREETS);
    const streetNumber = int(2, 148);
    const id = oid();
    const number = jobNumber;
    jobNumber += 1;
    const targetDate = options.targetDate ?? addBusinessDays(options.readyDate, 5);
    const doc: Record<string, unknown> = {
      _id: id,
      jobNumber: number,
      status: options.status,
      accountId: account.id,
      accountName: account.name,
      brandId: account.brandId,
      builderName: account.accountType === 'contractor' ? pick(BUILDERS) : '',
      siteName: `Lot ${lotNumber} (#${String(streetNumber)}) ${street}`,
      lotNumber,
      addressLine: `${String(streetNumber)} ${street}`,
      suburb: place.suburb,
      postcode: place.postcode,
      zone: place.zone,
      latitude: place.latitude + (random() - 0.5) * 0.02,
      longitude: place.longitude + (random() - 0.5) * 0.02,
      accessNotes: chance(0.6)
        ? pick([
            'Enter from the west side, park on the verge',
            'Driveway is soft — stay on the road',
            'Board is stacked behind the garage',
            'Narrow street, no room to turn — reverse in',
            'Skip bin on the nature strip, crane over it',
          ])
        : '',
      gateHours: chance(0.5) ? pick(['7am-3pm', '6:30am-2:30pm', '7am-5pm']) : null,
      inductionRequired: account.code === 'NEW001' ? chance(0.8) : chance(0.25),
      craneAvailable: chance(0.7),
      siteContactName: chance(0.85)
        ? pick(['Dave Miller', 'Nick Farrugia', 'Karen Whitby', 'Sam Farrar'])
        : null,
      siteContactMobile: chance(0.85)
        ? `04${String(int(10, 99))}${String(int(100_000, 999_999))}`
        : null,
      siteContactEmail: chance(0.4) ? 'supervisor@builder.com.au' : null,
      poNumber: null,
      purchaseOrderId: null,
      bookedByName: options.bookedBy?.name ?? 'Renee Alvarez',
      bookedByUserId: options.bookedBy?.userId ?? null,
      bookedBySource: options.bookedBy?.source ?? 'office',
      readyDate: options.readyDate,
      targetDate,
      serviceLevel: chance(0.15) ? 'urgent' : 'standard',
      runId: options.runId,
      runSequence: options.runSequence,
      driverId: options.driver?.id ?? null,
      driverName: options.driver?.name ?? null,
      expectedAreaM2,
      recoveredWeightKg,
      recoveredWeightBasis:
        recoveredWeightKg === null
          ? null
          : account.captureMode === 'area-and-weight'
            ? 'actual'
            : 'estimated',
      bagCount: chance(0.3) ? int(1, 6) : 0,
      freightItem: pickFreightItem(),
      totalExGst: decimal(totalExGstCents),
      gst: decimal(gstCents),
      totalIncGst: decimal(totalExGstCents + gstCents),
      invoiceStatus: 'not-invoiced',
      invoiceNumber: null,
      invoicedAt: null,
      notes: chance(0.35)
        ? pick([
            'Board stacked near the garage',
            'Two loads if the pile is as described',
            'Call the supervisor before arriving',
          ])
        : '',
      exceptionReason: options.exception?.reason ?? null,
      exceptionNote: options.exception?.note ?? null,
      arrivedAt: null,
      onSiteMinutes: null,
      completedAt: options.completedAt,
      riskAssessmentRequired: account.riskAssessmentRequired && chance(0.7),
    };

    /*
     * Arrival and on-site duration only exist once a driver has been there. The
     * dashboard's median on-site time comes from these, so they have to spread
     * rather than all sit on one number.
     */
    if (options.completedAt) {
      const minutes = int(18, 75);
      doc.onSiteMinutes = minutes;
      doc.arrivedAt = new Date(options.completedAt.getTime() - minutes * 60_000);
    }
    const draft: JobDraft = {
      id,
      jobNumber: number,
      status: options.status,
      account,
      place,
      readyDate: options.readyDate,
      targetDate,
      driver: options.driver,
      runId: options.runId,
      runSequence: options.runSequence,
      completedAt: options.completedAt,
      expectedAreaM2,
      recoveredWeightKg,
      totalExGstCents,
      exceptionReason: options.exception?.reason ?? null,
      exceptionNote: options.exception?.note ?? null,
      invoiceNumber: null,
      doc,
    };
    drafts.push(draft);
    return draft;
  };
  return { next, drafts };
}

/* ══ Section 5 — the schedule: runs, and the jobs that sit on them ══════════ */
interface RunDraft {
  id: mongoose.Types.ObjectId;
  runNumber: number;
  name: string;
  date: string;
  status: string;
  driver: SeededDriver | null;
  vehicleLabel: string | null;
  sequenceForDay: number | null;
  stops: JobDraft[];
}

const ZONE_RUN_NAMES: Record<Zone, string> = {
  sydney: 'Sydney',
  wollongong: 'South Coast',
  newcastle: 'Newcastle',
};

/**
 * Twelve weeks of work, ending three weeks into the future.
 *
 * ── Why the shape is deliberate rather than uniform ────────────────────────
 * Three of the dashboard's charts read backwards from today over different
 * windows — thirty days of volume, twelve weeks of exception rates, this
 * month's totals — and a driver's run sheet reads forward from it. A flat
 * scatter of jobs satisfies none of them well: the far past only has to be
 * dense enough to draw a trend, while today has to hold every state a job can
 * be in at once, because today is the screen everybody looks at first.
 *
 * So the past thins out with distance, today is hand-built, and the future
 * tapers into unstaffed runs and an unallocated backlog — which is what an
 * allocator's Tuesday actually looks like.
 */
function buildSchedule(
  factory: JobFactory,
  accounts: readonly SeededAccount[],
  people: People,
  truckByDriver: Map<string, AssignedTruck>,
): RunDraft[] {
  const runs: RunDraft[] = [];
  let runNumber = 1;
  const { drivers } = people;
  if (drivers.length === 0) throw new Error('no active drivers to build a schedule from');
  const active = accounts.filter((account) => account.status === 'active');
  const retired = accounts.filter((account) => account.status === 'inactive');

  /** Clarendon does most of the work, which is why it is the demo's spine. */
  const weights = new Map<string, number>([
    ['CLA001', 26],
    ['DOM001', 14],
    ['WIS001', 12],
    ['IPL001', 15],
    ['FOR001', 10],
    ['NEW001', 9],
    ['RAW001', 9],
    ['ALL001', 5],
  ]);
  const weighted: SeededAccount[] = [];
  for (const account of active) {
    const weight = weights.get(account.code) ?? 4;
    for (let i = 0; i < weight; i += 1) weighted.push(account);
  }
  const bookedByFor = (account: SeededAccount): JobOptions['bookedBy'] => {
    /*
     * A supervisor's portal bookings are the ONLY jobs that supervisor can see
     * — with sites removed, `bookedByUserId` is the whole scope (M1.5). If no
     * job carries their id, their portal is correctly, and uselessly, empty.
     */
    const theirs = people.portalUsers.filter(
      (user) =>
        user.accountId.equals(account.id) &&
        user.role === 'customer-site-supervisor' &&
        user.canBook,
    );
    if (theirs.length > 0 && chance(0.45)) {
      const supervisor = pick(theirs);
      return { name: supervisor.name, userId: supervisor.id, source: 'portal' };
    }
    if (chance(0.15)) {
      return { name: 'Dean Kelly', userId: null, source: 'call-up' };
    }
    return { name: pick(['Renee Alvarez', 'Priya Raman']), userId: null, source: 'office' };
  };
  const newRun = (
    date: string,
    driver: SeededDriver | null,
    status: string,
    sequenceForDay: number | null,
    zone: Zone,
  ): RunDraft => {
    const run: RunDraft = {
      id: oid(),
      runNumber,
      name: `${ZONE_RUN_NAMES[zone]} run ${String(sequenceForDay ?? 1)}`,
      date,
      status,
      driver,
      vehicleLabel: driver ? (truckByDriver.get(driver.name)?.label ?? null) : null,
      sequenceForDay,
      stops: [],
    };
    runNumber += 1;
    runs.push(run);
    return run;
  };
  const addStop = (run: RunDraft, status: string, completedAt: Date | null): JobDraft => {
    const account = pick(weighted);
    const job = factory.next({
      account,
      readyDate: run.date,
      status,
      driver: run.driver,
      runId: run.id,
      runSequence: run.stops.length + 1,
      completedAt,
      bookedBy: bookedByFor(account),
    });
    run.stops.push(job);
    return job;
  };

  /* ── The past: twelve weeks of completed runs ──────────────────────────── */
  for (let offset = -84; offset <= -1; offset += 1) {
    const date = day(offset);
    if (isWeekend(date)) continue;
    // The last three weeks are dense because that is the window the charts and
    // the "recent activity" list read from.
    const recent = offset >= -21;
    if (!recent && !chance(0.4)) continue;
    /*
     * The last working week has EVERY driver out, rather than a sample.
     *
     * The run sheet takes a date so a driver can look back at yesterday —
     * that is what a forgotten tip-off is filed against. Sampling meant the
     * one driver you can sign in as might not have worked yesterday, and an
     * empty yesterday makes a working screen look broken.
     */
    const working =
      offset >= -5
        ? [...drivers]
        : [...drivers].sort(() => random() - 0.5).slice(0, recent ? 2 : 1);
    working.forEach((driver, index) => {
      const zone = pick(['sydney', 'sydney', 'sydney', 'wollongong', 'newcastle'] as const);
      const run = newRun(date, driver, 'closed', index + 1, zone);
      const stops = int(1, 3);
      for (let stop = 0; stop < stops; stop += 1) {
        /*
         * Roughly one stop in twelve is futile — a rate that is visible on the
         * exception chart without swamping it. A futile stop still has a
         * completion timestamp, because the driver did go there; what it does
         * not have is a recovered weight.
         */
        const futile = chance(0.08);
        const completedAt = at(date, 7 + stop * 2, int(0, 55));
        const job = addStop(run, futile ? 'futile' : 'completed', completedAt);
        if (futile) {
          job.doc.recoveredWeightKg = null;
          job.doc.recoveredWeightBasis = null;
          job.recoveredWeightKg = null;
          const reason = pick([
            'site-not-ready',
            'access-blocked',
            'nobody-on-site',
            'crane-unavailable',
          ] as const);
          job.exceptionReason = reason;
          job.doc.exceptionReason = reason;
          const note = {
            'site-not-ready': 'Board still on the walls, nothing stacked.',
            'access-blocked': 'Concrete truck across the driveway.',
            'nobody-on-site': 'Gate locked, nobody answering the site phone.',
            'crane-unavailable': 'No clear line for the crane — cars parked over the pile.',
          }[reason];
          job.exceptionNote = note;
          job.doc.exceptionNote = note;
        }
      }
    });
  }

  /*
   * A handful of jobs for the account that has since gone inactive, all old.
   * Its invoice history is the reason the account is kept at all, so it needs
   * one.
   */
  for (const account of retired) {
    for (let i = 0; i < 4; i += 1) {
      const date = toWeekday(day(-int(62, 84)));
      factory.next({
        account,
        readyDate: date,
        status: 'completed',
        driver: pick(drivers),
        runId: null,
        runSequence: null,
        completedAt: at(date, int(8, 14), int(0, 59)),
      });
    }
  }

  /* ── Cancellations, which never reach a run ────────────────────────────── */
  for (let i = 0; i < 6; i += 1) {
    const account = pick(weighted);
    const date = toWeekday(day(-int(3, 60)));
    factory.next({
      account,
      readyDate: date,
      status: 'cancelled',
      driver: null,
      runId: null,
      runSequence: null,
      completedAt: null,
      bookedBy: bookedByFor(account),
      exception: {
        reason: pick(['customer-request', 'site-closed', 'weather'] as const),
        note: pick([
          'Builder pushed the handover back a fortnight.',
          'Site shut for the Christmas break.',
          'Rained out — rebooked for next week.',
        ]),
      },
    });
  }

  /* ── Today, hand-built so every live state is on the board at once ─────── */
  const [first, second, third, fourth] = drivers;
  if (first) {
    // Mid-run: one stop done, one being worked, one still ahead.
    const run = newRun(TODAY, first, 'in-progress', 1, 'sydney');
    addStop(run, 'completed', at(TODAY, 7, 42));
    const arrived = addStop(run, 'arrived', null);
    arrived.doc.arrivedAt = at(TODAY, 9, 15);
    addStop(run, 'assigned', null);
  }
  if (second) {
    const run = newRun(TODAY, second, 'in-progress', 1, 'wollongong');
    addStop(run, 'completed', at(TODAY, 7, 20));
    addStop(run, 'completed', at(TODAY, 9, 5));
    addStop(run, 'in-transit', null);
  }
  if (third) {
    // Staffed but not started — the ordinary state of an afternoon run.
    const run = newRun(TODAY, third, 'assigned', 1, 'newcastle');
    addStop(run, 'assigned', null);
    addStop(run, 'assigned', null);
  }
  if (fourth) {
    const run = newRun(TODAY, fourth, 'assigned', 1, 'sydney');
    addStop(run, 'assigned', null);
    addStop(run, 'assigned', null);
    addStop(run, 'assigned', null);
  }

  /*
   * An unstaffed run on the board today. Its stops stay `booked`, because a job
   * is not assigned until somebody is going to do it — which is exactly the
   * distinction the allocation board is drawing.
   */
  const unstaffed = newRun(TODAY, null, 'planning', null, 'sydney');
  addStop(unstaffed, 'booked', null);
  addStop(unstaffed, 'booked', null);

  /* ── Tomorrow and the day after: built, staffed, not yet started ───────── */
  const tomorrow = isWeekend(day(1)) ? day(3) : day(1);
  const dayAfter = isWeekend(day(2)) ? day(4) : day(2);
  drivers.slice(0, 3).forEach((driver, index) => {
    const run = newRun(
      tomorrow,
      driver,
      'assigned',
      1,
      pick(['sydney', 'wollongong', 'newcastle'] as const),
    );
    const stops = int(2, 3);
    for (let stop = 0; stop < stops; stop += 1) addStop(run, 'assigned', null);
    // Matt, 40:03 — a driver normally takes two runs in a day. One of them does.
    if (index === 0) {
      const second = newRun(tomorrow, driver, 'assigned', 2, 'sydney');
      addStop(second, 'assigned', null);
      addStop(second, 'assigned', null);
    }
  });
  drivers.slice(0, 2).forEach((driver) => {
    const run = newRun(dayAfter, driver, 'assigned', 1, 'sydney');
    addStop(run, 'assigned', null);
    addStop(run, 'assigned', null);
  });
  // Further out, the allocator has started a sheet but not staffed it.
  const planning = newRun(
    toWeekday(day(5)) === day(5) ? day(5) : day(6),
    null,
    'planning',
    null,
    'sydney',
  );
  addStop(planning, 'booked', null);
  addStop(planning, 'booked', null);
  addStop(planning, 'booked', null);

  /* ── The unallocated column, which is the allocator's actual inbox ─────── */
  for (let i = 0; i < 16; i += 1) {
    const account = pick(weighted);

    /*
     * Four of these are already past their target date. "At risk" is a counter
     * on the dashboard and a red row on the grid, and neither can be trusted
     * until you have watched it count something.
     */
    const late = i < 4;
    const readyDate = late ? toWeekday(day(-int(6, 12))) : toWeekday(day(int(0, 9)));
    factory.next({
      account,
      readyDate,
      status: 'booked',
      driver: null,
      runId: null,
      runSequence: null,
      completedAt: null,
      targetDate: late ? day(-int(1, 5)) : undefined,
      bookedBy: bookedByFor(account),
    });
  }
  return runs;
}

/* ══ Section 6 — persisting runs, and the paper trail each job leaves ═══════ */
async function persistRuns(runs: readonly RunDraft[]): Promise<void> {
  /*
   * The most recent finished day is left at `tipped-off` rather than `closed`.
   * The two are separate states because the weighbridge docket arrives before
   * anybody has checked the reconciliation against it, and yesterday is exactly
   * where that gap lives.
   */
  const closedDates = runs
    .filter((run) => run.status === 'closed')
    .map((run) => run.date)
    .sort();
  const lastClosedDate = closedDates.at(-1) ?? null;
  const runDocs = runs.map((run) => ({
    _id: run.id,
    runNumber: run.runNumber,
    name: run.name,
    date: run.date,
    status: run.status === 'closed' && run.date === lastClosedDate ? 'tipped-off' : run.status,
    driverId: run.driver?.id ?? null,
    driverName: run.driver?.name ?? null,
    vehicleLabel: run.vehicleLabel,
    sequenceForDay: run.sequenceForDay,
    // I11 — a null here means the sequence is the allocator's own work, so only
    // some runs carry the timestamp. Re-optimising is only destructive if
    // there is something to lose.
    optimisedAt: run.driver && chance(0.4) ? at(run.date, 6, int(0, 30)) : null,
  }));

  /*
   * One docket per finished run, weighing what its stops recovered. The
   * reconciliation divides a docket's net weight across the run's stops by m²,
   * so a docket that disagrees with its own stops makes every derived tonnage
   * on the reports screen wrong.
   */
  const tipOffDocs = runs
    .filter((run) => run.status === 'closed' && run.stops.length > 0)
    .map((run) => {
      const netKg = run.stops.reduce((sum, stop) => sum + (stop.recoveredWeightKg ?? 0), 0);
      return {
        runId: run.id,
        facility: pick([
          'Kimbriki Resource Recovery',
          'Veolia Clyde Transfer',
          'Bingo Auburn',
          'Cleanaway Erskine Park',
        ]),
        docketNumber: `D${String(int(100_000, 999_999))}`,
        netKg,
        tippedOffAt: at(run.date, 15, int(0, 59)),
        docketPhotoKey: null,
      };
    })
    // A run where every stop was futile recovered nothing, and a zero-weight
    // docket is a docket that was never issued.
    .filter((docket) => docket.netKg > 0);
  await RunModel.insertMany(runDocs);
  await RunTipOffModel.insertMany(tipOffDocs);
  log.info({ runs: runDocs.length, dockets: tipOffDocs.length }, 'runs seeded');
}

/** When the job was raised — a few days before it was ever going to happen. */
function bookedAtFor(job: JobDraft): Date {
  return at(toWeekday(shiftDays(job.readyDate, -int(2, 6))), int(8, 16), int(0, 59));
}

function shiftDays(isoDate: string, offset: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

/**
 * Everything that hangs off a job: its timeline, its charges, its photos, its
 * conversation and its compliance records.
 *
 * These are the difference between a grid that has rows and a product that can
 * be demonstrated. A job detail page with an empty timeline and no photos
 * cannot show what the driver app captured, which is most of what the system
 * is for.
 */
async function seedJobDetail(
  jobs: readonly JobDraft[],
  runs: readonly RunDraft[],
  truckByDriver: Map<string, AssignedTruck>,
): Promise<void> {
  const jobDocs: Record<string, unknown>[] = [];
  const eventDocs: Record<string, unknown>[] = [];
  const photoDocs: Record<string, unknown>[] = [];
  const commentDocs: Record<string, unknown>[] = [];
  const documentDocs: Record<string, unknown>[] = [];
  for (const job of jobs) {
    const bookedAt = bookedAtFor(job);
    let lastAt = bookedAt;
    const event = (
      offsetMinutes: number,
      label: string,
      actor: string,
      status: string | null,
      detail: string | null = null,
    ): void => {
      const when = new Date(lastAt.getTime() + offsetMinutes * 60_000);
      lastAt = when;
      eventDocs.push({
        jobId: job.id,
        at: when,
        label,
        actor,
        status,
        detail,
        // A status change captured on the driver app carries a position; one
        // typed in the office does not, and pretending otherwise would put a
        // pin on a map for something that happened at a desk.
        latitude:
          status && ['in-transit', 'arrived', 'completed', 'futile'].includes(status)
            ? job.place.latitude
            : null,
        longitude:
          status && ['in-transit', 'arrived', 'completed', 'futile'].includes(status)
            ? job.place.longitude
            : null,
      });
    };
    event(
      0,
      'Job booked',
      String(job.doc.bookedByName),
      'booked',
      `Raised from the ${String(job.doc.bookedBySource)}`,
    );
    if (job.driver && job.status !== 'booked') {
      event(int(60, 900), `Allocated to ${job.driver.name}`, 'Dean Kelly', 'assigned', null);
    }
    if (['in-transit', 'arrived', 'completed', 'admin-complete', 'futile'].includes(job.status)) {
      event(int(30, 240), 'Driver on the way', job.driver?.name ?? 'Driver', 'in-transit');
    }
    if (['arrived', 'completed', 'admin-complete', 'futile'].includes(job.status)) {
      event(int(10, 45), 'Arrived on site', job.driver?.name ?? 'Driver', 'arrived');
    }
    if (job.status === 'completed' || job.status === 'admin-complete') {
      event(
        Number(job.doc.onSiteMinutes ?? 30),
        'Collection complete',
        job.driver?.name ?? 'Driver',
        'completed',
        job.recoveredWeightKg === null ? null : `${String(job.recoveredWeightKg)} kg recovered`,
      );
    }
    if (job.status === 'futile') {
      event(
        int(5, 20),
        'Marked futile',
        job.driver?.name ?? 'Driver',
        'futile',
        job.exceptionNote ?? '',
      );
    }
    if (job.status === 'cancelled') {
      event(int(60, 2_000), 'Cancelled', 'Renee Alvarez', 'cancelled', job.exceptionNote ?? '');
    }
    job.doc.createdAt = bookedAt;
    job.doc.updatedAt = lastAt;
    jobDocs.push(job.doc);
  }

  /* ── Photos: their five-shot protocol, plus the odd extra ──────────────── */
  const PHOTO_SLOTS = [
    { slot: 'front-of-site', caption: 'Front of site' },
    { slot: 'pile-before', caption: 'Pile before collection' },
    { slot: 'pile-after', caption: 'Pile after collection' },
    { slot: 'site-closed', caption: 'Site left secure' },
    { slot: 'cars-on-site', caption: 'Vehicles on site' },
  ] as const;
  for (const job of jobs) {
    if (job.status !== 'completed' && job.status !== 'admin-complete' && job.status !== 'futile') {
      continue;
    }
    const takenBase = job.completedAt ?? at(job.readyDate, 10);

    /*
     * A futile job has the "before" shots and no "after" — the driver was
     * there, and the photos are the evidence of what he found. Requiring all
     * five would mean inventing an after-shot of a pile that was never
     * collected.
     */
    const slots = job.status === 'futile' ? PHOTO_SLOTS.slice(0, 2) : PHOTO_SLOTS;
    slots.forEach((shot, index) => {
      photoDocs.push({
        jobId: job.id,
        caption: shot.caption,
        slot: shot.slot,
        takenAt: new Date(takenBase.getTime() - (slots.length - index) * 4 * 60_000),
        takenBy: job.driver?.name ?? 'Driver',
        latitude: job.place.latitude,
        longitude: job.place.longitude,
        // Null: this seeder writes rows, not images. The API serves a URL for
        // a key it has; a made-up key would 404 on click, which looks worse
        // than an honest placeholder.
        storageKey: null,
      });
    });
    if (chance(0.2)) {
      photoDocs.push({
        jobId: job.id,
        caption: 'Damaged fence noted on arrival',
        slot: null,
        takenAt: takenBase,
        takenBy: job.driver?.name ?? 'Driver',
        latitude: job.place.latitude,
        longitude: job.place.longitude,
        storageKey: null,
      });
    }
  }

  /* ── The conversation, in all three visibilities ───────────────────────── */
  const officeNames = ['Renee Alvarez', 'Priya Raman', 'Dean Kelly'];
  for (const job of jobs) {
    if (!chance(0.28)) continue;
    const base = job.completedAt ?? bookedAtFor(job);
    const visibility = pick(['internal', 'driver', 'customer'] as const);
    commentDocs.push({
      jobId: job.id,
      body: {
        internal: pick([
          'Supervisor rang — wants this before the plasterers come back Thursday.',
          'Second load likely. Flagging for the allocator.',
          'Account is on stop-credit until the March invoice clears.',
        ]),
        driver: pick([
          'Gate code is 4471 — the sign on the fence is out of date.',
          'Park on the road, the driveway will not take the truck.',
          'Take the extra straps, the pile is loose.',
        ]),
        customer: pick([
          'Booked in for Thursday morning. We will text when the driver is on the way.',
          'Your certificate for this job is ready in the portal.',
          'The driver could not get in — we have rebooked at no charge.',
        ]),
      }[visibility],
      authorId: null,
      author: visibility === 'driver' ? pick(officeNames) : pick(officeNames),
      at: base,
      visibility,
      // "Did they get it" is the first question anyone asks about a message to
      // somebody on the road, and the only thread that is pushed to an app.
      deliveredAt: visibility === 'driver' ? new Date(base.getTime() + int(1, 20) * 60_000) : null,
      fromDriver: false,
    });
    if (visibility === 'driver' && chance(0.5)) {
      commentDocs.push({
        jobId: job.id,
        body: pick([
          'Got it.',
          'On my way now.',
          'Pile is bigger than described — might be two loads.',
        ]),
        authorId: job.driver?.id ?? null,
        author: job.driver?.name ?? 'Driver',
        at: new Date(base.getTime() + int(21, 90) * 60_000),
        visibility: 'driver',
        deliveredAt: new Date(base.getTime() + int(21, 90) * 60_000),
        fromDriver: true,
      });
    }
  }

  /* ── Pre-starts: one per run, filed against the run's first stop ───────── */
  const preStartDocs: Record<string, unknown>[] = [];
  const PRE_START_TOTAL = 10;
  for (const run of runs) {
    const firstStop = run.stops[0];
    if (!run.driver || !firstStop) continue;
    // Only the recent fortnight, which is as far back as anybody looks for a
    // Chain of Responsibility record.
    if (run.date < day(-14) || run.date > TODAY) continue;
    if (run.status === 'planning') continue;

    /*
     * One pre-start in eight has a failed item on it. A wall of green ticks is
     * noise; the office is looking for the one line that says the brakes felt
     * soft, and a fortnight of perfect checklists cannot show that it would
     * surface one.
     */
    const failed = chance(0.12);
    preStartDocs.push({
      jobId: firstStop.id,
      completedAt: at(run.date, 5, int(30, 59)),
      driverId: run.driver.id,
      driverName: run.driver.name,
      vehicleRego: truckByDriver.get(run.driver.name)?.rego ?? '',
      odometerKm: int(140_000, 390_000),
      failedItems: failed
        ? [
            pick([
              { key: 'brakes', label: 'Brakes', note: 'Pedal travel longer than usual.' },
              {
                key: 'lights',
                label: 'Lights and indicators',
                note: 'Nearside rear indicator out.',
              },
              {
                key: 'tyres',
                label: 'Tyres and wheel nuts',
                note: 'Drive tyre down to the markers.',
              },
            ]),
          ]
        : [],
      itemsChecked: PRE_START_TOTAL,
    });
  }

  /* ── Site Risk Assessments, and where their upload got to ──────────────── */
  const riskDocs: Record<string, unknown>[] = [];
  for (const job of jobs) {
    if (job.doc.riskAssessmentRequired !== true) continue;
    if (!['completed', 'admin-complete', 'futile'].includes(job.status)) continue;

    /*
     * Step 5 hands the assessment to the builder's own portal, and that step
     * fails — the builder's site is down, the code on the fence is wrong. All
     * four states are represented because the retry sweep is only worth having
     * if `failed` is reachable.
     */
    const uploadState = pick([
      'uploaded',
      'uploaded',
      'uploaded',
      'queued',
      'failed',
      'pending',
    ] as const);
    const unsafe = chance(0.05);
    riskDocs.push({
      jobId: job.id,
      completedAt: job.completedAt ?? at(job.readyDate, 9),
      driverId: job.driver?.id ?? null,
      driverName: job.driver?.name ?? 'Driver',
      hazards: unsafe
        ? ['Overhead powerlines', 'Other trades working nearby']
        : pick([
            ['No significant hazards identified'],
            ['Uneven or soft ground', 'Manual handling required'],
            ['Restricted or narrow access', 'Traffic on the approach'],
            ['Other trades working nearby'],
          ]),
      controls: unsafe
        ? ['Work stopped — unsafe to proceed']
        : pick([
            ['PPE worn'],
            ['Exclusion zone set up', 'PPE worn'],
            ['Spotter used', 'Truck repositioned'],
          ]),
      note: unsafe ? 'Crane could not clear the powerlines. Left site and rang the office.' : '',
      safeToProceed: !unsafe,
      swmsVersion: 'SWMS-2026.1',
      builderPortalCode: chance(0.5) ? `BP-${String(int(10_000, 99_999))}` : null,
      uploadState,
      documentId: null,
    });
  }

  /* ── Documents ─────────────────────────────────────────────────────────── */
  for (const run of runs) {
    const firstStop = run.stops[0];
    if (!firstStop || run.status !== 'closed') continue;
    if (run.date < day(-21)) continue;
    documentDocs.push({
      jobId: firstStop.id,
      name: `Weighbridge docket ${run.date}.pdf`,
      kind: 'weighbridge-docket',
      uploadedAt: at(run.date, 15, int(0, 59)),
      uploadedBy: run.driver?.name ?? 'Driver',
      sizeKb: int(120, 900),
      storageKey: null,
    });
  }
  for (const job of jobs) {
    if (job.doc.riskAssessmentRequired === true && chance(0.4)) {
      documentDocs.push({
        jobId: job.id,
        name: `Site risk assessment — job ${String(job.jobNumber)}.pdf`,
        kind: 'risk-assessment',
        uploadedAt: job.completedAt ?? at(job.readyDate, 12),
        uploadedBy: job.driver?.name ?? 'Driver',
        sizeKb: int(80, 420),
        storageKey: null,
      });
    }
  }
  await JobModel.insertMany(jobDocs, { timestamps: false });
  await JobEventModel.insertMany(eventDocs);
  await JobPhotoModel.insertMany(photoDocs);
  await JobCommentModel.insertMany(commentDocs);
  await JobPreStartModel.insertMany(preStartDocs);
  await JobRiskAssessmentModel.insertMany(riskDocs);
  await JobDocumentModel.insertMany(documentDocs);
  log.info(
    {
      jobs: jobDocs.length,
      events: eventDocs.length,
      photos: photoDocs.length,
      comments: commentDocs.length,
      preStarts: preStartDocs.length,
      riskAssessments: riskDocs.length,
      documents: documentDocs.length,
    },
    'jobs seeded',
  );
}

/* ══ Section 7 — charges ════════════════════════════════════════════════════ */

/** What each job contributes to an invoice, and whether a human has to look. */
export interface ChargeSummary {
  /** Approved extras, in cents — these become a second, separate invoice. */
  approvedExtraCents: number;
  /** Still in the approvals queue, so not invoiceable yet. */
  pendingExtraCents: number;
}

/**
 * Charges, generated before invoices because an invoice is made OF them.
 *
 * ── Why the order matters ──────────────────────────────────────────────────
 * M2.7: a driver reports contamination from the fence and the office approves
 * it before it can reach an invoice. So the question "what does this job
 * invoice for" cannot be answered until the approval state of its extras is
 * known — and generating the invoice first would mean inventing a total the
 * job's own charge list then contradicts. Two numbers for one job is the exact
 * failure that makes a demo unrecoverable, because the client is looking at
 * both of them on the same screen.
 */
async function seedCharges(jobs: readonly JobDraft[]): Promise<Map<string, ChargeSummary>> {
  const chargeDocs: Record<string, unknown>[] = [];
  const summaries = new Map<string, ChargeSummary>();

  for (const job of jobs) {
    const summary: ChargeSummary = { approvedExtraCents: 0, pendingExtraCents: 0 };
    summaries.set(job.id.toHexString(), summary);

    const bookedAt = bookedAtFor(job);
    const raisedAt = job.completedAt ?? bookedAt;

    /*
     * The base charge splits into a call-out and an area component, because
     * that is how the rate card is built and how the customer checks it. A
     * fixed-price account has no area line at all — there is nothing to
     * multiply.
     */
    const serviceFeeCents = Math.round(
      job.totalExGstCents * (job.expectedAreaM2 === null ? 1 : 0.35),
    );
    chargeDocs.push({
      jobId: job.id,
      code: 'service-fee',
      description: 'Collection service fee',
      quantity: 1,
      unitRate: decimal(serviceFeeCents),
      amount: decimal(serviceFeeCents),
      source: 'system',
      approvalState: 'not-required',
      raisedBy: null,
      raisedAt: bookedAt,
      photoCount: 0,
      note: null,
    });

    if (job.expectedAreaM2 !== null && job.expectedAreaM2 > 0) {
      const areaCents = job.totalExGstCents - serviceFeeCents;
      chargeDocs.push({
        jobId: job.id,
        code: 'area-charge',
        // Matt wanted the quantity visible — "2 bags at $30 each, equalling
        // $60" — which TransVirtual cannot render at all.
        description: `Plasterboard recovery — ${String(job.expectedAreaM2)} m²`,
        quantity: job.expectedAreaM2,
        unitRate: decimal(Math.round(areaCents / job.expectedAreaM2)),
        amount: decimal(areaCents),
        source: 'system',
        approvalState: 'not-required',
        raisedBy: null,
        raisedAt: bookedAt,
        photoCount: 0,
        note: null,
      });
    }

    const bags = Number(job.doc.bagCount ?? 0);
    if (bags > 0) {
      const perBag = 3_000;
      chargeDocs.push({
        jobId: job.id,
        code: 'recycling-bags',
        description: `Recycling bags supplied — ${String(bags)}`,
        quantity: bags,
        unitRate: decimal(perBag),
        amount: decimal(bags * perBag),
        source: 'office',
        approvalState: 'not-required',
        raisedBy: 'Priya Raman',
        raisedAt: bookedAt,
        photoCount: 0,
        note: null,
      });
      summary.approvedExtraCents += bags * perBag;
    }

    if (job.status === 'futile') {
      const futileCents = 16_500;
      chargeDocs.push({
        jobId: job.id,
        code: 'futile-pickup',
        description: 'Futile pickup — truck attended, nothing to collect',
        quantity: 1,
        unitRate: decimal(futileCents),
        amount: decimal(futileCents),
        source: 'system',
        approvalState: 'not-required',
        raisedBy: null,
        raisedAt,
        photoCount: 2,
        note: job.exceptionNote,
      });
    }

    /*
     * Contamination is the charge that needs a human. Recent ones are still
     * pending, which is what puts rows in the approvals queue; older ones have
     * been decided, and some were rejected — a queue where everything is
     * eventually approved is not a queue anybody needs to work.
     */
    if ((job.status === 'completed' || job.status === 'admin-complete') && chance(0.13)) {
      const cents = int(8_000, 24_000);
      const recent = job.completedAt !== null && job.completedAt >= at(day(-9), 0);
      const rejected = !recent && chance(0.2);
      const approvalState = recent ? 'pending' : rejected ? 'rejected' : 'approved';
      chargeDocs.push({
        jobId: job.id,
        code: 'contamination',
        description: `Contamination — ${pick(['timber offcuts', 'insulation batts', 'general waste', 'wet board'])}`,
        quantity: 1,
        unitRate: decimal(cents),
        amount: decimal(cents),
        source: 'driver',
        approvalState,
        raisedBy: job.driver?.name ?? 'Driver',
        raisedAt,
        photoCount: int(1, 3),
        note: pick([
          'Timber through the middle of the pile.',
          'Batts bagged in with the board.',
          'Board is soaked — sat out in the rain.',
        ]),
      });
      if (approvalState === 'approved') summary.approvedExtraCents += cents;
      if (approvalState === 'pending') summary.pendingExtraCents += cents;
    }
  }

  await JobChargeModel.insertMany(chargeDocs);
  log.info({ charges: chargeDocs.length }, 'charges seeded');
  return summaries;
}

/* ══ Section 8 — purchase orders, and the extraction queue behind them ══════ */

/**
 * Orders, and the emailed PDFs they were read out of.
 *
 * ── Why some jobs deliberately have no order ───────────────────────────────
 * Matt, 9:56: *"if we don't list PO on the invoice, then sometimes I have
 * trouble getting paid."* For the accounts whose policy is
 * `required-before-invoice`, a completed job with no order is not a gap in the
 * data — it is the awaiting-PO backlog, which is a queue, a dashboard figure
 * and a real amount of money sitting uninvoiced. It has to exist for any of
 * those three to be worth looking at.
 *
 * Mutates the job drafts rather than updating rows afterwards: the jobs have
 * not been inserted yet, and an update pass would be a second place where a
 * job's PO number gets decided.
 */
async function seedPurchaseOrders(
  jobs: readonly JobDraft[],
  accounts: readonly SeededAccount[],
): Promise<void> {
  const poDocs: Record<string, unknown>[] = [];

  for (const job of jobs) {
    if (job.account.poPolicy !== 'required-before-invoice') {
      // Their own reference, which is the same field — Matt, 9:08: *"they're
      // really interchangeable… we don't need both of them."*
      if (chance(0.45)) {
        job.doc.poNumber = `${job.account.code.slice(0, 3)}-${String(int(10_000, 99_999))}`;
      }
      continue;
    }

    /*
     * Roughly a quarter are still waiting, skewed towards recent jobs: an
     * order that has not turned up in three months is a different conversation
     * from one that has not turned up since Tuesday.
     */
    const recent = job.completedAt !== null && job.completedAt >= at(day(-21), 0);
    if (recent && chance(0.45)) continue;
    if (!recent && chance(0.08)) continue;

    const poId = oid();
    const poNumber = `PO-${String(int(80_000, 99_999))}`;
    job.doc.poNumber = poNumber;
    job.doc.purchaseOrderId = poId;

    poDocs.push({
      _id: poId,
      poNumber,
      accountId: job.account.id,
      accountName: job.account.name,
      receivedAt: at(toWeekday(shiftDays(job.readyDate, -int(3, 21))), int(8, 16), int(0, 59)),
      lotNumber: job.doc.lotNumber,
      addressLine: job.doc.addressLine,
      suburb: job.doc.suburb,
      postcode: job.doc.postcode,
      // Wisdom's order carries a line item and no square metres at all.
      expectedAreaM2: job.account.rateCardId === 'wisdom' ? null : job.expectedAreaM2,
      bagAllowance: chance(0.4) ? int(2, 10) : null,
      siteSupervisorName: job.doc.siteContactName,
      siteSupervisorMobile: job.doc.siteContactMobile,
      amountExGst: decimal(job.totalExGstCents),
      storageKey: null,
      extractionId: null,
      createdByName: chance(0.7) ? 'PO extractor' : 'Priya Raman',
    });
  }

  /*
   * M2.12b — orders with NO job against them.
   *
   * Every order above was built from a job and attached to it, which is right
   * for history but leaves the "waiting for a date" screens permanently empty:
   * an order is only waiting if nothing points at it. Matt's whole two-message
   * flow (21:30) lives in exactly that state, so the demo has to contain some.
   */
  const waitingDocs = buildWaitingOrders(jobs, accounts);

  await PurchaseOrderModel.insertMany([...poDocs, ...waitingDocs]);
  await PoExtractionModel.insertMany(buildExtractions(accounts));
  await CallUpModel.insertMany(buildCallUps(waitingDocs));

  log.info({ purchaseOrders: poDocs.length, awaitingCallUp: waitingDocs.length }, 'orders seeded');
}

/**
 * Confirmed orders nobody has given us a date for yet (M2.12b).
 *
 * ── Why the spread of ages matters ────────────────────────────────────────
 * The screen sorts oldest first and badges the age, because those two facts are
 * the whole judgement: an order that arrived on Tuesday is normal, and one from
 * three months ago is a conversation with the builder. A demo where they all
 * arrived last week exercises neither.
 *
 * ── Why one is deliberately unserviceable ─────────────────────────────────
 * A call-up cannot price a job whose suburb is not in the places table, so the
 * screen refuses to offer the button and says why instead. That branch is
 * invisible unless the data contains a row that trips it.
 *
 * ⚠️ Suburbs are borrowed from the seeded JOBS rather than invented, so every
 * serviceable row resolves to a real place and a real zone. A made-up suburb
 * would make all five look unserviceable and hide the normal case.
 */
function buildWaitingOrders(
  jobs: readonly JobDraft[],
  accounts: readonly SeededAccount[],
): Record<string, unknown>[] {
  const builders = accounts.filter(
    (account) => account.status === 'active' && account.poPolicy === 'required-before-invoice',
  );
  if (builders.length === 0) return [];

  const serviced = jobs
    .map((job) => ({
      suburb: job.doc.suburb as string,
      postcode: job.doc.postcode as string,
    }))
    .filter((entry) => typeof entry.suburb === 'string' && entry.suburb !== '');
  if (serviced.length === 0) return [];

  const CASES = [
    { agedDays: 4, offZone: false, supervisor: true },
    { agedDays: 11, offZone: false, supervisor: true },
    { agedDays: 26, offZone: false, supervisor: false },
    // Matt, 34:52: *"sometimes they're blank… there's nothing I can do."*
    { agedDays: 63, offZone: false, supervisor: false },
    // Outside the three zones, so no call-up can price it.
    { agedDays: 97, offZone: true, supervisor: true },
  ] as const;

  // Annotated so the `null` skip narrows cleanly in the filter below.
  return CASES.map((entry, index): Record<string, unknown> | null => {
    const account = builders[index % builders.length];
    const where = serviced[index % serviced.length];
    if (!account || !where) return null;

    const lotNumber = String(int(101, 486));

    return {
      _id: oid(),
      poNumber: `PO-${String(int(60_000, 79_999))}`,
      accountId: account.id,
      accountName: account.name,
      receivedAt: at(toWeekday(day(-entry.agedDays)), int(8, 16), int(0, 59)),
      lotNumber,
      addressLine: `${String(int(2, 148))} ${pick(STREETS)}`,
      suburb: entry.offZone ? 'Bendigo' : where.suburb,
      postcode: entry.offZone ? '3550' : where.postcode,
      // Wisdom state a line item and no square metres at all (Matt, 31:04).
      expectedAreaM2: account.rateCardId === 'wisdom' ? null : area(300, 900),
      bagAllowance: chance(0.6) ? int(1, 4) : null,
      siteSupervisorName: entry.supervisor
        ? pick(['Dave Miller', 'Nick Farrugia', 'Karen Whitby', 'Sam Farrar'])
        : null,
      siteSupervisorMobile: entry.supervisor
        ? `04${String(int(10, 99))}${String(int(100_000, 999_999))}`
        : null,
      siteSupervisorUserId: null,
      amountExGst: decimal(int(30_000, 90_000)),
      storageKey: null,
      extractionId: null,
      createdByName: 'PO extractor',
    };
  }).filter((doc): doc is Record<string, unknown> => doc !== null);
}

/**
 * Call-ups the system could not act on (M2.12b).
 *
 * ── Why the queue is seeded at all ────────────────────────────────────────
 * Because it is the screen that proves the pipeline refuses to guess, and an
 * empty one demonstrates nothing. Each row is a different reason, since each
 * needs a different fix — and the fix is the work.
 */
function buildCallUps(waiting: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const docs: Record<string, unknown>[] = [
    /*
     * A date for an order nobody has on file — the commonest failure and the one
     * that matters most: a builder has told us a date for work we cannot find,
     * and without this queue nobody would ever know.
     */
    {
      _id: oid(),
      purchaseOrderId: null,
      poNumber: 'PO-41277',
      accountId: null,
      accountName: null,
      receivedAt: at(toWeekday(day(-3)), 9, 14),
      source: 'email',
      kind: 'new',
      readyDate: toWeekday(day(3)),
      previousReadyDate: null,
      state: 'needs-review',
      reason: 'no-matching-po',
      jobId: null,
      jobNumber: null,
      note: 'Email: Call up - Lot 88 Box Hill · Site: 88 Fairwater Blvd, Box Hill',
      externalId: 'demo-call-up-1',
      raisedBy: null,
    },
    /*
     * A reschedule for work we were never told about. Matt, 24:07 — the
     * builder's blue notice sometimes goes missing, so the green one is the
     * first thing we see.
     */
    {
      _id: oid(),
      purchaseOrderId: null,
      poNumber: 'PO-52901',
      accountId: null,
      accountName: null,
      receivedAt: at(toWeekday(day(-6)), 14, 2),
      source: 'email',
      kind: 'reschedule',
      readyDate: toWeekday(day(5)),
      previousReadyDate: null,
      state: 'needs-review',
      reason: 'no-job-to-change',
      jobId: null,
      jobNumber: null,
      note: 'Email: RESCHEDULED - Lot 214 · Notice: green',
      externalId: 'demo-call-up-2',
      raisedBy: null,
    },
    /* One already set aside, so the history filter is not empty either. */
    {
      _id: oid(),
      purchaseOrderId: null,
      poNumber: 'PO-68410',
      accountId: null,
      accountName: null,
      receivedAt: at(toWeekday(day(-9)), 8, 5),
      source: 'email',
      kind: 'cancel',
      readyDate: null,
      previousReadyDate: null,
      state: 'rejected',
      reason: 'no-job-to-change',
      jobId: null,
      jobNumber: null,
      note: 'Email: CANCELLED - Lot 12 · Builder cancelled a job we never had',
      externalId: 'demo-call-up-4',
      raisedBy: null,
    },
  ];

  /*
   * The unserviceable one, matched to the order it names. Retrying this is the
   * demo of the whole loop: add Bendigo to the places table, press Try again,
   * and it books.
   */
  const offZone = waiting[waiting.length - 1];
  if (offZone) {
    docs.push({
      _id: oid(),
      purchaseOrderId: offZone._id,
      poNumber: offZone.poNumber,
      accountId: offZone.accountId,
      accountName: offZone.accountName,
      receivedAt: at(toWeekday(day(-2)), 11, 30),
      source: 'email',
      kind: 'new',
      readyDate: toWeekday(day(4)),
      previousReadyDate: null,
      state: 'needs-review',
      reason: 'unknown-suburb',
      jobId: null,
      jobNumber: null,
      note: 'Email: Ready for pickup · Site: Bendigo VIC',
      externalId: 'demo-call-up-3',
      raisedBy: null,
    });
  }

  return docs;
}

/**
 * The PO review queue.
 *
 * Every reason the extractor can hand something back is represented, because
 * each one renders a different screen: an ambiguous account offers candidates
 * to choose between, a duplicate offers the order it collides with, a
 * low-confidence read offers the fields to correct. A queue holding six copies
 * of the same reason exercises one of those.
 */
function buildExtractions(accounts: readonly SeededAccount[]): Record<string, unknown>[] {
  const docs: Record<string, unknown>[] = [];
  const reviewable = accounts.filter((account) => account.status === 'active');
  if (reviewable.length === 0) return docs;

  const REVIEW_CASES = [
    { reason: 'below-threshold', confidence: 0.58, subject: 'Purchase Order 91882' },
    { reason: 'no-account-match', confidence: 0.81, subject: 'PO for plasterboard pickup' },
    { reason: 'ambiguous-account', confidence: 0.74, subject: 'Order - Lot 218 Kellyville' },
    { reason: 'no-job-match', confidence: 0.88, subject: 'PO-90114 Marsden Park' },
    { reason: 'duplicate-po', confidence: 0.93, subject: 'RE: PO-88213' },
    { reason: 'below-threshold', confidence: 0.41, subject: 'Scanned document' },
  ] as const;

  REVIEW_CASES.forEach((review, index) => {
    const account = reviewable[index % reviewable.length];
    if (!account) return;
    const slug = account.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const areaValue = area(200, 900);
    const poNumber = `PO-${String(int(80_000, 99_999))}`;
    const siteAddress = `${String(int(2, 140))} ${pick(STREETS)}`;
    const unmatched = review.reason === 'no-account-match';

    docs.push({
      externalId: `demo-extract-${String(index + 1)}`,
      fromAddress: `orders@${slug}.com.au`,
      subject: review.subject,
      receivedAt: at(toWeekday(day(-int(0, 6))), int(7, 17), int(0, 59)),
      attachmentName: `${poNumber}.pdf`,
      pageCount: int(1, 3),
      storageKey: null,
      documentText: 'PURCHASE ORDER\nONE PURCHASE ORDER NUMBER ONLY PER TAX INVOICE.',
      poNumber,
      amountExGst: decimal(int(30_000, 120_000)),
      extractedAreaM2: areaValue,
      extractedBagAllowance: chance(0.5) ? int(2, 8) : null,
      extractedSiteAddress: siteAddress,
      extractedLotNumber: String(int(101, 480)),
      extractedSupervisorName: pick(['Dave Miller', 'Karen Whitby', 'Nick Farrugia']),
      extractedSupervisorMobile: `04${String(int(10, 99))}${String(int(100_000, 999_999))}`,
      /*
       * Per-field confidence, not just an overall score. The reviewer needs to
       * know WHICH value to distrust — an order read perfectly except for a
       * smudged area figure is one correction, not a re-key.
       */
      fields: [
        { key: 'poNumber', label: 'PO number', value: poNumber, confidence: review.confidence },
        {
          key: 'areaM2',
          label: 'Area (m2)',
          value: String(areaValue),
          confidence: Math.max(0.3, review.confidence - 0.12),
        },
        {
          key: 'siteAddress',
          label: 'Site address',
          value: siteAddress,
          confidence: review.confidence,
        },
      ],
      suggestedAccountId: unmatched ? null : account.id,
      suggestedAccountName: unmatched ? null : account.name,
      suggestedJobId: null,
      suggestedJobNumber: null,
      accountCandidates:
        review.reason === 'ambiguous-account'
          ? reviewable.slice(0, 3).map((candidate) => ({
              id: candidate.id.toHexString(),
              label: candidate.name,
              detail: candidate.code,
              confidence: Math.round((0.4 + random() * 0.3) * 100) / 100,
            }))
          : [],
      jobCandidates: [],
      overallConfidence: review.confidence,
      reason: review.reason,
      state: 'needs-review',
      reviewedAt: null,
      reviewedByUserId: null,
      reviewedBy: null,
      rejectionNote: null,
      purchaseOrderId: null,
      correctedFields: [],
    });
  });

  /* Two already worked, so the queue has a history as well as a backlog. */
  (['confirmed', 'rejected'] as const).forEach((state, index) => {
    const account = reviewable[index] ?? reviewable[0];
    if (!account) return;
    const confirmed = state === 'confirmed';
    docs.push({
      externalId: `demo-extract-done-${String(index + 1)}`,
      fromAddress: `orders@${account.code.toLowerCase()}.com.au`,
      subject: confirmed ? 'Purchase Order 88961' : 'Fwd: invoice query',
      receivedAt: at(day(-int(7, 20)), 9, int(0, 59)),
      attachmentName: confirmed ? 'purchase-order.pdf' : 'scan0041.pdf',
      pageCount: 1,
      storageKey: null,
      documentText: 'PURCHASE ORDER',
      poNumber: confirmed ? `PO-${String(int(80_000, 99_999))}` : null,
      amountExGst: confirmed ? decimal(int(30_000, 90_000)) : null,
      extractedAreaM2: confirmed ? area(200, 800) : null,
      extractedBagAllowance: null,
      extractedSiteAddress: null,
      extractedLotNumber: null,
      extractedSupervisorName: null,
      extractedSupervisorMobile: null,
      fields: [],
      suggestedAccountId: account.id,
      suggestedAccountName: account.name,
      suggestedJobId: null,
      suggestedJobNumber: null,
      accountCandidates: [],
      jobCandidates: [],
      overallConfidence: confirmed ? 0.96 : 0.22,
      reason: confirmed ? 'below-threshold' : 'no-account-match',
      state,
      reviewedAt: at(day(-int(1, 6)), 11, int(0, 59)),
      reviewedByUserId: null,
      reviewedBy: 'Priya Raman',
      rejectionNote: confirmed ? null : 'Not an order — the customer is replying about an invoice.',
      purchaseOrderId: null,
      // The one field the reviewer had to fix. This is the signal that tells
      // you whether the extractor is getting better or worse.
      correctedFields: confirmed ? ['areaM2'] : [],
    });
  });

  return docs;
}

/* ══ Section 9 — invoices ═══════════════════════════════════════════════════ */

/**
 * One invoice per completed job, plus a second for its approved extras.
 *
 * ── Why extras are a separate invoice ──────────────────────────────────────
 * `splitAdditionalCharges` is on by default in settings, and it is on because a
 * contamination charge is the line a builder disputes. Keeping it off the base
 * invoice means the uncontroversial 90% gets paid on time while the argument
 * happens over its own document.
 *
 * ── Why the statuses are derived from age ──────────────────────────────────
 * Draft, sent, overdue and paid are not decorations — they are what an invoice
 * looks like at four points in its life, and an ageing report is meaningless
 * unless the spread across them is a function of time. So a job completed three
 * months ago is paid, one from last month is sent (and overdue if its terms
 * have run out), and last week's is still a draft nobody has looked at.
 */
async function seedInvoices(
  jobs: readonly JobDraft[],
  summaries: Map<string, ChargeSummary>,
  startNumber: number,
): Promise<number> {
  const invoiceDocs: Record<string, unknown>[] = [];
  const lineDocs: Record<string, unknown>[] = [];
  let invoiceNumber = startNumber;

  for (const job of jobs) {
    if (job.status !== 'completed' && job.status !== 'admin-complete') continue;
    const completedAt = job.completedAt;
    if (!completedAt) continue;

    const summary = summaries.get(job.id.toHexString());
    const requiresPo = job.account.poPolicy === 'required-before-invoice';
    const hasPo = job.doc.purchaseOrderId !== null;

    /* ── Blocked on a missing order ──────────────────────────────────────── */
    if (requiresPo && !hasPo) {
      const id = oid();
      const number = invoiceNumber;
      invoiceNumber += 1;
      job.doc.invoiceStatus = 'awaiting-po';
      invoiceDocs.push({
        _id: id,
        invoiceNumber: number,
        kind: 'base',
        status: 'awaiting-po',
        accountId: job.account.id,
        accountName: job.account.name,
        brandId: job.account.brandId,
        jobId: job.id,
        jobNumber: job.jobNumber,
        poNumber: null,
        // No issue date, because it has not been issued. A date here would put
        // it in this month's invoiced total, which is money we have not billed.
        issuedOn: null,
        dueOn: null,
        sentAt: null,
        paidAt: null,
        paymentTermsDays: job.account.paymentTermsDays,
        subtotalExGst: decimal(job.totalExGstCents),
        gst: decimal(gstOf(job.totalExGstCents)),
        totalIncGst: decimal(job.totalExGstCents + gstOf(job.totalExGstCents)),
        templateName: 'Standard',
        notes: 'Held — waiting on the purchase order.',
        xeroState: 'not-synced',
        xeroLastSyncAt: null,
        xeroMessage: null,
        xeroInvoiceId: null,
        lastChasedAt: chance(0.5) ? at(day(-int(1, 10)), 10) : null,
        chaseCount: int(0, 3),
        createdAt: new Date(completedAt.getTime() + 86_400_000),
        updatedAt: new Date(completedAt.getTime() + 86_400_000),
      });
      pushLines(lineDocs, id, job);
      continue;
    }

    /* ── The ordinary path ───────────────────────────────────────────────── */
    const ageDays = Math.floor((Date.now() - completedAt.getTime()) / 86_400_000);
    const issuedOn = toWeekday(shiftDays(completedAt.toISOString().slice(0, 10), int(1, 3)));
    const dueOn = shiftDays(issuedOn, job.account.paymentTermsDays);
    const overdue = dueOn < TODAY;

    /*
     * Not yet issued, issued and inside terms, or past due — and past due is
     * mostly PAID, because a ledger where every overdue invoice is still
     * outstanding describes a business in trouble rather than a demo. The
     * ones left overdue are the handful the chasing screen exists for.
     *
     * Picked off the job number rather than rolled, so the count is stable.
     * A coin flip here made the overdue column swing between one row and
     * fifty across runs, which is not something you want to discover in the
     * meeting.
     */
    const status =
      ageDays <= 7 ? 'draft' : !overdue ? 'sent' : job.jobNumber % 9 === 0 ? 'overdue' : 'paid';
    const id = oid();
    const number = invoiceNumber;
    invoiceNumber += 1;

    job.doc.invoiceStatus =
      status === 'paid' ? 'paid' : status === 'draft' ? 'not-invoiced' : 'invoiced';
    if (status !== 'draft') {
      job.invoiceNumber = number;
      job.doc.invoiceNumber = number;
      job.doc.invoicedAt = at(issuedOn, 9, int(0, 59));
    }

    invoiceDocs.push({
      _id: id,
      invoiceNumber: number,
      kind: 'base',
      status,
      accountId: job.account.id,
      accountName: job.account.name,
      brandId: job.account.brandId,
      jobId: job.id,
      jobNumber: job.jobNumber,
      poNumber: job.doc.poNumber ?? null,
      issuedOn: status === 'draft' ? null : issuedOn,
      dueOn: status === 'draft' ? null : dueOn,
      sentAt: status === 'draft' ? null : at(issuedOn, 9, int(0, 59)),
      paidAt: status === 'paid' ? at(shiftDays(dueOn, -int(0, 6)), 14, int(0, 59)) : null,
      paymentTermsDays: job.account.paymentTermsDays,
      subtotalExGst: decimal(job.totalExGstCents),
      gst: decimal(gstOf(job.totalExGstCents)),
      totalIncGst: decimal(job.totalExGstCents + gstOf(job.totalExGstCents)),
      templateName: job.account.captureMode === 'area-and-weight' ? 'Weight shown' : 'Standard',
      notes: '',
      ...xeroStateFor(status, issuedOn),
      lastChasedAt: status === 'overdue' ? at(day(-int(1, 8)), 11, int(0, 59)) : null,
      chaseCount: status === 'overdue' ? int(1, 3) : 0,
      createdAt: at(issuedOn, 9),
      updatedAt: at(issuedOn, 9),
    });
    pushLines(lineDocs, id, job);

    /* ── The extras, on their own document ───────────────────────────────── */
    const extras = summary?.approvedExtraCents ?? 0;
    if (extras > 0 && status !== 'draft') {
      const extraId = oid();
      const extraNumber = invoiceNumber;
      invoiceNumber += 1;
      invoiceDocs.push({
        _id: extraId,
        invoiceNumber: extraNumber,
        kind: 'additional-charges',
        status: status === 'paid' ? 'paid' : status,
        accountId: job.account.id,
        accountName: job.account.name,
        brandId: job.account.brandId,
        jobId: job.id,
        jobNumber: job.jobNumber,
        poNumber: job.doc.poNumber ?? null,
        issuedOn,
        dueOn,
        sentAt: at(issuedOn, 9, int(0, 59)),
        paidAt: status === 'paid' ? at(shiftDays(dueOn, -int(0, 6)), 14, int(0, 59)) : null,
        paymentTermsDays: job.account.paymentTermsDays,
        subtotalExGst: decimal(extras),
        gst: decimal(gstOf(extras)),
        totalIncGst: decimal(extras + gstOf(extras)),
        templateName: 'Standard',
        notes: 'Additional charges, invoiced separately.',
        ...xeroStateFor(status, issuedOn),
        lastChasedAt: null,
        chaseCount: 0,
        createdAt: at(issuedOn, 9),
        updatedAt: at(issuedOn, 9),
      });
      lineDocs.push({
        invoiceId: extraId,
        description: 'Contamination and additional services',
        quantity: 1,
        unitRate: decimal(extras),
        amount: decimal(extras),
        raisedBy: job.driver?.name ?? 'Office',
        sourceChargeId: null,
        position: 0,
      });
    }
  }

  await InvoiceModel.insertMany(invoiceDocs, { timestamps: false });
  await InvoiceLineModel.insertMany(lineDocs);
  log.info({ invoices: invoiceDocs.length, lines: lineDocs.length }, 'invoices seeded');
  return invoiceNumber;
}

/**
 * The same split the charges use, so the invoice and the job agree line for
 * line. Deriving both from `totalExGstCents` rather than rolling a second set
 * of numbers is what makes that guaranteed rather than likely.
 */
function pushLines(
  lineDocs: Record<string, unknown>[],
  invoiceId: mongoose.Types.ObjectId,
  job: JobDraft,
): void {
  const serviceFeeCents = Math.round(
    job.totalExGstCents * (job.expectedAreaM2 === null ? 1 : 0.35),
  );
  lineDocs.push({
    invoiceId,
    description: 'Collection service fee',
    quantity: 1,
    unitRate: decimal(serviceFeeCents),
    amount: decimal(serviceFeeCents),
    raisedBy: null,
    sourceChargeId: null,
    position: 0,
  });
  if (job.expectedAreaM2 !== null && job.expectedAreaM2 > 0) {
    const areaCents = job.totalExGstCents - serviceFeeCents;
    lineDocs.push({
      invoiceId,
      description: `Plasterboard recovery - ${String(job.expectedAreaM2)} m2`,
      quantity: job.expectedAreaM2,
      unitRate: decimal(Math.round(areaCents / job.expectedAreaM2)),
      amount: decimal(areaCents),
      raisedBy: null,
      sourceChargeId: null,
      position: 1,
    });
  }
}

/**
 * Xero sync state.
 *
 * A draft has never been pushed, and most sent invoices are synced. A few fail,
 * because the failure row is the only one the integrations screen exists for —
 * and a `failed` state with no message on it tells the operator nothing about
 * what to do next.
 */
function xeroStateFor(
  status: string,
  issuedOn: string,
): {
  xeroState: string;
  xeroLastSyncAt: Date | null;
  xeroMessage: string | null;
  xeroInvoiceId: string | null;
} {
  if (status === 'draft') {
    return {
      xeroState: 'not-synced',
      xeroLastSyncAt: null,
      xeroMessage: null,
      xeroInvoiceId: null,
    };
  }
  if (chance(0.08)) {
    return {
      xeroState: 'failed',
      xeroLastSyncAt: at(issuedOn, 9, 30),
      xeroMessage: pick([
        'Contact not found in Xero — create the customer first.',
        'Account code 200 is archived.',
        'Invoice number already exists in Xero.',
      ]),
      xeroInvoiceId: null,
    };
  }
  return {
    xeroState: 'synced',
    xeroLastSyncAt: at(issuedOn, 9, 30),
    xeroMessage: null,
    xeroInvoiceId: `XERO-${String(int(100_000, 999_999))}`,
  };
}

/* ══ Section 10 — the queues the office works from ══════════════════════════ */

async function seedQueues(jobs: readonly JobDraft[], people: People): Promise<void> {
  /* ── Futile review ─────────────────────────────────────────────────────── */
  const futileDocs = jobs
    .filter((job) => job.status === 'futile')
    .map((job) => {
      /*
       * Recent ones are still pending, which is what makes the queue a queue.
       * A decided review carries who decided it and, if it was rescheduled, the
       * new ready date — the decision is only useful if it says what happens
       * next.
       */
      const markedAt = job.completedAt ?? at(job.readyDate, 10);
      const pending = markedAt >= at(day(-10), 0);
      const rescheduled = !pending && chance(0.65);
      return {
        jobId: job.id,
        reason: job.exceptionReason ?? 'other',
        note: job.exceptionNote,
        markedAt,
        outcome: pending ? 'pending' : rescheduled ? 'rescheduled' : 'cancelled',
        decisionNote: pending
          ? null
          : rescheduled
            ? 'Supervisor confirmed the board will be stacked — rebooked.'
            : 'Builder cancelled the pickup, no charge.',
        decidedAt: pending ? null : new Date(markedAt.getTime() + int(2, 40) * 3_600_000),
        decidedByUserId: null,
        decidedBy: pending ? null : pick(['Renee Alvarez', 'Priya Raman']),
        newReadyDate:
          pending || !rescheduled ? null : toWeekday(shiftDays(job.readyDate, int(4, 12))),
      };
    });
  await FutileReviewModel.insertMany(futileDocs);

  /* ── Change requests, raised from the portal ───────────────────────────── */
  const changeDocs: Record<string, unknown>[] = [];
  const portalCandidates = jobs.filter(
    (job) => job.status === 'booked' || job.status === 'assigned',
  );
  for (const user of people.portalUsers) {
    const theirs = portalCandidates.filter((job) => job.account.id.equals(user.accountId));
    if (theirs.length === 0) continue;
    const job = pick(theirs);
    /*
     * Two open, so the queue has something in it, and one already actioned, so
     * the resolved view is not empty either. A customer who asks to move a date
     * gets an answer in the same thread they asked in — which only reads as a
     * conversation if some of them have been answered.
     */
    const open = chance(0.6);
    const kind = pick(['reschedule', 'reschedule', 'cancel', 'other'] as const);
    const requestedAt = at(day(-int(0, 8)), int(8, 17), int(0, 59));
    changeDocs.push({
      jobId: job.id,
      accountId: user.accountId,
      kind,
      requestedDate: kind === 'reschedule' ? toWeekday(day(int(2, 10))) : null,
      note: {
        reschedule: 'Plasterers are running a week behind — can we push this back?',
        cancel: 'Owner has changed the scope, no board to collect.',
        other: 'Can the driver ring me before he arrives? The gate is locked.',
      }[kind],
      requestedByUserId: user.id,
      requestedByName: user.name,
      requestedAt,
      state: open ? 'open' : pick(['actioned', 'declined'] as const),
      resolvedAt: open ? null : new Date(requestedAt.getTime() + int(2, 30) * 3_600_000),
      resolvedBy: open ? null : 'Renee Alvarez',
      resolutionNote: open
        ? null
        : pick(['Moved to the date requested.', 'Too late to change — the run is already out.']),
    });
  }
  await ChangeRequestModel.insertMany(changeDocs);

  /*
   * ── Readiness certifications ──────────────────────────────────────────
   * The customer's own declaration that the site is ready. It is the record
   * that decides who pays for a futile run, so it sits against the job rather
   * than in the booking form's memory.
   */
  const readinessDocs: Record<string, unknown>[] = [];
  for (const job of jobs) {
    if (job.doc.bookedBySource !== 'portal') continue;
    if (!chance(0.7)) continue;
    const supervisor = people.portalUsers.find((user) => user.name === job.doc.bookedByName);
    if (!supervisor) continue;
    const clean = chance(0.85);
    readinessDocs.push({
      jobId: job.id,
      jobReady: true,
      truckAccessible: clean,
      freeOfContaminants: clean,
      certifiedAt: bookedAtFor(job),
      certifiedByUserId: supervisor.id,
      certifiedByName: supervisor.name,
      certifiedByCompany: job.account.name,
    });
  }
  await ReadinessCertificationModel.insertMany(readinessDocs);

  log.info(
    {
      futileReviews: futileDocs.length,
      changeRequests: changeDocs.length,
      readiness: readinessDocs.length,
    },
    'queues seeded',
  );
}

/* ══ Section 11 — leads ═════════════════════════════════════════════════════ */

/**
 * The enquiry pipeline, one lead in every status.
 *
 * A board with five columns and rows in only one of them cannot show that it
 * is a board. The won lead points at a real account, because "what happened to
 * that enquiry" is the question the status is there to answer.
 */
async function seedLeads(accounts: readonly SeededAccount[]): Promise<void> {
  const won = accounts.find((account) => account.code === 'ALL001');

  const LEADS = [
    {
      companyName: 'Bellriver Homes',
      contactName: 'Grant Mackie',
      email: 'grant@bellriverhomes.com.au',
      status: 'new',
      source: 'enquiry-form',
      zone: 'sydney',
      suburbs: 'Box Hill, Marsden Park',
      volume: 600,
      frequency: '3–4 per week',
      owner: null,
      note: null,
    },
    {
      companyName: 'Hotondo Homes Illawarra',
      contactName: 'Simone Petrovic',
      email: 'simone@hotondoillawarra.com.au',
      status: 'contacted',
      source: 'phone',
      zone: 'wollongong',
      suburbs: 'Shell Cove, Dapto',
      volume: 350,
      frequency: 'Weekly',
      owner: 'Renee Alvarez',
      note: 'Rang back Tuesday. Wants pricing for the Shell Cove estate.',
    },
    {
      companyName: 'Thrive Homes',
      contactName: 'Adam Beattie',
      email: 'adam@thrivehomes.com.au',
      status: 'quoted',
      source: 'referral',
      zone: 'newcastle',
      suburbs: 'Thornton, Fletcher',
      volume: 800,
      frequency: '2 per week',
      owner: 'Matthew Browne',
      note: 'Quoted tier 3. Comparing against their current contractor.',
    },
    {
      companyName: 'Allcastle Homes',
      contactName: 'Tomas Herrera',
      email: 'tomas@allcastlehomes.com.au',
      status: 'won',
      source: 'referral',
      zone: 'newcastle',
      suburbs: 'Medowie, Thornton',
      volume: 500,
      frequency: 'Weekly',
      owner: 'Matthew Browne',
      note: 'Signed. Onboarded on the EasyLift brand.',
    },
    {
      companyName: 'Vision Homes NSW',
      contactName: 'Priya Deshmukh',
      email: 'priya@visionhomesnsw.com.au',
      status: 'lost',
      source: 'enquiry-form',
      zone: 'sydney',
      suburbs: 'Leppington, Austral',
      volume: 250,
      frequency: 'Fortnightly',
      owner: 'Renee Alvarez',
      note: 'Went with the incumbent on price. Worth another call in six months.',
    },
    {
      companyName: 'Sanctuary Living',
      contactName: 'Ben Kovac',
      email: 'ben@sanctuaryliving.com.au',
      status: 'contacted',
      source: 'other',
      zone: 'sydney',
      suburbs: 'Oran Park, Catherine Field',
      volume: 420,
      frequency: 'Weekly',
      owner: 'Priya Raman',
      note: 'Left a message. Trying again Thursday.',
    },
  ] as const;

  const leadDocs: Record<string, unknown>[] = [];
  const noteDocs: Record<string, unknown>[] = [];

  for (const lead of LEADS) {
    const id = oid();
    const lastActivityAt = at(toWeekday(day(-int(0, 30))), int(9, 16), int(0, 59));
    const isWon = lead.status === 'won';
    leadDocs.push({
      _id: id,
      companyName: lead.companyName,
      contactName: lead.contactName,
      email: lead.email,
      mobile: `04${String(int(10, 99))}${String(int(100_000, 999_999))}`,
      status: lead.status,
      source: lead.source,
      zone: lead.zone,
      suburbs: lead.suburbs,
      typicalVolumeM2: lead.volume,
      expectedFrequency: lead.frequency,
      heardAbout: pick(['Google', 'Another builder', 'Saw the truck on site', '']),
      ownerName: lead.owner,
      ownerUserId: null,
      lastActivityAt,
      // A won lead that does not point at the account it became is a dead end
      // for anybody asking how the customer arrived.
      convertedAccountId: isWon ? (won?.id ?? null) : null,
      convertedAt: isWon ? lastActivityAt : null,
    });
    if (lead.note) {
      noteDocs.push({
        leadId: id,
        at: lastActivityAt,
        authorId: null,
        author: lead.owner ?? 'Renee Alvarez',
        body: lead.note,
      });
    }
  }

  await LeadModel.insertMany(leadDocs);
  await LeadNoteModel.insertMany(noteDocs);
  log.info({ leads: leadDocs.length }, 'leads seeded');
}

/* ══ Section 12 — diversion certificates ════════════════════════════════════ */

/**
 * The document the customer actually wants from us.
 *
 * ── Why the figures are summed rather than invented ────────────────────────
 * A certificate says how many tonnes of plasterboard were kept out of landfill
 * for one account over one period. That number appears in the customer's own
 * GBCA reporting, so it has to be the sum of the jobs behind it — if the
 * certificate and the job list disagree, the certificate is the one that is
 * wrong, and it is the one that has already been sent.
 *
 * The current month is left as a DRAFT: the period is not over, so issuing it
 * would certify tonnage that has not been collected yet.
 */
async function seedCertificates(
  jobs: readonly JobDraft[],
  accounts: readonly SeededAccount[],
): Promise<void> {
  const docs: Record<string, unknown>[] = [];
  let sequence = 1;
  const reference = (): string => {
    const value = `PG-CERT-${TODAY.slice(0, 4)}-${String(sequence).padStart(4, '0')}`;
    sequence += 1;
    return value;
  };

  const completed = jobs.filter(
    (job) => (job.status === 'completed' || job.status === 'admin-complete') && job.completedAt,
  );

  for (const account of accounts) {
    const theirs = completed.filter((job) => job.account.id.equals(account.id));
    if (theirs.length === 0) continue;

    // Three closed months and the one in progress.
    for (let monthsBack = 3; monthsBack >= 0; monthsBack -= 1) {
      const anchor = new Date(`${TODAY.slice(0, 7)}-01T00:00:00Z`);
      anchor.setUTCMonth(anchor.getUTCMonth() - monthsBack);
      const periodFrom = anchor.toISOString().slice(0, 10);
      const end = new Date(anchor);
      end.setUTCMonth(end.getUTCMonth() + 1);
      end.setUTCDate(0);
      const periodTo = end.toISOString().slice(0, 10);

      const inPeriod = theirs.filter((job) => {
        const done = job.completedAt?.toISOString().slice(0, 10) ?? '';
        return done >= periodFrom && done <= periodTo;
      });
      if (inPeriod.length === 0) continue;

      const kilos = inPeriod.reduce((sum, job) => sum + (job.recoveredWeightKg ?? 0), 0);
      const areaTotal = inPeriod.reduce((sum, job) => sum + (job.expectedAreaM2 ?? 0), 0);
      const current = monthsBack === 0;

      docs.push({
        reference: reference(),
        scope: 'period',
        state: current ? 'draft' : 'issued',
        accountId: account.id,
        accountName: account.name,
        siteName: null,
        jobId: null,
        jobNumber: null,
        periodFrom,
        periodTo,
        jobs: inPeriod.length,
        areaM2: Math.round(areaTotal * 10) / 10,
        tonnesDiverted: Math.round((kilos / 1_000) * 100) / 100,
        issuedAt: current ? null : at(shiftDays(periodTo, 2), 10, int(0, 59)),
        issuedTo: current
          ? null
          : (account.certificateEmail ?? `accounts@${account.code.toLowerCase()}.com.au`),
        issuedByName: current ? null : 'Priya Raman',
        storageKey: null,
      });
    }
  }

  /*
   * Two per-job certificates. Some builders want one per house rather than one
   * per month, because it goes into that property's own compliance file.
   */
  for (const job of completed.slice(0, 2)) {
    docs.push({
      reference: reference(),
      scope: 'job',
      state: 'issued',
      accountId: job.account.id,
      accountName: job.account.name,
      siteName: String(job.doc.siteName),
      jobId: job.id,
      jobNumber: job.jobNumber,
      periodFrom: job.readyDate,
      periodTo: job.readyDate,
      jobs: 1,
      areaM2: job.expectedAreaM2,
      tonnesDiverted: Math.round(((job.recoveredWeightKg ?? 0) / 1_000) * 100) / 100,
      issuedAt: at(shiftDays(job.readyDate, 1), 11, int(0, 59)),
      issuedTo: job.account.certificateEmail ?? 'site@builder.com.au',
      issuedByName: 'Priya Raman',
      storageKey: null,
    });
  }

  await CertificateModel.insertMany(docs);
  log.info({ certificates: docs.length }, 'certificates seeded');
}

/* ══ Section 13 — notifications, and the messages actually sent out ════════ */

/**
 * Two different things that both look like "a notification".
 *
 * `notifications` is the bell in the app: unread counts, a list you work
 * through, addressed to a USER. `outboundmessages` is the log of what left the
 * building by email or SMS, addressed to a CUSTOMER who mostly has no login at
 * all. They are separate collections because they answer separate questions —
 * "what do I need to look at" and "did the builder get told" — and the second
 * one is the one that gets asked in an argument about a futile charge.
 *
 * Every user gets some unread, because a bell with a zero on it cannot show
 * what the bell is for.
 */
async function seedNotifications(
  jobs: readonly JobDraft[],
  people: People,
  accounts: readonly SeededAccount[],
): Promise<void> {
  const notificationDocs: Record<string, unknown>[] = [];
  const outboundDocs: Record<string, unknown>[] = [];

  const office = [...people.staff.values()].filter((user) =>
    ['super-admin', 'operations', 'office-staff', 'allocator'].includes(user.role),
  );

  const pendingApprovals = jobs.filter((job) => job.status === 'completed').slice(0, 3);
  const futile = jobs.filter((job) => job.status === 'futile').slice(0, 3);
  const late = jobs.filter((job) => job.targetDate < TODAY && job.status === 'booked').slice(0, 2);

  /* ── The office bell ───────────────────────────────────────────────────── */
  for (const user of office) {
    if (user.name === 'Former Staffer') continue;

    notificationDocs.push({
      userId: user.id,
      category: 'queue',
      severity: 'action',
      title: 'PO review queue',
      body: 'Six purchase orders are waiting to be matched to an account.',
      at: at(TODAY, 7, 5),
      readAt: null,
      href: '/queues/po-review',
      valueExGst: null,
      jobId: null,
      jobNumber: null,
      subjectKey: 'queue:po-review:digest',
    });

    for (const [index, job] of futile.entries()) {
      notificationDocs.push({
        userId: user.id,
        category: 'exception',
        severity: 'urgent',
        title: `Job ${String(job.jobNumber)} marked futile`,
        body: `${job.driver?.name ?? 'The driver'} attended ${String(job.doc.suburb)} and could not collect. ${job.exceptionNote ?? ''}`,
        at: job.completedAt ?? at(job.readyDate, 11),
        // The oldest is left unread on purpose: an urgent row that has been
        // sitting for days is the thing the screen is meant to make impossible
        // to miss.
        readAt: index === 0 ? null : at(day(-1), 16),
        href: `/jobs/${job.id.toHexString()}`,
        valueExGst: null,
        jobId: job.id,
        jobNumber: job.jobNumber,
        subjectKey: `job:${job.id.toHexString()}:futile`,
      });
    }

    for (const job of pendingApprovals) {
      notificationDocs.push({
        userId: user.id,
        category: 'queue',
        severity: 'action',
        title: 'Contamination charge needs approval',
        body: `Raised on job ${String(job.jobNumber)} at ${String(job.doc.suburb)}.`,
        at: job.completedAt ?? at(job.readyDate, 12),
        readAt: null,
        href: '/queues/approvals',
        valueExGst: decimal(int(8_000, 24_000)),
        jobId: job.id,
        jobNumber: job.jobNumber,
        subjectKey: `job:${job.id.toHexString()}:charge-approval`,
      });
    }

    for (const job of late) {
      notificationDocs.push({
        userId: user.id,
        category: 'exception',
        severity: 'action',
        title: `Job ${String(job.jobNumber)} is past its target date`,
        body: `Target was ${job.targetDate} and it is still unallocated.`,
        at: at(TODAY, 6, 30),
        readAt: null,
        href: '/dispatch',
        valueExGst: null,
        jobId: job.id,
        jobNumber: job.jobNumber,
        subjectKey: `job:${job.id.toHexString()}:at-risk`,
      });
    }

    notificationDocs.push({
      userId: user.id,
      category: 'sync',
      severity: 'action',
      title: 'Xero sync failed',
      body: 'Two invoices could not be pushed — the contact is missing in Xero.',
      at: at(day(-1), 9, 12),
      readAt: null,
      href: '/invoices?xero=failed',
      valueExGst: null,
      jobId: null,
      jobNumber: null,
      subjectKey: 'sync:xero:failed',
    });

    notificationDocs.push({
      userId: user.id,
      category: 'invoice',
      severity: 'info',
      title: 'Invoices sent',
      body: 'Last night’s run produced 9 invoices, all synced to Xero.',
      at: at(day(-1), 19, 0),
      readAt: at(TODAY, 7, 20),
      href: '/invoices',
      valueExGst: null,
      jobId: null,
      jobNumber: null,
      subjectKey: 'invoice:nightly:digest',
    });

    notificationDocs.push({
      userId: user.id,
      category: 'system',
      severity: 'info',
      title: 'Driver credentials expiring',
      body: 'Two credentials expire within 30 days. One has already lapsed.',
      at: at(day(-2), 7, 0),
      readAt: null,
      href: '/drivers',
      valueExGst: null,
      jobId: null,
      jobNumber: null,
      subjectKey: 'system:credentials:expiring',
    });
  }

  /* ── The driver's bell — short, and only about their own work ──────────── */
  for (const driver of people.drivers) {
    const theirs = jobs.filter(
      (job) => job.driver?.id.equals(driver.id) && job.readyDate === TODAY,
    );
    const first = theirs[0];
    notificationDocs.push({
      userId: driver.id,
      category: 'system',
      severity: 'info',
      title: 'Today’s run is ready',
      body: `${String(theirs.length)} stops. Complete the pre-start before you leave the yard.`,
      at: at(TODAY, 5, 30),
      readAt: chance(0.5) ? at(TODAY, 5, 48) : null,
      href: '/driver',
      valueExGst: null,
      jobId: null,
      jobNumber: null,
      subjectKey: `driver:${driver.id.toHexString()}:run-ready:${TODAY}`,
    });
    if (first) {
      notificationDocs.push({
        userId: driver.id,
        category: 'system',
        severity: 'action',
        title: `Note added to job ${String(first.jobNumber)}`,
        body: 'Gate code is 4471 — the sign on the fence is out of date.',
        at: at(TODAY, 6, 15),
        readAt: null,
        href: `/driver/jobs/${first.id.toHexString()}`,
        valueExGst: null,
        jobId: first.id,
        jobNumber: first.jobNumber,
        subjectKey: `job:${first.id.toHexString()}:driver-note`,
      });
    }
  }

  /* ── The customer's bell ───────────────────────────────────────────────── */
  for (const user of people.portalUsers) {
    const theirs = jobs.filter((job) => job.account.id.equals(user.accountId));
    const done = theirs.find((job) => job.status === 'completed');
    const upcoming = theirs.find((job) => job.status === 'assigned' || job.status === 'booked');

    if (done) {
      notificationDocs.push({
        userId: user.id,
        category: 'system',
        severity: 'info',
        title: `Job ${String(done.jobNumber)} completed`,
        body: `${String(done.doc.siteName)} collected. Photos and the docket are on the job.`,
        at: done.completedAt ?? at(done.readyDate, 13),
        readAt: chance(0.5) ? at(day(-1), 18) : null,
        href: `/portal/jobs/${done.id.toHexString()}`,
        valueExGst: null,
        jobId: done.id,
        jobNumber: done.jobNumber,
        subjectKey: `job:${done.id.toHexString()}:completed:${user.id.toHexString()}`,
      });
    }
    if (upcoming) {
      notificationDocs.push({
        userId: user.id,
        category: 'system',
        severity: 'action',
        title: 'Pickup coming up',
        body: `Job ${String(upcoming.jobNumber)} at ${String(upcoming.doc.suburb)} is booked for ${upcoming.readyDate}. Make sure the board is stacked and accessible.`,
        at: at(day(-1), 7, 0),
        readAt: null,
        href: `/portal/jobs/${upcoming.id.toHexString()}`,
        valueExGst: null,
        jobId: upcoming.id,
        jobNumber: upcoming.jobNumber,
        subjectKey: `job:${upcoming.id.toHexString()}:reminder:${user.id.toHexString()}`,
      });
    }
    if (user.role === 'customer-administrator') {
      notificationDocs.push({
        userId: user.id,
        category: 'invoice',
        severity: 'info',
        title: 'Diversion certificate ready',
        body: 'Your certificate for last month is available to download.',
        at: at(day(-4), 10, 0),
        readAt: null,
        href: '/portal/certificates',
        valueExGst: null,
        jobId: null,
        jobNumber: null,
        subjectKey: `certificate:monthly:${user.id.toHexString()}`,
      });
    }
  }

  /*
   * ── What actually left the building ───────────────────────────────────
   * One row per message per channel, including the ones that FAILED and the
   * ones that were SKIPPED because the account had the rule turned off. A log
   * that only records successes cannot answer "why didn't they get it", which
   * is the only reason anybody opens it.
   */
  const notified = jobs
    .filter((job) => ['completed', 'futile', 'assigned'].includes(job.status))
    .slice(0, 40);

  for (const job of notified) {
    const account = accounts.find((candidate) => candidate.id.equals(job.account.id));
    const event =
      job.status === 'completed'
        ? 'job-completed'
        : job.status === 'futile'
          ? 'job-futile'
          : 'job-allocated';
    const sentAt = job.completedAt ?? at(job.readyDate, 8, int(0, 59));

    outboundDocs.push({
      event,
      channel: 'email',
      toMasked: `acc•••@${(account?.code ?? 'cus').toLowerCase()}.com.au`,
      subject:
        event === 'job-completed'
          ? `Collection complete — job ${String(job.jobNumber)}`
          : event === 'job-futile'
            ? `Could not collect — job ${String(job.jobNumber)}`
            : `Pickup scheduled — job ${String(job.jobNumber)}`,
      accountId: job.account.id,
      jobId: job.id,
      invoiceId: null,
      sentAt,
      outcome: chance(0.9) ? 'sent' : chance(0.5) ? 'failed' : 'skipped',
      detail: chance(0.9) ? null : 'Mailbox full at the recipient’s server.',
      subjectKey: `job:${job.id.toHexString()}:${event}`,
    });

    if (job.doc.siteContactMobile && chance(0.6)) {
      outboundDocs.push({
        event: 'driver-on-the-way',
        channel: 'sms',
        toMasked: '04•• ••• •22',
        subject: '',
        accountId: job.account.id,
        jobId: job.id,
        invoiceId: null,
        sentAt: new Date(sentAt.getTime() - 40 * 60_000),
        outcome: 'sent',
        detail: null,
        subjectKey: `job:${job.id.toHexString()}:driver-on-the-way`,
      });
    }
  }

  await NotificationModel.insertMany(notificationDocs);
  await OutboundMessageModel.insertMany(outboundDocs);
  log.info(
    { notifications: notificationDocs.length, outbound: outboundDocs.length },
    'notifications seeded',
  );
}

/* ══ Orchestration ══════════════════════════════════════════════════════════ */

/**
 * Rates, read out of the database rather than restated here.
 *
 * `seed-settings` owns what a zone costs. Copying those numbers into this file
 * would mean a rate change silently stopped applying to demo data, and the
 * first sign of it would be a client asking why the invoice does not match the
 * rate card on the settings screen.
 */
async function loadRates(): Promise<RateTable> {
  const rows = await ZoneRateModel.find({}).lean<
    Array<{ rateCardId: string; zone: Zone; serviceCharge: unknown; ratePerM2: unknown }>
  >();
  if (rows.length === 0) {
    throw new Error('no zone rates — run `npm run seed:settings` before this script');
  }

  const table: RateTable = new Map();
  for (const row of rows) {
    table.set(`${row.rateCardId}:${row.zone}`, {
      serviceCharge: moneyToCents(fromDecimal128(row.serviceCharge as never)),
      ratePerM2: moneyToCents(fromDecimal128(row.ratePerM2 as never)),
    });
  }
  return table;
}

async function loadPlaces(): Promise<SeededPlace[]> {
  const rows = await PlaceModel.find({}).lean<SeededPlace[]>();
  if (rows.length === 0) {
    throw new Error('no places — run `npm run seed:places` before this script');
  }
  return rows;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-demo refuses to run with NODE_ENV=production');
  }

  await connectMongo();
  if (!isMongoConnected()) {
    throw new Error('Could not reach MongoDB — is it running?');
  }

  /*
   * Insert-only, so a second run over its own output collides on `jobNumber`
   * halfway through and leaves the database in a state nobody can reason
   * about. Failing before writing anything is the kinder outcome.
   */
  const existingJobs = await JobModel.estimatedDocumentCount().exec();
  if (existingJobs > 0) {
    throw new Error(
      `${String(existingJobs)} jobs are already here. Run \`npm run seed:all\`, which resets first.`,
    );
  }

  const [places, rates] = await Promise.all([loadPlaces(), loadRates()]);

  const settings = await SettingsModel.findById(SETTINGS_SINGLETON_ID).lean<{
    nextJobNumber: number;
    nextInvoiceNumber: number;
    nextRunNumber: number;
  } | null>();
  if (!settings) {
    throw new Error('settings have not been seeded — run `npm run seed:settings`');
  }

  const accounts = await seedAccounts();
  const people = await seedPeople(accounts);
  const truckByDriver = await seedFleet(people);

  const factory = makeJobFactory(places, rates, settings.nextJobNumber);
  const runs = buildSchedule(factory, accounts, people, truckByDriver);
  const jobs = factory.drafts;

  await seedPurchaseOrders(jobs, accounts);
  const chargeSummaries = await seedCharges(jobs);
  const nextInvoiceNumber = await seedInvoices(jobs, chargeSummaries, settings.nextInvoiceNumber);

  // Jobs go in LAST of the job-shaped writes, because everything above mutates
  // their drafts — the PO number, the invoice state, the charge totals.
  await seedJobDetail(jobs, runs, truckByDriver);
  await persistRuns(runs);

  await seedQueues(jobs, people);
  await seedLeads(accounts);
  await seedCertificates(jobs, accounts);
  await seedNotifications(jobs, people, accounts);

  /*
   * ⚠️ Move the counters past everything just written.
   *
   * Job, run and invoice numbers are allocated atomically from these, and they
   * are UNIQUE. Leaving them where they started means the first job anybody
   * creates in the demo collides with a seeded one and fails with a duplicate
   * key — which happens the moment someone clicks "New job" in front of the
   * client.
   */
  const lastJobNumber = jobs.reduce(
    (max, job) => Math.max(max, job.jobNumber),
    settings.nextJobNumber,
  );
  const lastRunNumber = runs.reduce(
    (max, run) => Math.max(max, run.runNumber),
    settings.nextRunNumber,
  );
  await SettingsModel.updateOne(
    { _id: SETTINGS_SINGLETON_ID },
    {
      $set: {
        nextJobNumber: lastJobNumber + 1,
        nextRunNumber: lastRunNumber + 1,
        nextInvoiceNumber,
      },
    },
  ).exec();

  await report(jobs, runs);
}

/**
 * The operator's cue after running a script by hand.
 *
 * Printed rather than logged on purpose: this is not telemetry, so it should
 * not be JSON and should not disappear when someone raises `LOG_LEVEL`.
 */
async function report(jobs: readonly JobDraft[], runs: readonly RunDraft[]): Promise<void> {
  const [statusRows, invoiceRows, pendingCharges, poReview, futilePending] = await Promise.all([
    JobModel.aggregate<{ _id: string; n: number }>([
      { $group: { _id: '$status', n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    InvoiceModel.aggregate<{ _id: string; n: number }>([
      { $group: { _id: '$status', n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    JobChargeModel.countDocuments({ approvalState: 'pending' }).exec(),
    PoExtractionModel.countDocuments({ state: 'needs-review' }).exec(),
    FutileReviewModel.countDocuments({ outcome: 'pending' }).exec(),
  ]);

  const jobsToday = jobs.filter((job) => job.readyDate === TODAY).length;
  const runsToday = runs.filter((run) => run.date === TODAY).length;
  const line = (rows: Array<{ _id: string; n: number }>): string =>
    rows.map((row) => `${row._id} ${String(row.n)}`).join(' · ');

  // eslint-disable-next-line no-console
  console.log(`
Seeded "${mongoose.connection.name}" with a full demo dataset.

  Jobs        ${String(jobs.length)}   ${line(statusRows)}
  Runs        ${String(runs.length)}   ${String(runsToday)} today
  Invoices          ${line(invoiceRows)}
  Today       ${String(jobsToday)} jobs on ${String(runsToday)} runs, dated ${TODAY} in Sydney

Queues waiting:
  Approvals   ${String(pendingCharges)}
  PO review   ${String(poReview)}
  Futile      ${String(futilePending)}

Sign in with any identity from seed:auth — the code prints in the API log
while MAIL_PROVIDER/SMS_PROVIDER are "stub":

  matt@plastago.com.au         super-admin       admin console, everything
  renee@plastago.com.au        operations        admin console
  office@plastago.com.au       office-staff      admin console
  allocations@plastago.com.au  allocator         dispatch board
  0455112233                   driver            driver app  ← SMS
  accounts@iplasta.com.au      customer-admin    portal
  0466778899                   site supervisor   portal      ← SMS
`);
}

await main()
  .catch((error: unknown) => {
    log.fatal({ err: error }, 'seed failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectMongo();
  });
