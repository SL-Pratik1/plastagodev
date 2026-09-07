import {
  DriverJobSchema,
  RunSheetDaySchema,
  type DriverJob,
  type DriverPhoto,
  type JobStatus,
  type RequiredPhoto,
  type RunSheetDay,
  type RunStop,
  type SraUploadState,
} from '@plastago/shared';

/**
 * The demo driver's data.
 *
 * ⚠️ FIXTURES. Deliberately separate from the web app's fixtures rather than
 * shared, and that is not laziness: the two apps talk to the same API but hold
 * their own local data, and the driver's copy is a *local database seeded by
 * sync* (M4.12), not a view over the office's tables. Sharing a fixture module
 * would model a relationship that does not exist and cannot exist offline.
 *
 * ── Why this is scenarios and not one run ─────────────────────────────────
 * The states a driver moves through are mutually exclusive. The pre-start prompt
 * only exists while the pre-start is *not* done; the tip-off reconciliation only
 * has anything to reconcile once jobs are *finished*; "nothing else to do today"
 * only appears once the tip-off *is* recorded. One fixture can show any one of
 * those and never the others — which is exactly the gap that leaves a second
 * implementation (§6A.4 — the Flutter app) guessing at half the screens.
 *
 * So the day is authored once, and a scenario is a *transform* over it:
 *
 *   /?scenario=fresh        start of day — pre-start outstanding, nothing done
 *   /?scenario=mid-run      DEFAULT — every job status live at once
 *   /?scenario=end-of-run   all stops finished, tip-off outstanding
 *   /?scenario=finished     tip-off recorded, run closed out
 *   /?scenario=empty        no stops allocated, no vehicle
 *
 * The choice sticks in `localStorage` so client-side navigation keeps it.
 *
 * ── The job list is a coverage matrix, not a plausible day ────────────────
 * Twelve stops, where a real day is ~7. Each one carries a combination that some
 * screen or branch turns on — the awkward ones deliberately, because those are
 * the branches a second implementation gets wrong. `COVERAGE` below records what
 * each stop is for, and it is exported so the handover document cannot drift
 * from the data.
 */

/* ── Time ─────────────────────────────────────────────────────────────────── */

const TODAY = new Date();
const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/** A time on the run's date, as an ISO instant. */
const at = (hour: number, minute: number) => {
  const stamp = new Date(TODAY);
  stamp.setHours(hour, minute, 0, 0);
  return stamp.toISOString();
};

export const RUN_DATE = isoDate(TODAY);

/* ── The photo protocol (M4.5) ────────────────────────────────────────────── */

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

/** The four that block completion. The fifth is conditional; see `photo-rules.ts`. */
const REQUIRED_SLOTS = STANDARD_REQUIRED_PHOTOS.filter((slot) => slot.required).map(
  (slot) => slot.key,
);

/* ── Seed shapes ──────────────────────────────────────────────────────────── */

interface PhotoSeed {
  /** A key from `STANDARD_REQUIRED_PHOTOS`, or `null` for an extra photo. */
  slot: string | null;
  caption?: string;
  /** Minutes past 07:00 the shot was taken. Keeps the ordering readable. */
  minute: number;
  /** `false` models a photo still sitting in the upload queue (M4.12). */
  uploaded: boolean;
  /** `true` models a shot taken with location denied or no fix — both are legal. */
  noFix?: boolean;
}

interface RiskAssessmentSeed {
  completedAt: string;
  safeToProceed: boolean;
  uploadState: SraUploadState;
  /** `null` models the record existing before the PDF has been generated. */
  document: { generatedAt: string | null; pageCount: number; sizeBytes: number } | null;
}

interface StopSeed {
  jobNumber: number;
  /** What this stop is in the fixture set for. Surfaced in the handover doc. */
  covers: string;
  status: JobStatus;
  accountName: string;
  builderName: string;
  siteName: string;
  lotNumber: string | null;
  addressLine: string;
  suburb: string;
  postcode: string;
  zone: RunStop['zone'];
  latitude: number;
  longitude: number;
  expectedAreaM2: number;
  bagCount: number;
  loadType: RunStop['loadType'];
  capturesWeight: boolean;
  poNumber: string | null;
  urgent: boolean;
  riskAssessmentRequired: boolean;
  accessNotes: string;
  gateHours: string | null;
  inductionRequired: boolean;
  craneAvailable: boolean;
  siteContactName: string | null;
  siteContactMobile: string | null;
  notes: string;
  arrivedAt?: string;
  completedAt?: string;
  capturedAreaM2?: number;
  craneScaleKg?: number;
  weightsRecordedAt?: string;
  hasQueuedActions?: boolean;
  photos?: readonly PhotoSeed[];
  riskAssessment?: RiskAssessmentSeed;
  messages?: readonly { body: string; author: string; at: string; fromDriver: boolean }[];
}

