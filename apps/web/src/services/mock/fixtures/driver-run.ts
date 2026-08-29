import type { DriverJob, DriverPhoto, RequiredPhoto, RunSheetDay, RunStop } from '@plastago/shared';
import { identitiesForRole } from './identities.js';

/**
 * The driver these fixtures belong to.
 *
 * Read off the sign-in identities rather than declared again here. The driver
 * app used to carry its own copy of Troy Holm because it was a separate build
 * with its own sign-in; inside one app that would be two records of one person,
 * and the run sheet would keep saying "Troy Holm" after the identity was
 * renamed — which is exactly the kind of drift a demo gets caught on.
 */
const DRIVER_IDENTITY = identitiesForRole('driver')[0];

/**
 * One day's run for the demo driver.
 *
 * ⚠️ FIXTURES. Deliberately separate from the web app's fixtures rather than
 * shared, and that is not laziness: the two apps talk to the same API but hold
 * their own local data, and the driver's copy is a *local database seeded by
 * sync* (M4.12), not a view over the office's tables. Sharing a fixture module
 * would model a relationship that does not exist and cannot exist offline.
 *
 * ── Shaped to exercise the awkward cases, not the happy path ───────────────
 * Seven stops, matching their ~7 jobs/day:
 *
 *  • **A mix of bagged and hand-load**, because M4.4's whole algorithm turns on
 *    the fact that hand-load jobs *cannot be weighed*. Three bagged and two
 *    hand-load among the collectable ones reproduces Matt's worked example.
 *  • **One m²-only account** (iPlasta), so the weights screen has to hide the kg
 *    field rather than show a zero.
 *  • **One job requiring a Site Risk Assessment** — some builders demand it
 *    before the driver may start (M4.8b).
 *  • **One already-completed stop**, so the run sheet shows progress rather than
 *    a uniform list.
 *  • **One urgent job** and **one with no site contact**, because "who do I ring"
 *    having no answer is a real situation on site.
 */

const TODAY = new Date();
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const at = (hour: number, minute: number) => {
  const stamp = new Date(TODAY);
  stamp.setHours(hour, minute, 0, 0);
  return stamp.toISOString();
};

export const RUN_DATE = isoDate(TODAY);

/**
 * M4.5 — their actual photo protocol, in order.
 *
 * The fifth is conditional: *"if it can't be closed — the cars still on site"*.
 * That one is pure commercial defence — they get blamed for leaving sites open,
 * so they photograph who was still there when they left.
 */
export const STANDARD_REQUIRED_PHOTOS: readonly RequiredPhoto[] = [
  {
    key: 'front-of-site',
    label: 'Front of the site',
    hint: 'Wide enough to identify the address — lot number or house number in frame.',
    required: true,
  },
  {
    key: 'pile-before',
    label: 'The pile before',
    hint: 'What you arrived to. This is the evidence if the load is disputed.',
    required: true,
  },
  {
    key: 'pile-after',
    label: 'The pile after',
    hint: 'Proof the area was cleared.',
    required: true,
  },
  {
    key: 'site-closed',
    label: 'The site closed',
    hint: 'Gates shut, fencing back as you found it.',
    required: true,
  },
  {
    key: 'cars-on-site',
    label: 'Cars still on site',
    hint: 'Only if the site could NOT be closed — shows who was still there when you left.',
    required: false,
  },
];

interface StopSeed {
  jobNumber: number;
  status: RunStop['status'];
  accountName: string;
  builderName: string;
  siteName: string;
  lotNumber: string | null;
  addressLine: string;
  suburb: string;
  postcode: string;
  latitude: number;
  longitude: number;
  expectedAreaM2: number;
  bagCount: number;
  loadType: RunStop['loadType'];
  capturesWeight: boolean;
  customerReference: string | null;
  urgent: boolean;
  riskAssessmentRequired: boolean;
  accessNotes: string;
  gateHours: string | null;
  inductionRequired: boolean;
  craneAvailable: boolean;
  siteContactName: string | null;
  siteContactMobile: string | null;
  notes: string;
  /** Set on the stop that is already done, so the run shows progress. */
  arrivedAt?: string;
  completedAt?: string;
  capturedAreaM2?: number;
  craneScaleKg?: number;
  photoCount?: number;
  messages?: readonly { body: string; author: string; at: string; fromDriver: boolean }[];
}

