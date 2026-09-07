import type {
  AccountStatus,
  AccountType,
  BrandId,
  CaptureMode,
  Contact,
  Place,
  PoPolicy,
  RateCardId,
  Zone,
} from '@plastago/shared';

/**
 * Reference data for the demo.
 *
 * ⚠️ FIXTURES. Accounts, builders, sites, drivers and vehicles here are drawn
 * from the world the scope document describes — iPlasta invoiced while GJ Gardner
 * is the builder on site, greenfield lots in the south-west growth corridor,
 * Troy on an iPhone — so the demo reads as PlastaGo rather than as Lorem Ipsum.
 * None of it is a business fact, and the whole folder is deleted when the real
 * domains land.
 *
 * ── Deterministic on purpose ───────────────────────────────────────────────
 * Everything generated from this file runs through a seeded PRNG, never
 * `Math.random()`. A demo that reshuffles its own data on every reload is one
 * where a client points at a number and it is gone by the time you look. It also
 * makes a screenshot reproducible.
 */

/** Mulberry32 — small, fast, and identical on every run for a given seed. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  // `noUncheckedIndexedAccess` is on; a non-empty list always yields a value.
  if (item === undefined) throw new Error('pick() called with an empty list');
  return item;
}

export function intBetween(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/** 24-hex ObjectIds, generated so fixtures satisfy `ObjectIdSchema`. */
export function objectId(prefix: string, index: number): string {
  const head = prefix.padEnd(6, '0').slice(0, 6);
  const hex = [...head].map((c) => (c.charCodeAt(0) % 16).toString(16)).join('');
  return `${hex}${index.toString(16).padStart(18, '0')}`;
}

/**
 * M6.3 — verified zone rates. Sydney $220 + $0.16/m²; Wollongong $250 + $0.18;
 * Newcastle $250 + $0.20. Bags are $30 each.
 *
 * Held in CENTS as integers. Money must never touch a float (§6A.10 #1), and
 * these values exist here only so the mock can produce a believable total —
 * the real engine is server-side and must match TransVirtual to the cent.
 */
export const ZONE_RATES: Record<Zone, { serviceCents: number; perM2Cents: number }> = {
  sydney: { serviceCents: 22000, perM2Cents: 16 },
  wollongong: { serviceCents: 25000, perM2Cents: 18 },
  newcastle: { serviceCents: 25000, perM2Cents: 20 },
};

export const BAG_RATE_CENTS = 3000;
export const CONTAMINATION_CENTS = 9000;
export const FUTILE_CENTS = 12000;
export const EXTRA_LOAD_TIME_CENTS = 10000;