/* ── The twelve stops ─────────────────────────────────────────────────────── */

/** Every required slot taken and uploaded, plus the conditional one and extras. */
const FULL_PHOTO_SET: readonly PhotoSeed[] = [
  { slot: 'front-of-site', minute: 12, uploaded: true },
  { slot: 'pile-before', minute: 14, uploaded: true },
  { slot: 'pile-after', minute: 33, uploaded: true },
  { slot: 'site-closed', minute: 41, uploaded: true },
  { slot: 'cars-on-site', minute: 42, uploaded: true },
  { slot: null, caption: 'Extra photo', minute: 43, uploaded: true },
  { slot: null, caption: 'Extra photo', minute: 44, uploaded: true },
];

/** The four blocking slots only — no conditional shot, no extras. */
const REQUIRED_PHOTO_SET: readonly PhotoSeed[] = [
  { slot: 'front-of-site', minute: 10, uploaded: true },
  { slot: 'pile-before', minute: 12, uploaded: true },
  { slot: 'pile-after', minute: 28, uploaded: true },
  { slot: 'site-closed', minute: 35, uploaded: true },
];

const SEEDS: readonly StopSeed[] = [
  {
    jobNumber: 61521,
    covers:
      'The finished job. admin-complete · every photo slot filled including the conditional one · crane weight recorded · nothing left to do on the detail screen.',
    status: 'admin-complete',
    accountName: 'Clarendon Homes',
    builderName: 'Clarendon Homes',
    siteName: 'Lot 328 (#69) Horologium Road',
    lotNumber: '328',
    addressLine: '69 Horologium Road',
    suburb: 'Austral',
    postcode: '2179',
    zone: 'sydney',
    latitude: -33.9271,
    longitude: 150.8102,
    expectedAreaM2: 620,
    bagCount: 3,
    loadType: 'bagged',
    capturesWeight: true,
    poNumber: 'REF-40218',
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
    weightsRecordedAt: at(7, 40),
    photos: FULL_PHOTO_SET,
  },
  {
    jobNumber: 61528,
    covers:
      'The blocked job. arrived, but the risk assessment is required and undone, weights are unrecorded and 3 of 4 photos are missing — so "Complete job" is disabled and lists all three blockers. Also carries an unread message from the office and a queued (not yet uploaded) photo.',
    status: 'arrived',
    accountName: 'Domaine Homes',
    builderName: 'Domaine Homes',
    siteName: 'Lot 1097 (#46) Allambie Circuit',
    lotNumber: '1097',
    addressLine: '46 Allambie Circuit',
    suburb: 'Catherine Field',
    postcode: '2557',
    zone: 'sydney',
    latitude: -34.0142,
    longitude: 150.7719,
    expectedAreaM2: 880,
    bagCount: 4,
    loadType: 'bagged',
    capturesWeight: true,
    poNumber: 'REF-51882',
    urgent: false,
    riskAssessmentRequired: true,
    accessNotes: 'Second entrance off the roundabout — main gate is fenced off.',
    gateHours: '7:00am – 3:30pm',
    inductionRequired: true,
    craneAvailable: true,
    siteContactName: 'Sione',
    siteContactMobile: '0413556677',
    notes: 'Domaine require the risk assessment on their portal before you start.',
    arrivedAt: at(8, 26),
    hasQueuedActions: true,
    photos: [{ slot: 'front-of-site', minute: 90, uploaded: false }],
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
    covers:
      'The sparse job. Urgent · m²-only account (no kg field on the weights screen) · hand load · no site contact (the Call button falls back to the office) · no access notes · no gate hours · no customer reference. In transit, so the exception buttons are already reachable.',
    status: 'in-transit',
    accountName: 'iPlasta Pty Ltd',
    builderName: 'GJ Gardner',
    siteName: 'Lot 3141 Pilaster Street',
    lotNumber: '3141',
    addressLine: '12 Pilaster Street',
    suburb: 'Box Hill',
    postcode: '2765',
    zone: 'sydney',
    latitude: -33.6421,
    longitude: 150.8934,
    expectedAreaM2: 1240,
    bagCount: 0,
    loadType: 'hand-load',
    capturesWeight: false,
    poNumber: null,
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
    covers:
      'The ready-to-complete job. arrived with all four required photos taken, weights recorded and no risk form needed — the one state where "Complete job" is enabled. Bagged but on an m²-only account, which is the case where the weights screen shows the "records square metres only" notice with the kg field absent.',
    status: 'arrived',
    accountName: 'Fornari Group',
    builderName: 'Fowler Homes',
    siteName: 'Lot 77 Britannia Road',
    lotNumber: '77',
    addressLine: '8 Britannia Road',
    suburb: 'Leppington',
    postcode: '2179',
    zone: 'sydney',
    latitude: -33.9803,
    longitude: 150.8064,
    expectedAreaM2: 540,
    bagCount: 2,
    loadType: 'bagged',
    capturesWeight: false,
    poNumber: 'REF-33901',
    urgent: false,
    riskAssessmentRequired: false,
    accessNotes: 'Site shares access with two other lots — call ahead.',
    gateHours: null,
    inductionRequired: false,
    craneAvailable: true,
    siteContactName: 'Ali',
    siteContactMobile: '0432110987',
    notes: '',
    arrivedAt: at(9, 5),
    capturedAreaM2: 540,
    weightsRecordedAt: at(9, 22),
    hasQueuedActions: true,
    photos: REQUIRED_PHOTO_SET,
  },
  {
    jobNumber: 61537,
    covers:
      "The hand load that the customer does record weight for — hand load wins, so there is still no kg field, and this job's weight is imputed at tip-off. Completed, with a photo whose GPS fix is missing.",
    status: 'completed',
    accountName: 'Wisdom Properties Group',
    builderName: 'Wisdom Homes',
    siteName: 'Lot 941 (#44) Silverdale Avenue',
    lotNumber: '941',
    addressLine: '44 Silverdale Avenue',
    suburb: 'Gregory Hills',
    postcode: '2557',
    zone: 'sydney',
    latitude: -34.0021,
    longitude: 150.7852,
    expectedAreaM2: 1460,
    bagCount: 0,
    loadType: 'hand-load',
    capturesWeight: true,
    poNumber: 'REF-77120',
    urgent: false,
    riskAssessmentRequired: false,
    accessNotes: 'Crane window 7–11am only. Ring the supervisor 20 minutes out.',
    gateHours: '6:00am – 6:00pm',
    inductionRequired: false,
    craneAvailable: false,
    siteContactName: 'Brett',
    siteContactMobile: '0455901223',
    notes: 'Hand load — big one. Allow extra time.',
    arrivedAt: at(9, 58),
    completedAt: at(10, 51),
    capturedAreaM2: 1460,
    weightsRecordedAt: at(10, 44),
    hasQueuedActions: true,
    photos: [
      { slot: 'front-of-site', minute: 178, uploaded: true },
      { slot: 'pile-before', minute: 180, uploaded: true },
      { slot: 'pile-after', minute: 225, uploaded: false, noFix: true },
      { slot: 'site-closed', minute: 228, uploaded: false },
    ],
  },
  {
    jobNumber: 61539,
    covers:
      'The futile job (M4.6). Wollongong zone. Detail screen shows the destructive "could not collect" banner and no actions; the run sheet files it under Finished.',
    status: 'futile',
    accountName: 'Lakeside Interiors',
    builderName: 'King Homes',
    siteName: '22 Bellbird Close',
    lotNumber: null,
    addressLine: '22 Bellbird Close',
    suburb: 'Figtree',
    postcode: '2525',
    zone: 'wollongong',
    latitude: -34.4285,
    longitude: 150.8452,
    expectedAreaM2: 380,
    bagCount: 2,
    loadType: 'bagged',
    capturesWeight: true,
    poNumber: null,
    urgent: false,
    riskAssessmentRequired: false,
    accessNotes: 'Access via rear lane. Tight turn for the 34T.',
    gateHours: null,
    inductionRequired: false,
    craneAvailable: true,
    siteContactName: 'Kelly',
    siteContactMobile: '0448223344',
    notes: '',
    arrivedAt: at(11, 20),
    hasQueuedActions: true,
    photos: [
      { slot: null, caption: 'Could not collect — evidence', minute: 262, uploaded: true },
      { slot: null, caption: 'Could not collect — evidence', minute: 263, uploaded: false },
    ],
    messages: [
      {
        body: 'Gate padlocked, nobody answering. Rang Kelly twice.',
        author: 'Troy Holm',
        at: at(11, 26),
        fromDriver: true,
      },
      {
        body: 'Noted — leave it, we will rebook. Charge stands.',
        author: 'Dean Kelly',
        at: at(11, 31),
        fromDriver: false,
      },
    ],
  },
  {
    jobNumber: 61541,
    covers:
      'The cancelled job. Newcastle zone. Cancelled by the office after the run was allocated — appears under Finished with no actions at all.',
    status: 'cancelled',
    accountName: 'Southgate Plaster',
    builderName: 'Southgate Plaster',
    siteName: 'Lot 12 Rutherford Rise',
    lotNumber: '12',
    addressLine: '6 Rutherford Rise',
    suburb: 'Thornton',
    postcode: '2322',
    zone: 'newcastle',
    latitude: -32.7801,
    longitude: 151.6321,
    expectedAreaM2: 700,
    bagCount: 0,
    loadType: 'hand-load',
    capturesWeight: false,
    poNumber: 'REF-19004',
    urgent: false,
    riskAssessmentRequired: false,
    accessNotes: '',
    gateHours: null,
    inductionRequired: false,
    craneAvailable: false,
    siteContactName: 'Grant',
    siteContactMobile: '0417889900',
    notes: 'Cancelled by the builder at 07:05 — board went out with their own truck.',
    messages: [
      {
        body: 'Builder cancelled this one, skip it.',
        author: 'Dean Kelly',
        at: at(7, 6),
        fromDriver: false,
      },
    ],
  },
  {
    jobNumber: 61544,
    covers:
      'Risk assessment done and on the builder\'s portal — uploadState "uploaded". The document card reads "Already on Metricon\'s portal" with an outline Share button.',
    status: 'completed',
    accountName: 'Metricon Homes',
    builderName: 'Metricon Homes',
    siteName: 'Lot 204 (#18) Cobbitty Road',
    lotNumber: '204',
    addressLine: '18 Cobbitty Road',
    suburb: 'Oran Park',
    postcode: '2570',
    zone: 'sydney',
    latitude: -34.0053,
    longitude: 150.7402,
    expectedAreaM2: 960,
    bagCount: 5,
    loadType: 'bagged',
    capturesWeight: true,
    poNumber: 'MET-88104',
    urgent: false,
    riskAssessmentRequired: true,
    accessNotes: 'Sign in at the site office. Hard hat and glasses from the gate in.',
    gateHours: '7:00am – 5:00pm',
    inductionRequired: true,
    craneAvailable: true,
    siteContactName: 'Priya',
    siteContactMobile: '0421334455',
    notes: '',
    arrivedAt: at(12, 14),
    completedAt: at(13, 2),
    capturedAreaM2: 955,
    craneScaleKg: 340,
    weightsRecordedAt: at(12, 55),
    photos: REQUIRED_PHOTO_SET,
    riskAssessment: {
      completedAt: at(12, 18),
      safeToProceed: true,
      uploadState: 'uploaded',
      document: { generatedAt: at(12, 19), pageCount: 2, sizeBytes: 162_400 },
    },
  },
  {
    jobNumber: 61547,
    covers:
      'Risk assessment done but the portal upload failed — uploadState "failed". The document card turns the Share button primary and tells the driver to upload their own copy by hand.',
    status: 'arrived',
    accountName: 'Wisdom Properties Group',
    builderName: 'Wisdom Homes',
    siteName: 'Lot 1145 Elara Boulevard',
    lotNumber: '1145',
    addressLine: '31 Elara Boulevard',
    suburb: 'Marsden Park',
    postcode: '2765',
    zone: 'sydney',
    latitude: -33.7031,
    longitude: 150.8438,
    expectedAreaM2: 1120,
    bagCount: 6,
    loadType: 'bagged',
    capturesWeight: true,
    poNumber: 'REF-77455',
    urgent: false,
    riskAssessmentRequired: true,
    accessNotes: 'Estate is still unsealed past the roundabout — low range in the wet.',
    gateHours: '6:30am – 5:30pm',
    inductionRequired: false,
    craneAvailable: true,
    siteContactName: 'Nathan',
    siteContactMobile: '0407112899',
    notes: '',
    arrivedAt: at(13, 40),
    hasQueuedActions: true,
    photos: [
      { slot: 'front-of-site', minute: 402, uploaded: true },
      { slot: 'pile-before', minute: 404, uploaded: false },
    ],
    riskAssessment: {
      completedAt: at(13, 44),
      safeToProceed: true,
      uploadState: 'failed',
      document: { generatedAt: at(13, 45), pageCount: 2, sizeBytes: 151_900 },
    },
  },
  {
    jobNumber: 61550,
    covers:
      'The unsafe site, and a voluntary assessment. The builder does not require a form, the driver filled one in anyway (safeToProceed: false), and the PDF has not been generated yet — generatedAt null renders "Preparing the PDF…" with Share disabled. uploadState "queued".',
    status: 'arrived',
    accountName: 'Rawson Homes',
    builderName: 'Rawson Homes',
    siteName: 'Lot 61 (#9) Tallawong Street',
    lotNumber: '61',
    addressLine: '9 Tallawong Street',
    suburb: 'Riverstone',
    postcode: '2765',
    zone: 'sydney',
    latitude: -33.6786,
    longitude: 150.8591,
    expectedAreaM2: 480,
    bagCount: 2,
    loadType: 'bagged',
    capturesWeight: true,
    poNumber: null,
    urgent: false,
    riskAssessmentRequired: false,
    accessNotes: 'Powerlines run the length of the frontage.',
    gateHours: null,
    inductionRequired: false,
    craneAvailable: true,
    siteContactName: 'Site office',
    siteContactMobile: '0298385500',
    notes: 'Driver stopped work — powerlines directly over the only crane position.',
    arrivedAt: at(14, 22),
    hasQueuedActions: true,
    photos: [{ slot: 'front-of-site', minute: 444, uploaded: false, noFix: true }],
    riskAssessment: {
      completedAt: at(14, 26),
      safeToProceed: false,
      uploadState: 'queued',
      document: { generatedAt: null, pageCount: 2, sizeBytes: 0 },
    },
  },
  {
    jobNumber: 61553,
    covers:
      'Status "booked" — allocated to the day but not yet assigned to the driver, so it still shows in the run with no arrival. Also the long office thread (three messages, both directions) and an assessment recorded with uploadState "pending" and no document, which is the case where the document card does not render at all.',
    status: 'booked',
    accountName: 'Eden Brae Homes',
    builderName: 'Eden Brae Homes',
    siteName: 'Lot 4402 Hezlett Road',
    lotNumber: '4402',
    addressLine: '77 Hezlett Road',
    suburb: 'Box Hill',
    postcode: '2765',
    zone: 'sydney',
    latitude: -33.6395,
    longitude: 150.8802,
    expectedAreaM2: 815,
    bagCount: 3,
    loadType: 'bagged',
    capturesWeight: true,
    poNumber: 'EB-2291',
    urgent: true,
    riskAssessmentRequired: true,
    accessNotes: 'Shared driveway with lot 4403. Do not block it.',
    gateHours: '7:00am – 4:00pm',
    inductionRequired: false,
    craneAvailable: true,
    siteContactName: 'Marko',
    siteContactMobile: '0433887766',
    notes: 'Squeezed onto the run this morning — office to confirm before you head over.',
    riskAssessment: {
      completedAt: at(6, 55),
      safeToProceed: true,
      uploadState: 'pending',
      document: null,
    },
    messages: [
      {
        body: 'Can you fit this one in after Marsden Park? Builder is chasing.',
        author: 'Dean Kelly',
        at: at(6, 52),
        fromDriver: false,
      },
      {
        body: 'Should be right if the Riverstone one is quick.',
        author: 'Troy Holm',
        at: at(7, 1),
        fromDriver: true,
      },
      {
        body: 'Thanks. I will let them know it is today.',
        author: 'Dean Kelly',
        at: at(7, 3),
        fromDriver: false,
      },
    ],
  },
  {
    jobNumber: 61556,
    covers:
      'The empty-data job. No builder name (renders "—"), no lot number, no reference, no notes, no access notes, no gate hours, no site contact, no crane, and 0 m² booked — the office data gap that the tip-off split has to survive.',
    status: 'assigned',
    accountName: 'Southgate Plaster',
    builderName: '',
    siteName: '14 Kelvin Park Drive',
    lotNumber: null,
    addressLine: '14 Kelvin Park Drive',
    suburb: 'Bringelly',
    postcode: '2556',
    zone: 'sydney',
    latitude: -33.9382,
    longitude: 150.7412,
    expectedAreaM2: 0,
    bagCount: 0,
    loadType: 'hand-load',
    capturesWeight: true,
    poNumber: null,
    urgent: false,
    riskAssessmentRequired: false,
    accessNotes: '',
    gateHours: null,
    inductionRequired: false,
    craneAvailable: false,
    siteContactName: null,
    siteContactMobile: null,
    notes: '',
  },
];