const SEEDS: readonly StopSeed[] = [
  {
    jobNumber: 61521,
    status: 'admin-complete',
    accountName: 'Clarendon Homes',
    builderName: 'Clarendon Homes',
    siteName: 'Lot 328 (#69) Horologium Road',
    lotNumber: '328',
    addressLine: '69 Horologium Road',
    suburb: 'Austral',
    postcode: '2179',
    latitude: -33.9271,
    longitude: 150.8102,
    expectedAreaM2: 620,
    bagCount: 3,
    loadType: 'bagged',
    capturesWeight: true,
    customerReference: 'REF-40218',
    urgent: false,
    riskAssessmentRequired: false,
    accessNotes: 'Gate code 4417. Park on the verge, not the slab.',
    gateHours: '6:30am – 4:00pm',
    inductionRequired: false,
    craneAvailable: true,
    siteContactName: 'Dave',
    siteContactMobile: '0466778899',
    notes: 'Board stacked behind the garage.',
    arrivedAt: at(7, 12),
    completedAt: at(7, 48),
    capturedAreaM2: 615,
    craneScaleKg: 200,
    photoCount: 11,
  },
  {
    jobNumber: 61528,
    status: 'acknowledged',
    accountName: 'Domaine Homes',
    builderName: 'Domaine Homes',
    siteName: 'Lot 1097 (#46) Allambie Circuit',
    lotNumber: '1097',
    addressLine: '46 Allambie Circuit',
    suburb: 'Catherine Field',
    postcode: '2557',
    latitude: -34.0142,
    longitude: 150.7719,
    expectedAreaM2: 880,
    bagCount: 4,
    loadType: 'bagged',
    capturesWeight: true,
    customerReference: 'REF-51882',
    urgent: false,
    riskAssessmentRequired: true,
    accessNotes: 'Second entrance off the roundabout — main gate is fenced off.',
    gateHours: '7:00am – 3:30pm',
    inductionRequired: true,
    craneAvailable: true,
    siteContactName: 'Sione',
    siteContactMobile: '0413556677',
    notes: 'Domaine require the risk assessment on their portal before you start.',
    messages: [
      {
        body: 'Gate code changed this morning — it is 2208 now, not 4417.',
        author: 'Dean Kelly',
        at: at(6, 40),
        fromDriver: false,
      },
    ],
  },
  {
    jobNumber: 61533,
    status: 'assigned',
    accountName: 'iPlasta Pty Ltd',
    builderName: 'GJ Gardner',
    siteName: 'Lot 3141 Pilaster Street',
    lotNumber: '3141',
    addressLine: '12 Pilaster Street',
    suburb: 'Box Hill',
    postcode: '2765',
    latitude: -33.6421,
    longitude: 150.8934,
    expectedAreaM2: 1240,
    bagCount: 0,
    loadType: 'hand-load',
    // iPlasta records m² only — the weights screen must not ask for kg here.
    capturesWeight: false,
    customerReference: null,
    urgent: true,
    riskAssessmentRequired: false,
    accessNotes: '',
    gateHours: null,
    inductionRequired: false,
    craneAvailable: false,
    siteContactName: null,
    siteContactMobile: null,
    notes: 'Marked urgent by the customer. No site contact on file.',
  },
  {
    jobNumber: 61535,
    status: 'assigned',
    accountName: 'Fornari Group',
    builderName: 'Fowler Homes',
    siteName: 'Lot 77 Britannia Road',
    lotNumber: '77',
    addressLine: '8 Britannia Road',
    suburb: 'Leppington',
    postcode: '2179',
    latitude: -33.9803,
    longitude: 150.8064,
    expectedAreaM2: 540,
    bagCount: 2,
    loadType: 'bagged',
    capturesWeight: false,
    customerReference: 'REF-33901',
    urgent: false,
    riskAssessmentRequired: false,
    accessNotes: 'Site shares access with two other lots — call ahead.',
    gateHours: null,
    inductionRequired: false,
    craneAvailable: true,
    siteContactName: 'Ali',
    siteContactMobile: '0432110987',
    notes: '',
  },
  {
    jobNumber: 61537,
    status: 'assigned',
    accountName: 'Wisdom Properties Group',
    builderName: 'Wisdom Homes',
    siteName: 'Lot 941 (#44) Silverdale Avenue',
    lotNumber: '941',
    addressLine: '44 Silverdale Avenue',
    suburb: 'Gregory Hills',
    postcode: '2557',
    latitude: -34.0021,
    longitude: 150.7852,
    expectedAreaM2: 1460,
    bagCount: 0,
    loadType: 'hand-load',
    capturesWeight: true,
    customerReference: 'REF-77120',
    urgent: false,
    riskAssessmentRequired: false,
    accessNotes: 'Crane window 7–11am only. Ring the supervisor 20 minutes out.',
    gateHours: '6:00am – 6:00pm',
    inductionRequired: false,
    craneAvailable: false,
    siteContactName: 'Brett',
    siteContactMobile: '0455901223',
    notes: 'Hand load — big one. Allow extra time.',
  },
  {
    jobNumber: 61539,
    status: 'assigned',
    accountName: 'Lakeside Interiors',
    builderName: 'King Homes',
    siteName: '22 Bellbird Close',
    lotNumber: null,
    addressLine: '22 Bellbird Close',
    suburb: 'Figtree',
    postcode: '2525',
    latitude: -34.4285,
    longitude: 150.8452,
    expectedAreaM2: 380,
    bagCount: 2,
    loadType: 'bagged',
    capturesWeight: true,
    customerReference: null,
    urgent: false,
    riskAssessmentRequired: false,
    accessNotes: 'Access via rear lane. Tight turn for the 34T.',
    gateHours: null,
    inductionRequired: false,
    craneAvailable: true,
    siteContactName: 'Kelly',
    siteContactMobile: '0448223344',
    notes: '',
  },
  {
    jobNumber: 61541,
    status: 'assigned',
    accountName: 'Southgate Plaster',
    builderName: 'Southgate Plaster',
    siteName: 'Lot 12 Rutherford Rise',
    lotNumber: '12',
    addressLine: '6 Rutherford Rise',
    suburb: 'Thornton',
    postcode: '2322',
    latitude: -32.7801,
    longitude: 151.6321,
    expectedAreaM2: 700,
    bagCount: 0,
    loadType: 'hand-load',
    capturesWeight: false,
    customerReference: 'REF-19004',
    urgent: false,
    riskAssessmentRequired: false,
    accessNotes: '',
    gateHours: null,
    inductionRequired: false,
    craneAvailable: false,
    siteContactName: 'Grant',
    siteContactMobile: '0417889900',
    notes: 'Newcastle zone — last stop before the tip.',
  },
];