/** Integer cents → the decimal string the wire and the UI use. */
export function centsToMoney(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  return `${negative ? '-' : ''}${String(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
}

export interface AccountFixture {
  id: string;
  code: string;
  name: string;
  /** Builder or contractor — see `AccountTypeSchema`. Drives both journeys. */
  accountType: AccountType;
  brandId: BrandId;
  rateCardId: RateCardId;
  poPolicy: PoPolicy;
  captureMode: CaptureMode;
  status: AccountStatus;
  abn: string;
  paymentTermsDays: number;
  primaryZone: Zone;
  preferredPickupWindow: string | null;
  notes: string;
  builders: readonly string[];
  contacts: Contact[];
  /**
   * M4.8b — this builder contractually requires a Site Risk Assessment.
   *
   * On for the two project-home builders and off for the rest, because that is
   * how Matt described it — a rule some clients impose, not a PlastaGo policy.
   * A demo where every account requires it would never exercise the far more
   * common path of a driver arriving and simply starting work.
   */
  riskAssessmentRequired: boolean;
}

function contact(
  accountIndex: number,
  index: number,
  name: string,
  role: Contact['role'],
  email: string | null,
  mobile: string | null,
): Contact {
  return {
    id: objectId('ct', accountIndex * 10 + index),
    name,
    role,
    email,
    mobile,
    notifyBySms: mobile !== null,
    notifyByEmail: email !== null,
  };
}

/**
 * Twelve accounts. The top five carry most of the volume, matching the real
 * concentration — five accounts are 87% of revenue and one is 34% — because a
 * dashboard built against evenly-spread demo data hides exactly the skew that
 * makes this business what it is.
 */
export const ACCOUNTS: readonly AccountFixture[] = [
  {
    id: objectId('ac', 1),
    code: 'IPL001',
    accountType: 'contractor',
    name: 'iPlasta Pty Ltd',
    brandId: 'plastago',
    rateCardId: 'tier-1',
    poPolicy: 'not-required',
    captureMode: 'area-only',
    status: 'active',
    abn: '24 118 552 901',
    paymentTermsDays: 7,
    primaryZone: 'sydney',
    preferredPickupWindow: 'Weekdays 7am–2pm',
    notes: 'Largest account. Records m² only — weight is never captured.',
    builders: ['GJ Gardner', 'Fowler Homes', 'King Homes'],
    riskAssessmentRequired: false,
    contacts: [
      contact(1, 1, 'Angela Fitzgerald', 'accounts', 'accounts@iplasta.com.au', null),
      contact(1, 2, 'Dave Nguyen', 'site', null, '0466778899'),
    ],
  },
  {
    id: objectId('ac', 2),
    code: 'CLA001',
    accountType: 'builder',
    name: 'Clarendon Homes',
    brandId: 'plastago',
    rateCardId: 'clarendon-domaine',
    poPolicy: 'required-before-invoice',
    captureMode: 'area-and-weight',
    status: 'active',
    abn: '61 004 213 771',
    paymentTermsDays: 7,
    primaryZone: 'sydney',
    preferredPickupWindow: null,
    notes: 'PO required before invoicing. Additional charges need a separate PO.',
    builders: ['Clarendon Homes'],
    riskAssessmentRequired: true,
    contacts: [
      contact(2, 1, 'Marcus Webb', 'accounts', 'ap@clarendonhomes.com.au', null),
      contact(2, 2, 'Sione Tupou', 'site', null, '0413556677'),
      contact(2, 3, 'Hannah Lu', 'sustainability', 'esg@clarendonhomes.com.au', null),
    ],
  },
  {
    id: objectId('ac', 3),
    code: 'DOM001',
    accountType: 'builder',
    name: 'Domaine Homes',
    brandId: 'plastago',
    rateCardId: 'clarendon-domaine',
    poPolicy: 'required-before-invoice',
    captureMode: 'area-and-weight',
    status: 'active',
    abn: '77 129 004 118',
    paymentTermsDays: 7,
    primaryZone: 'sydney',
    preferredPickupWindow: null,
    notes: 'Shares the Clarendon rate card.',
    builders: ['Domaine Homes'],
    riskAssessmentRequired: true,
    contacts: [
      contact(3, 1, 'Julia Kefalas', 'accounts', 'accounts@domaine.com.au', null),
      contact(3, 2, 'Brett Sanders', 'site', null, '0421889001'),
    ],
  },
  {
    id: objectId('ac', 4),
    code: 'FOR001',
    accountType: 'contractor',
    name: 'Fornari Group',
    brandId: 'plastago',
    rateCardId: 'tier-2',
    poPolicy: 'not-required',
    captureMode: 'area-only',
    status: 'active',
    abn: '38 611 442 007',
    paymentTermsDays: 7,
    primaryZone: 'sydney',
    preferredPickupWindow: null,
    notes: 'm² only.',
    builders: ['Fornari Group', 'Mirvac'],
    riskAssessmentRequired: false,
    contacts: [contact(4, 1, 'Rosa Fornari', 'accounts', 'rosa@fornari.com.au', '0407221334')],
  },
  {
    id: objectId('ac', 5),
    code: 'WIS001',
    accountType: 'builder',
    name: 'Wisdom Properties Group',
    brandId: 'plastago',
    rateCardId: 'wisdom',
    poPolicy: 'not-required',
    captureMode: 'area-only',
    status: 'active',
    abn: '52 097 336 812',
    paymentTermsDays: 14,
    primaryZone: 'sydney',
    preferredPickupWindow: null,
    notes: 'Bespoke $20 "Fuel Levy — Wisdom" additional service applies.',
    builders: ['Wisdom Homes'],
    riskAssessmentRequired: false,
    contacts: [contact(5, 1, 'Tom Ashworth', 'accounts', 'ap@wisdomhomes.com.au', null)],
  },
  {
    id: objectId('ac', 6),
    code: 'DUR001',
    accountType: 'contractor',
    name: 'Durnco Group Pty Ltd',
    brandId: 'plastago',
    rateCardId: 'tier-2',
    poPolicy: 'required-before-invoice',
    captureMode: 'area-and-weight',
    status: 'active',
    abn: '19 442 880 553',
    paymentTermsDays: 7,
    primaryZone: 'sydney',
    preferredPickupWindow: null,
    notes: 'Services Mirvac and Sharwood sites.',
    builders: ['Mirvac', 'Sharwood'],
    riskAssessmentRequired: false,
    contacts: [contact(6, 1, 'Nadia Haddad', 'accounts', 'accounts@durnco.com.au', null)],
  },
  {
    id: objectId('ac', 7),
    code: 'ELF001',
    accountType: 'contractor',
    name: 'Lakeside Interiors',
    brandId: 'easylift',
    rateCardId: 'tier-3',
    poPolicy: 'not-required',
    captureMode: 'area-only',
    status: 'active',
    abn: '80 553 119 006',
    paymentTermsDays: 7,
    primaryZone: 'newcastle',
    preferredPickupWindow: 'Mornings only',
    notes: 'EasyLift brand — crane work.',
    builders: ['Allam Homes'],
    riskAssessmentRequired: false,
    contacts: [contact(7, 1, 'Craig Peterson', 'site', 'craig@lakesideint.com.au', '0455901223')],
  },
  {
    id: objectId('ac', 8),
    code: 'ELF002',
    accountType: 'contractor',
    name: 'Illawarra Linings',
    brandId: 'easylift',
    rateCardId: 'tier-3',
    poPolicy: 'not-required',
    captureMode: 'area-only',
    status: 'active',
    abn: '43 220 771 884',
    paymentTermsDays: 7,
    primaryZone: 'wollongong',
    preferredPickupWindow: null,
    notes: 'EasyLift brand.',
    builders: ['Rawson Homes'],
    riskAssessmentRequired: false,
    contacts: [contact(8, 1, 'Petra Nowak', 'accounts', 'accounts@illawarralinings.com.au', null)],
  },
  {
    id: objectId('ac', 9),
    code: 'MET001',
    accountType: 'contractor',
    name: 'Metroplast Interiors',
    brandId: 'plastago',
    rateCardId: 'tier-4',
    poPolicy: 'not-required',
    captureMode: 'area-only',
    status: 'active',
    abn: '66 118 447 200',
    paymentTermsDays: 7,
    primaryZone: 'sydney',
    preferredPickupWindow: null,
    notes: '',
    builders: ['Metricon'],
    riskAssessmentRequired: false,
    contacts: [contact(9, 1, 'Ali Rahimi', 'site', null, '0432110987')],
  },
  {
    id: objectId('ac', 10),
    code: 'SGP001',
    accountType: 'contractor',
    name: 'Southgate Plastering',
    brandId: 'plastago',
    rateCardId: 'default',
    poPolicy: 'not-required',
    captureMode: 'area-only',
    status: 'active',
    abn: '29 004 771 663',
    paymentTermsDays: 7,
    primaryZone: 'sydney',
    preferredPickupWindow: null,
    notes: '',
    builders: ['Eden Brae Homes'],
    riskAssessmentRequired: false,
    contacts: [contact(10, 1, 'Vince Marino', 'accounts', 'vince@southgateplaster.com.au', null)],
  },
  {
    id: objectId('ac', 11),
    code: 'PRE001',
    accountType: 'contractor',
    name: 'PrePaid Customer',
    brandId: 'plastago',
    rateCardId: 'default',
    poPolicy: 'not-required',
    captureMode: 'area-only',
    status: 'active',
    abn: '—',
    paymentTermsDays: 0,
    primaryZone: 'sydney',
    preferredPickupWindow: null,
    notes: 'Casual and one-off jobs are booked against this account by the office.',
    builders: ['—'],
    riskAssessmentRequired: false,
    contacts: [],
  },
  {
    id: objectId('ac', 12),
    code: 'HRB001',
    accountType: 'contractor',
    name: 'Harbourline Fitouts',
    brandId: 'plastago',
    rateCardId: 'tier-4',
    poPolicy: 'not-required',
    captureMode: 'area-only',
    status: 'inactive',
    abn: '15 662 003 449',
    paymentTermsDays: 7,
    primaryZone: 'sydney',
    preferredPickupWindow: null,
    notes: 'No jobs in the last 12 months.',
    builders: ['—'],
    riskAssessmentRequired: false,
    contacts: [],
  },
];

/**
 * Suburbs with real coordinates, weighted to the south-west growth corridor.
 *
 * ⚠️ This started as fixture data for generating sites and is now the **address
 * lookup itself** — the thing that answers "which zone is this, and where is
 * it?" once a job carries its own address instead of pointing at a site record
 * (Matt, 0:29). Adding a suburb here makes it bookable; removing one makes every
 * job in it unpriceable. It is data, not decoration.
 *
 * Replaced wholesale by Google Places when a billed key exists — see
 * `PlaceSchema`. The shape is already the shape that returns.
 */
export const SUBURBS: ReadonlyArray<{
  suburb: string;
  postcode: string;
  zone: Zone;
  lat: number;
  lng: number;
}> = [
  { suburb: 'Oran Park', postcode: '2570', zone: 'sydney', lat: -34.0086, lng: 150.7407 },
  { suburb: 'Catherine Field', postcode: '2557', zone: 'sydney', lat: -34.0294, lng: 150.7717 },
  { suburb: 'Gledswood Hills', postcode: '2557', zone: 'sydney', lat: -34.0055, lng: 150.7817 },
  { suburb: 'Austral', postcode: '2179', zone: 'sydney', lat: -33.9271, lng: 150.8125 },
  { suburb: 'Leppington', postcode: '2179', zone: 'sydney', lat: -33.9636, lng: 150.8055 },
  { suburb: 'Box Hill', postcode: '2765', zone: 'sydney', lat: -33.6449, lng: 150.8757 },
  { suburb: 'Marsden Park', postcode: '2765', zone: 'sydney', lat: -33.7042, lng: 150.8347 },
  { suburb: 'Castle Hill', postcode: '2154', zone: 'sydney', lat: -33.732, lng: 151.005 },
  { suburb: 'Kellyville', postcode: '2155', zone: 'sydney', lat: -33.7118, lng: 150.9542 },
  { suburb: 'Camden', postcode: '2570', zone: 'sydney', lat: -34.0548, lng: 150.6957 },
  { suburb: 'Figtree', postcode: '2525', zone: 'wollongong', lat: -34.4361, lng: 150.8697 },
  { suburb: 'Shell Cove', postcode: '2529', zone: 'wollongong', lat: -34.5906, lng: 150.8583 },
  { suburb: 'Dapto', postcode: '2530', zone: 'wollongong', lat: -34.5019, lng: 150.7936 },
  { suburb: 'Fletcher', postcode: '2287', zone: 'newcastle', lat: -32.8836, lng: 151.6472 },
  { suburb: 'Thornton', postcode: '2322', zone: 'newcastle', lat: -32.7873, lng: 151.6339 },
  { suburb: 'Medowie', postcode: '2318', zone: 'newcastle', lat: -32.7444, lng: 151.8583 },
];

/**
 * A pin for an address typed by hand.
 *
 * ── Why a lookup table and not a geocoder ─────────────────────────────────
 * Because M3.3 says every site carries a *confirmed* pin, and nothing typed on
 * a form is confirmed. The real create flow will geocode and then ask someone to
 * drag the marker; until that exists, a site registered by hand gets the centre
 * of its suburb, which is close enough for the board to draw it and honest about
 * being approximate. Guessing a precise-looking coordinate would be worse — a
 * driver would follow it.
 *
 * Falls back to the first suburb in the site's zone when the suburb is one the
 * table has never seen, which for a greenfield estate is the common case.
 */
/**
 * Turn a chosen place id back into the place.
 *
 * ── Why the id and not the values ─────────────────────────────────────────
 * The booking form sends `placeId`, and the service resolves it here. Sending
 * the zone and the coordinate from the browser would let a caller nominate its
 * own — and the zone decides the price (M6.3). A job priced at Sydney rates
 * because someone edited a hidden field is not a bug anyone would notice until
 * the month-end reconciliation.
 *
 * Returns null for an unknown id rather than a fallback: PlastaGo services three
 * zones, and "we do not go there" is a real answer that the form has to be able
 * to give.
 */
export function resolvePlace(placeId: string): Place | null {
  const slug = placeId.trim().toLowerCase();
  const match = SUBURBS.find(
    (place) => place.suburb.toLowerCase().replace(/[^a-z0-9]+/g, '-') === slug,
  );
  if (!match) return null;

  return {
    id: slug,
    suburb: match.suburb,
    postcode: match.postcode,
    state: 'NSW',
    zone: match.zone,
    latitude: match.lat,
    longitude: match.lng,
    label: `${match.suburb} NSW ${match.postcode}`,
  };
}

export function geocodeSuburb(
  suburb: string,
  zone: Zone,
): { latitude: number; longitude: number } {
  const match =
    SUBURBS.find((place) => place.suburb.toLowerCase() === suburb.trim().toLowerCase()) ??
    SUBURBS.find((place) => place.zone === zone);

  return {
    latitude: Number((match?.lat ?? -33.8688).toFixed(6)),
    longitude: Number((match?.lng ?? 151.2093).toFixed(6)),
  };
}

const STREETS = [
  'Allambie Circuit',
  'Pilaster Street',
  'Horologium Road',
  'Britannia Road',
  'Peppercorn Drive',
  'Silverdale Avenue',
  'Wattlebird Grove',
  'Ironbark Parade',
  'Kurrajong Way',
  'Bellbird Close',
];

/**
 * Sites, generated per account.
 *
 * `lotNumber` is populated for most of them because street numbers do not exist
 * yet in a half-built estate — the real booking form's placeholder literally
 * pleads "Please use both Lot and Street Number where possible".
 */
/**
 * A generated address, as the job fixtures consume it.
 *
 * ⚠️ Not a `Site` — there is no such record any more (Matt, 0:29). This is a
 * generator that produces plausible greenfield addresses, and every field it
 * emits is copied ONTO the job. Nothing links back to it, and nothing may: the
 * whole point is that a job's address is frozen at creation.
 */
export interface AddressFixture {
  id: string;
  accountId: string;
  builderName: string;
  name: string;
  lotNumber: string | null;
  addressLine: string;
  suburb: string;
  postcode: string;
  zone: Zone;
  latitude: number;
  longitude: number;
  accessNotes: string;
  gateHours: string | null;
  inductionRequired: boolean;
  craneAvailable: boolean;
  siteContactName: string | null;
  siteContactMobile: string | null;
  siteContactEmail: string | null;
  jobCount: number;
  status: AccountStatus;
}

export function buildSites(): AddressFixture[] {
  const rng = createRng(20260825);
  const sites: AddressFixture[] = [];
  let index = 0;

  for (const account of ACCOUNTS) {
    const count = account.status === 'inactive' ? 1 : intBetween(rng, 2, 6);

    for (let n = 0; n < count; n += 1) {
      index += 1;
      const place = pick(rng, SUBURBS);
      const street = pick(rng, STREETS);
      const lot = intBetween(rng, 12, 3400);
      const streetNumber = intBetween(rng, 2, 98);
      const hasLot = rng() > 0.15;

      sites.push({
        id: objectId('st', index),
        accountId: account.id,
        builderName: pick(rng, account.builders),
        name: hasLot
          ? `Lot ${String(lot)} (#${String(streetNumber)}) ${street}`
          : `${String(streetNumber)} ${street}`,
        lotNumber: hasLot ? String(lot) : null,
        addressLine: `${String(streetNumber)} ${street}`,
        suburb: place.suburb,
        postcode: place.postcode,
        zone: place.zone,
        // Jitter inside the suburb so pins cluster rather than stack.
        latitude: Number((place.lat + (rng() - 0.5) * 0.018).toFixed(6)),
        longitude: Number((place.lng + (rng() - 0.5) * 0.018).toFixed(6)),
        accessNotes: pick(rng, [
          'Gate code 4417. Park on the verge, not the slab.',
          'Access via rear lane. Tight turn for the 34T.',
          'Crane window 7–11am only.',
          'Site shares access with two other lots — call ahead.',
          '',
        ]),
        gateHours: rng() > 0.5 ? '6:30am – 4:00pm' : null,
        inductionRequired: rng() > 0.7,
        craneAvailable: rng() > 0.35,
        siteContactName:
          rng() > 0.25 ? pick(rng, ['Dave', 'Sione', 'Brett', 'Ali', 'Kelly']) : null,
        siteContactMobile:
          rng() > 0.25 ? `04${String(intBetween(rng, 10000000, 99999999))}`.slice(0, 10) : null,
        /*
         * The builder's own supervisor, on roughly half the sites.
         *
         * Deliberately sparser than the mobile, and on a DIFFERENT domain from
         * the account: this is the case Matt described where iPlast's photos
         * have to reach Clarendon's supervisor (14:16), and a fixture where the
         * address always matches the account would never show it.
         */
        siteContactEmail:
          rng() > 0.5
            ? `site${String(intBetween(rng, 10, 99))}@${pick(rng, ['clarendonhomes', 'domaine', 'allamhomes'])}.com.au`
            : null,
        jobCount: intBetween(rng, 1, 22),
        status: account.status,
      });
    }
  }

  return sites;
}