/** What each stop is in the fixture set for. Consumed by the handover document. */
export const COVERAGE: readonly { jobNumber: number; status: JobStatus; covers: string }[] =
  SEEDS.map((seed) => ({ jobNumber: seed.jobNumber, status: seed.status, covers: seed.covers }));

/* ── Ids ──────────────────────────────────────────────────────────────────── */

/** 24-hex ids, so fixtures satisfy `ObjectIdSchema` like everywhere else. */
function objectId(prefix: string, index: number): string {
  const head = prefix.padEnd(6, '0').slice(0, 6);
  const hex = [...head].map((character) => (character.charCodeAt(0) % 16).toString(16)).join('');
  return `${hex}${index.toString(16).padStart(18, '0')}`;
}

/* ── Building one day ─────────────────────────────────────────────────────── */

/**
 * Which run each stop belongs to.
 *
 * Two runs, because that is a normal day: *"he had three jobs down South Coast,
 * he went and did that run and then tipped off"*, then the next one (Matt,
 * 40:03). Split on zone rather than by listing every suburb, so a new seed lands
 * on a sensible run without anyone having to remember to add it here.
 */
const RUN_PLAN = [
  { runId: objectId('drun', 1), runName: 'South West run 1', sequenceForDay: 1 },
  { runId: objectId('drun', 2), runName: 'South Coast run 2', sequenceForDay: 2 },
] as const;