/** 24-hex ids, so fixtures satisfy `ObjectIdSchema` like everywhere else. */
function objectId(prefix: string, index: number): string {
  const head = prefix.padEnd(6, '0').slice(0, 6);
  const hex = [...head].map((character) => (character.charCodeAt(0) % 16).toString(16)).join('');
  return `${hex}${index.toString(16).padStart(18, '0')}`;
}

export function buildRunSheet(): { day: RunSheetDay; jobs: DriverJob[] } {
  const jobs: DriverJob[] = SEEDS.map((seed, index) => {
    const jobId = objectId('dj', seed.jobNumber);

    const photos: DriverPhoto[] = Array.from({ length: seed.photoCount ?? 0 }, (_, photoIndex) => ({
      id: objectId('dp', seed.jobNumber * 100 + photoIndex),
      slot: STANDARD_REQUIRED_PHOTOS[photoIndex % 4]?.key ?? null,
      caption: STANDARD_REQUIRED_PHOTOS[photoIndex % 4]?.label ?? 'Extra photo',
      takenAt: at(7, 20 + photoIndex),
      latitude: seed.latitude,
      longitude: seed.longitude,
      uploaded: true,
    }));

    return {
      jobId,
      jobNumber: seed.jobNumber,
      sequence: index + 1,
      status: seed.status,
      accountName: seed.accountName,
      builderName: seed.builderName,
      siteName: seed.siteName,
      lotNumber: seed.lotNumber,
      addressLine: seed.addressLine,
      suburb: seed.suburb,
      postcode: seed.postcode,
      zone:
        seed.postcode.startsWith('23') || seed.postcode.startsWith('232')
          ? 'newcastle'
          : seed.postcode.startsWith('25') && seed.suburb === 'Figtree'
            ? 'wollongong'
            : 'sydney',
      latitude: seed.latitude,
      longitude: seed.longitude,
      expectedAreaM2: seed.expectedAreaM2,
      bagCount: seed.bagCount,
      loadType: seed.loadType,
      capturesWeight: seed.capturesWeight,
      customerReference: seed.customerReference,
      urgent: seed.urgent,
      riskAssessmentRequired: seed.riskAssessmentRequired,
      riskAssessmentDoneAt: null,
      photoCount: photos.length,
      hasQueuedActions: false,

      accessNotes: seed.accessNotes,
      gateHours: seed.gateHours,
      inductionRequired: seed.inductionRequired,
      craneAvailable: seed.craneAvailable,
      siteContactName: seed.siteContactName,
      siteContactMobile: seed.siteContactMobile,
      notes: seed.notes,
      readyDate: RUN_DATE,
      arrivedAt: seed.arrivedAt ?? null,
      completedAt: seed.completedAt ?? null,
      photos,
      requiredPhotos: [...STANDARD_REQUIRED_PHOTOS],
      capturedAreaM2: seed.capturedAreaM2 ?? null,
      craneScaleKg: seed.craneScaleKg ?? null,
      messages: (seed.messages ?? []).map((message, messageIndex) => ({
        id: objectId('dm', seed.jobNumber * 10 + messageIndex),
        ...message,
      })),
    };
  });

  const day: RunSheetDay = {
    date: RUN_DATE,
    driverId: objectId('dv', 1),
    driverName: DRIVER_IDENTITY?.name ?? 'Driver',
    vehicleRego: 'BQ44JT',
    vehicleLabel: 'Hino 500 — 10T crane truck',
    stops: jobs.map(toStop),
    // Not done yet, so the pre-start prompt is the first thing the driver sees —
    // which is what a Chain of Responsibility obligation should feel like.
    preStartCompletedAt: null,
    tipOffRecordedAt: null,
  };

  return { day, jobs };
}