export interface DriverFixture {
  id: string;
  name: string;
  mobile: string;
  vehicleRego: string | null;
  vehicleLabel: string | null;
  dailyJobCapacity: number;
  active: boolean;
  nextComplianceExpiry: string | null;
}

/**
 * Two active drivers, plus historical ones so the driver filter has a tail.
 * That is the real shape: 2 active, ~7 historical.
 */
export const DRIVERS: readonly DriverFixture[] = [
  {
    id: objectId('dr', 1),
    name: 'Troy Holm',
    mobile: '0455112233',
    vehicleRego: 'BQ44JT',
    vehicleLabel: 'Isuzu FVZ crane truck',
    dailyJobCapacity: 8,
    active: true,
    nextComplianceExpiry: '2026-10-02',
  },
  {
    id: objectId('dr', 2),
    name: 'James Whiteley',
    mobile: '0466334455',
    vehicleRego: 'CX18PL',
    vehicleLabel: 'Hino 500 crane truck',
    dailyJobCapacity: 7,
    active: true,
    nextComplianceExpiry: '2026-09-14',
  },
  {
    id: objectId('dr', 3),
    name: 'Nick Palmer',
    mobile: '0402556677',
    vehicleRego: 'DL92RS',
    vehicleLabel: '34T hooklift',
    dailyJobCapacity: 6,
    active: false,
    nextComplianceExpiry: null,
  },
  {
    id: objectId('dr', 4),
    name: 'Sam Okafor',
    mobile: '0419887766',
    vehicleRego: null,
    vehicleLabel: null,
    dailyJobCapacity: 6,
    active: false,
    nextComplianceExpiry: null,
  },
];

export const ACTIVE_DRIVERS = DRIVERS.filter((driver) => driver.active);