/** Wollongong and Newcastle ride together on the long afternoon trip. */
function runIdFor(seed: StopSeed): string {
  const long = seed.postcode.startsWith('25') || seed.postcode.startsWith('23');
  return (long ? RUN_PLAN[1] : RUN_PLAN[0]).runId;
}

function buildJob(seed: StopSeed, index: number): DriverJob {
  const jobId = objectId('dj', seed.jobNumber);

  const photos: DriverPhoto[] = (seed.photos ?? []).map((photo, photoIndex) => {
    const label = STANDARD_REQUIRED_PHOTOS.find((slot) => slot.key === photo.slot)?.label;
    return {
      id: objectId('dp', seed.jobNumber * 100 + photoIndex),
      slot: photo.slot,
      caption: photo.caption ?? label ?? 'Extra photo',
      takenAt: at(7, photo.minute),
      latitude: photo.noFix === true ? null : seed.latitude,
      longitude: photo.noFix === true ? null : seed.longitude,
      uploaded: photo.uploaded,
    };
  });

  return {
    jobId,
    jobNumber: seed.jobNumber,
    sequence: index + 1,
    runId: runIdFor(seed),
    status: seed.status,
    accountName: seed.accountName,
    builderName: seed.builderName,
    siteName: seed.siteName,
    lotNumber: seed.lotNumber,
    addressLine: seed.addressLine,
    suburb: seed.suburb,
    postcode: seed.postcode,
    zone: seed.zone,
    latitude: seed.latitude,
    longitude: seed.longitude,
    expectedAreaM2: seed.expectedAreaM2,
    bagCount: seed.bagCount,
    loadType: seed.loadType,
    capturesWeight: seed.capturesWeight,
    poNumber: seed.poNumber,
    urgent: seed.urgent,
    riskAssessmentRequired: seed.riskAssessmentRequired,
    riskAssessmentDoneAt: seed.riskAssessment?.completedAt ?? null,
    photoCount: photos.length,
    hasQueuedActions: seed.hasQueuedActions ?? false,

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
    weightsRecordedAt: seed.weightsRecordedAt ?? null,
    riskAssessment:
      seed.riskAssessment === undefined
        ? null
        : {
            completedAt: seed.riskAssessment.completedAt,
            safeToProceed: seed.riskAssessment.safeToProceed,
            uploadState: seed.riskAssessment.uploadState,
            document:
              seed.riskAssessment.document === null
                ? null
                : {
                    documentId: objectId('sr', seed.jobNumber),
                    fileName: `SRA-${String(seed.jobNumber)}-${RUN_DATE}.pdf`,
                    generatedAt: seed.riskAssessment.document.generatedAt,
                    pageCount: seed.riskAssessment.document.pageCount,
                    sizeBytes: seed.riskAssessment.document.sizeBytes,
                  },
          },
    messages: (seed.messages ?? []).map((message, messageIndex) => ({
      id: objectId('dm', seed.jobNumber * 10 + messageIndex),
      ...message,
    })),
  };
}