/** The list projection. A run sheet row needs no lookups to render. */
export function toStop(job: DriverJob): RunStop {
  return {
    jobId: job.jobId,
    jobNumber: job.jobNumber,
    sequence: job.sequence,
    status: job.status,
    accountName: job.accountName,
    builderName: job.builderName,
    siteName: job.siteName,
    lotNumber: job.lotNumber,
    addressLine: job.addressLine,
    suburb: job.suburb,
    postcode: job.postcode,
    zone: job.zone,
    latitude: job.latitude,
    longitude: job.longitude,
    expectedAreaM2: job.expectedAreaM2,
    bagCount: job.bagCount,
    loadType: job.loadType,
    capturesWeight: job.capturesWeight,
    customerReference: job.customerReference,
    urgent: job.urgent,
    riskAssessmentRequired: job.riskAssessmentRequired,
    riskAssessmentDoneAt: job.riskAssessmentDoneAt,
    photoCount: job.photos.length,
    hasQueuedActions: job.hasQueuedActions,
  };
}

/**
 * The signed-in driver, for the places a fixture needs to attribute something to
 * them — a message they posted on a job thread, say.
 *
 * ⚠️ Re-exported, not re-declared. `identities.ts` is where every demo person
 * lives, including the OTP code they sign in with; a second definition here is
 * how the driver on the run sheet and the driver in the session end up being
 * two different people.
 */
export const DEMO_DRIVER = DRIVER_IDENTITY;