/* ── Scenarios ────────────────────────────────────────────────────────────── */

export interface DriverScenario {
  key: string;
  label: string;
  /** One line, for the handover document and the screenshot index. */
  description: string;
  /** What a driver would be looking at, and which screens this scenario proves. */
  proves: string;
}

export const DRIVER_SCENARIOS: readonly DriverScenario[] = [
  {
    key: 'fresh',
    label: 'Start of day',
    description:
      'Pre-start outstanding, all twelve stops still ahead, nothing captured and nothing queued.',
    proves:
      'The pre-start blocker on the run sheet · the pre-start form itself · a job in its untouched "assigned" state · the empty photo checklist · the sync badge reading Synced.',
  },
  {
    key: 'mid-run',
    label: 'Mid-run (default)',
    description:
      'Pre-start done at 05:42. Every job status is live at once — booked, assigned, in-transit, arrived, completed, admin-complete, futile and cancelled.',
    proves:
      'Every job-status branch · the three arrived variants (blocked, ready, unsafe) · all four risk-assessment upload states · queued photos and queued actions · the office message thread.',
  },
  {
    key: 'end-of-run',
    label: 'End of run',
    description:
      'Every collectable stop finished, the futile and cancelled ones left as they were, tip-off not yet recorded.',
    proves:
      'The run sheet with nothing remaining and the "record the tip-off" prompt · the tip-off reconciliation table with both Actual and Estimated lines.',
  },
  {
    key: 'finished',
    label: 'Closed out',
    description: 'As end-of-run, plus the tip-off recorded at 16:20.',
    proves:
      'The run sheet "nothing else to do today" card · the tip-off screen in its already-recorded state.',
  },
  {
    key: 'empty',
    label: 'No run allocated',
    description: 'No stops, no vehicle on the day record, pre-start outstanding.',
    proves:
      'Every empty state: a run sheet with no stops · screens that fall back to "Your vehicle" where the rego is null · the tip-off with nothing to reconcile.',
  },
];

export type DriverScenarioKey = (typeof DRIVER_SCENARIOS)[number]['key'];

export const DEFAULT_SCENARIO = 'mid-run';

const SCENARIO_STORAGE_KEY = 'plastago.driver.scenario';

/**
 * Which scenario to seed.
 *
 * `?scenario=` wins and is remembered, so client-side navigation away from the
 * URL that set it does not silently drop back to the default mid-run day.
 */
export function activeScenario(): string {
  let requested: string | null = null;
  try {
    requested = new URLSearchParams(window.location.search).get('scenario');
    if (requested !== null) {
      window.localStorage.setItem(SCENARIO_STORAGE_KEY, requested);
    } else {
      requested = window.localStorage.getItem(SCENARIO_STORAGE_KEY);
    }
  } catch {
    // A locked-down browser gets the default day. Survivable.
  }

  return DRIVER_SCENARIOS.some((scenario) => scenario.key === requested) && requested !== null
    ? requested
    : DEFAULT_SCENARIO;
}

/** Everything a driver captures on site, cleared back to before the run started. */
function untouched(seed: StopSeed): StopSeed {
  const {
    arrivedAt: _arrivedAt,
    completedAt: _completedAt,
    capturedAreaM2: _area,
    craneScaleKg: _crane,
    weightsRecordedAt: _weights,
    photos: _photos,
    riskAssessment: _risk,
    hasQueuedActions: _queued,
    ...rest
  } = seed;
  return { ...rest, status: seed.status === 'booked' ? 'booked' : 'assigned' };
}

/** A stop taken all the way to completed, with everything a completion needs. */
function finish(seed: StopSeed): StopSeed {
  if (seed.status === 'futile' || seed.status === 'cancelled') return seed;

  const arrivedAt = seed.arrivedAt ?? at(7, 30 + (seed.jobNumber % 7) * 20);
  const weighable = seed.loadType === 'bagged' && seed.capturesWeight;

  return {
    ...seed,
    status: seed.status === 'admin-complete' ? 'admin-complete' : 'completed',
    arrivedAt,
    completedAt: seed.completedAt ?? at(8, 5 + (seed.jobNumber % 7) * 20),
    capturedAreaM2: seed.capturedAreaM2 ?? seed.expectedAreaM2,
    craneScaleKg: weighable ? (seed.craneScaleKg ?? 40 * (seed.bagCount || 1) + 60) : undefined,
    weightsRecordedAt: seed.weightsRecordedAt ?? at(8, (seed.jobNumber % 7) * 20),
    photos: seed.photos !== undefined && seed.photos.length >= 4 ? seed.photos : REQUIRED_PHOTO_SET,
    hasQueuedActions: seed.hasQueuedActions ?? false,
  };
}

interface BuiltDay {
  day: RunSheetDay;
  jobs: DriverJob[];
}

/**
 * Seed one scenario.
 *
 * Everything is validated against the published Zod contract before it leaves
 * this function. Fixtures that drift from the schema are the worst kind of
 * fixture — a second implementation (§6A.4) codegens from that schema, so a
 * field this app renders but the contract does not describe is a field the
 * Flutter app will never receive.
 */
export function buildRunSheet(scenario: string = activeScenario()): BuiltDay {
  const seeds: readonly StopSeed[] =
    scenario === 'fresh'
      ? SEEDS.map(untouched)
      : scenario === 'end-of-run' || scenario === 'finished'
        ? SEEDS.map(finish)
        : scenario === 'empty'
          ? []
          : SEEDS;

  const jobs = seeds.map(buildJob);
  const stops = jobs.map(toStop);

  const day: RunSheetDay = {
    date: RUN_DATE,
    driverId: objectId('dv', 1),
    driverName: DEMO_DRIVER.name,
    vehicleRego: scenario === 'empty' ? null : 'BQ44JT',
    vehicleLabel: scenario === 'empty' ? null : 'Hino 500 — 10T crane truck',
    /*
     * Only runs that actually have stops today. An empty run on the phone reads
     * as "something is missing" rather than "there was nothing in that area".
     */
    runs: RUN_PLAN.flatMap((plan) => {
      const runStops = stops.filter((stop) => stop.runId === plan.runId);
      if (runStops.length === 0) return [];

      return [
        {
          runId: plan.runId,
          runName: plan.runName,
          sequenceForDay: plan.sequenceForDay,
          suburbs: [...new Set(runStops.map((stop) => stop.suburb))],
          stops: runStops,
          // Each run carries its own docket — the 'finished' scenario is the one
          // where both have been weighed off.
          tipOffRecordedAt: scenario === 'finished' ? at(16, 20) : null,
          tipOffKg: scenario === 'finished' ? 2740 : null,
        },
      ];
    }),
    stops,
    // Outstanding on a fresh day, so the Chain of Responsibility prompt is the
    // first thing the driver sees — which is what a legal obligation should feel
    // like. Done on every other scenario, because a run is under way.
    preStartCompletedAt: scenario === 'fresh' || scenario === 'empty' ? null : at(5, 42),
  };

  return { day: RunSheetDaySchema.parse(day), jobs: DriverJobSchema.array().parse(jobs) };
}

/** Every scenario at once. Exists so the handover fixtures can be exported. */
export function buildAllScenarios(): Record<string, BuiltDay> {
  return Object.fromEntries(
    DRIVER_SCENARIOS.map((scenario) => [scenario.key, buildRunSheet(scenario.key)]),
  );
}

/** The list projection. A run sheet row needs no lookups to render. */
export function toStop(job: DriverJob): RunStop {
  return {
    jobId: job.jobId,
    jobNumber: job.jobNumber,
    sequence: job.sequence,
    runId: job.runId,
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
    poNumber: job.poNumber,
    urgent: job.urgent,
    riskAssessmentRequired: job.riskAssessmentRequired,
    riskAssessmentDoneAt: job.riskAssessmentDoneAt,
    photoCount: job.photos.length,
    hasQueuedActions: job.hasQueuedActions,
  };
}

/** Slots that block completion, exported so the handover doc cannot drift. */
export const BLOCKING_PHOTO_SLOTS: readonly string[] = REQUIRED_SLOTS;

/** The one demo driver identity. SMS-first (§9 A2); the code is always 123456. */
export const DEMO_DRIVER = {
  id: objectId('du', 1),
  name: 'Troy Holm',
  mobile: '0455112233',
  email: null,
  role: 'driver' as const,
  jobTitle: 'Driver',
  brandIds: ['plastago', 'easylift'],
  accountId: null,
} as const;

export const DEMO_OTP_CODE = '123456';
