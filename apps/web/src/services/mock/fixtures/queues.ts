import type { Lead, PoExtraction } from '@plastago/shared';
import { ACCOUNTS, createRng, objectId } from './reference';
import { JOBS } from './jobs';

/**
 * Fixtures for the two queues that are NOT derived from the job store.
 *
 * Futile review, service approvals and awaiting-PO are all projections of jobs —
 * deriving them is what stops the queue and the grid disagreeing. Leads and
 * inbound PO emails have no job to derive from: a lead exists precisely because
 * no account does yet, and a PO email arrives before anyone has matched it to
 * anything. So they are the only two with their own data.
 *
 * ⚠️ FIXTURES. Company names, email addresses and document text are invented in
 * the shape the scope describes — greenfield lots in the south-west corridor,
 * builders' AP departments emailing PDFs at 4:47pm — and none of it is a
 * business fact.
 */

function isoDaysAgo(days: number, hour = 9, minute = 0): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(hour, minute, 0, 0);
  return date.toISOString();
}

/* ── M5 · Journey A — leads ───────────────────────────────────────────────── */

interface LeadSeed {
  company: string;
  contact: string;
  email: string;
  mobile: string | null;
  status: Lead['status'];
  source: Lead['source'];
  zone: Lead['zone'];
  suburbs: string;
  volume: number | null;
  frequency: string;
  owner: string | null;
  heardAbout: string;
  ageDays: number;
  notes: readonly string[];
}

/**
 * Twelve leads, spread across the funnel.
 *
 * The volume is deliberate: A.3 puts new-company enquiries at **~1.6 a month**
 * (53 accounts in 38 months), so a queue holding hundreds would misrepresent the
 * business — and would make the "first CRM capability PlastaGo has ever had"
 * look like a system that needs a sales team. A handful, some of them old, is
 * the honest picture.
 */
const LEAD_SEEDS: readonly LeadSeed[] = [
  {
    company: 'Hunter Valley Interiors',
    contact: 'Rachel Doyle',
    email: 'rachel@hvinteriors.com.au',
    mobile: '0412887654',
    status: 'new',
    source: 'enquiry-form',
    zone: 'newcastle',
    suburbs: 'Maitland, Rutherford, Thornton',
    volume: 900,
    frequency: 'Weekly',
    owner: null,
    heardAbout: 'Google search',
    ageDays: 1,
    notes: [],
  },
  {
    company: 'Blacktown Plaster Co',
    contact: 'Deniz Kaya',
    email: 'deniz@blacktownplaster.com.au',
    mobile: '0433221100',
    status: 'new',
    source: 'enquiry-form',
    zone: 'sydney',
    suburbs: 'Marsden Park, Schofields, Box Hill',
    volume: 1400,
    frequency: 'Two or three times a week',
    owner: null,
    heardAbout: 'Recycling Near You',
    ageDays: 2,
    notes: [],
  },
  {
    company: 'Coastline Ceilings',
    contact: 'Peter Vasilakis',
    email: 'peter@coastlineceilings.com.au',
    mobile: '0455112233',
    status: 'contacted',
    source: 'phone',
    zone: 'wollongong',
    suburbs: 'Shell Cove, Kiama, Albion Park',
    volume: 600,
    frequency: 'Fortnightly',
    owner: 'Matthew Browne',
    heardAbout: 'Rang 1300 395 438',
    ageDays: 6,
    notes: ['Called back same afternoon. Wants a price on 600 m² fortnightly out of Shell Cove.'],
  },
  {
    company: 'Regis Homes NSW',
    contact: 'Amanda Cheung',
    email: 'procurement@regishomes.com.au',
    mobile: null,
    status: 'quoted',
    source: 'referral',
    zone: 'sydney',
    suburbs: 'Leppington, Austral, Gledswood Hills',
    volume: 3200,
    frequency: 'Three times a week',
    owner: 'Matthew Browne',
    heardAbout: 'Referred by Clarendon Homes',
    ageDays: 11,
    notes: [
      'Referred by Marcus at Clarendon. Volume is real — three estates in the south-west corridor.',
      'Sent Tier 2 rates plus the diversion certificate sample. Decision expected end of month.',
    ],
  },
  {
    company: 'Sapphire Linings',
    contact: 'Josh Whitmore',
    email: 'josh@sapphirelinings.com.au',
    mobile: '0421009876',
    status: 'quoted',
    source: 'enquiry-form',
    zone: 'sydney',
    suburbs: 'Penrith, Jordan Springs, Werrington',
    volume: 1100,
    frequency: 'Weekly',
    owner: 'Priya Raman',
    heardAbout: 'Google search',
    ageDays: 19,
    notes: ['Quoted Tier 3. Chasing — no answer to two emails.'],
  },
  {
    company: 'Everton Plastering',
    contact: 'Bill Marchetti',
    email: 'bill@evertonplastering.com.au',
    mobile: '0400556677',
    status: 'won',
    source: 'enquiry-form',
    zone: 'sydney',
    suburbs: 'Oran Park, Gregory Hills',
    volume: 800,
    frequency: 'Weekly',
    owner: 'Matthew Browne',
    heardAbout: 'Google search',
    ageDays: 34,
    notes: ['Converted on Tier 3 with a 7-day term. First pickup booked the same week.'],
  },
  {
    company: 'Northbridge Fitouts',
    contact: 'Simone Alder',
    email: 'simone@northbridgefitouts.com.au',
    mobile: '0466334455',
    status: 'lost',
    source: 'enquiry-form',
    zone: 'sydney',
    suburbs: 'North Sydney, Crows Nest',
    volume: 150,
    frequency: 'Occasionally',
    owner: 'Priya Raman',
    heardAbout: 'Google search',
    ageDays: 41,
    notes: ['Commercial strip-out, not new-build plasterboard. Referred them elsewhere.'],
  },
  {
    company: 'Tamworth Building Services',
    contact: 'Grant Ellery',
    email: 'grant@tamworthbuilding.com.au',
    mobile: '0417889900',
    status: 'lost',
    source: 'enquiry-form',
    zone: null,
    suburbs: 'Tamworth',
    volume: 400,
    frequency: 'Monthly',
    owner: 'Priya Raman',
    heardAbout: 'Google search',
    ageDays: 47,
    notes: ['Well outside the service area — 4 hours north of Newcastle. Nothing we can do.'],
  },
  {
    company: 'Macarthur Wall & Ceiling',
    contact: 'Nick Papadopoulos',
    email: 'nick@macarthurwc.com.au',
    mobile: '0432776655',
    status: 'contacted',
    source: 'enquiry-form',
    zone: 'sydney',
    suburbs: 'Campbelltown, Menangle Park',
    volume: 700,
    frequency: 'Weekly',
    owner: 'Matthew Browne',
    heardAbout: 'Saw a PlastaGo truck',
    ageDays: 9,
    notes: ['Left a voicemail. Trying again Thursday.'],
  },
  {
    company: 'Bright Interiors Group',
    contact: 'Yasmin Farouk',
    email: 'yasmin@brightinteriors.com.au',
    mobile: null,
    status: 'new',
    source: 'enquiry-form',
    zone: 'sydney',
    suburbs: 'Rouse Hill, Kellyville',
    volume: 500,
    frequency: 'Fortnightly',
    owner: null,
    heardAbout: 'LinkedIn',
    ageDays: 4,
    notes: [],
  },
  {
    company: 'Illawarra Plaster Supplies',
    contact: 'Dean Croft',
    email: 'dean@illawarraplaster.com.au',
    mobile: '0448223344',
    status: 'contacted',
    source: 'referral',
    zone: 'wollongong',
    suburbs: 'Dapto, Horsley, Wongawilli',
    volume: 950,
    frequency: 'Weekly',
    owner: 'Priya Raman',
    heardAbout: 'Referred by Illawarra Linings',
    ageDays: 15,
    notes: ['Wants kg captured as well as m² — worth confirming before quoting.'],
  },
  {
    company: 'Kembla Residential',
    contact: 'Sarah Nguyen',
    email: 'sarah@kemblaresidential.com.au',
    mobile: '0499112200',
    status: 'quoted',
    source: 'phone',
    zone: 'wollongong',
    suburbs: 'Port Kembla, Warrawong',
    volume: 300,
    frequency: 'Monthly',
    owner: 'Matthew Browne',
    heardAbout: 'Rang 1300 395 438',
    ageDays: 26,
    notes: ['Small but steady. Quoted Tier 4.'],
  },
];

export function buildLeads(): Lead[] {
  return LEAD_SEEDS.map((seed, index) => {
    const createdAt = isoDaysAgo(seed.ageDays, 9, 20 + index);
    const notes = seed.notes.map((body, noteIndex) => ({
      id: objectId('ln', index * 10 + noteIndex),
      // Notes land after the enquiry, one per day, so the thread reads forward.
      at: isoDaysAgo(Math.max(0, seed.ageDays - noteIndex - 1), 11, 5 + noteIndex),
      author: seed.owner ?? 'Matthew Browne',
      body,
    }));

    return {
      id: objectId('ld', index + 1),
      companyName: seed.company,
      contactName: seed.contact,
      email: seed.email,
      mobile: seed.mobile,
      status: seed.status,
      source: seed.source,
      zone: seed.zone,
      suburbs: seed.suburbs,
      typicalVolumeM2: seed.volume,
      expectedFrequency: seed.frequency,
      ownerName: seed.owner,
      createdAt,
      lastActivityAt: notes.at(-1)?.at ?? createdAt,
      // Everton is the one that already went through A.4.
      convertedAccountId: seed.status === 'won' ? objectId('ac', 90 + index) : null,
      heardAbout: seed.heardAbout,
      notes,
    };
  });
}

/* ── M2.12 · inbound PO extractions ───────────────────────────────────────── */

interface ExtractionSeed {
  accountCode: string | null;
  from: string;
  subject: string;
  attachment: string;
  poNumber: string | null;
  reason: PoExtraction['reason'];
  overall: number;
  ageHours: number;
  /** Per-field confidence, in the field order below. */
  confidences: readonly number[];
  pages: number;
  note: string;
}

/**
 * Nine inbound POs, chosen to exercise every reason a human gets involved.
 *
 * M2.12's worked example is here verbatim in shape: *"a scanned photo of a
 * handwritten PO from a small builder scores low confidence and lands in the
 * queue for a 10-second confirmation"*. The high-confidence ones are NOT here —
 * those auto-attach and never reach a person, which is the entire point of the
 * threshold.
 */
const EXTRACTION_SEEDS: readonly ExtractionSeed[] = [
  {
    accountCode: 'CLA001',
    from: 'ap@clarendonhomes.com.au',
    subject: 'PO 29916613/096 — Lot 77 Britannia Road',
    attachment: 'PO-29916613-096.pdf',
    poNumber: '29916613/096',
    reason: 'no-job-match',
    overall: 0.91,
    ageHours: 3,
    confidences: [0.97, 0.95, 0.72, 0.88, 0.93, 0.96, 0.9],
    pages: 1,
    note: 'Site address reads "Lot 77 Britannia Rd" — no open job at that lot.',
  },
  {
    accountCode: null,
    from: 'graham@ggplaster.com.au',
    subject: 'PO attached',
    attachment: 'IMG_4471.jpg',
    poNumber: 'GG-2291',
    reason: 'no-account-match',
    overall: 0.44,
    ageHours: 20,
    confidences: [0.61, 0.28, 0.35, 0.2, 0.4, 0.52, 0.31],
    pages: 1,
    note: 'Photograph of a handwritten docket. Sender domain matches no account.',
  },
  {
    accountCode: 'DOM001',
    from: 'accounts@domainehomes.com.au',
    subject: 'Purchase Order — additional charges Aug',
    attachment: 'DomainePO_Aug.pdf',
    poNumber: 'DOM-88214',
    reason: 'below-threshold',
    overall: 0.63,
    ageHours: 27,
    confidences: [0.68, 0.89, 0.44, 0.51, 0.39, 0.72, 0.6],
    pages: 3,
    note: 'Three-page scan; the amount sits in a table the OCR split across pages.',
  },
  {
    accountCode: 'WIS001',
    from: 'ap@wisdomhomes.com.au',
    subject: 'RE: Recycling pickup — PO',
    attachment: 'PO_Wisdom_774310.pdf',
    poNumber: '774310',
    reason: 'duplicate-po',
    overall: 0.94,
    ageHours: 44,
    confidences: [0.98, 0.96, 0.91, 0.85, 0.9, 0.94, 0.95],
    pages: 1,
    note: 'PO 774310 is already recorded against an invoiced job. Likely a resend.',
  },
  {
    accountCode: null,
    from: 'admin@fornarigroup.com',
    subject: 'PO — plasterboard removal',
    attachment: 'purchase-order.pdf',
    poNumber: 'FG-1102',
    reason: 'ambiguous-account',
    overall: 0.71,
    ageHours: 52,
    confidences: [0.88, 0.55, 0.66, 0.7, 0.74, 0.8, 0.62],
    pages: 1,
    note: 'Name matches both Fornari Group and Fornari Interiors.',
  },
  {
    accountCode: 'FOR001',
    from: 'rosa@fornari.com.au',
    subject: 'PO for last week',
    attachment: 'scan0092.pdf',
    poNumber: null,
    reason: 'below-threshold',
    overall: 0.38,
    ageHours: 76,
    confidences: [0.19, 0.72, 0.41, 0.33, 0.28, 0.35, 0.44],
    pages: 2,
    note: 'Faxed-then-scanned. No PO number could be read at all.',
  },
  {
    accountCode: 'IPL001',
    from: 'accounts@iplasta.com.au',
    subject: 'PO 5591 — Gledswood Hills',
    attachment: 'PO5591.pdf',
    poNumber: '5591',
    reason: 'no-job-match',
    overall: 0.86,
    ageHours: 101,
    confidences: [0.93, 0.92, 0.64, 0.81, 0.87, 0.88, 0.83],
    pages: 1,
    note: 'iPlasta is a no-PO account. Worth asking whether the policy changed.',
  },
  {
    accountCode: 'LAK001',
    from: 'craig@lakesideint.com.au',
    subject: 'Fwd: PO',
    attachment: 'forwarded-po.pdf',
    poNumber: 'LK-4417',
    reason: 'below-threshold',
    overall: 0.58,
    ageHours: 149,
    confidences: [0.79, 0.63, 0.42, 0.36, 0.55, 0.61, 0.5],
    pages: 1,
    note: 'Forwarded twice; the PDF is a screenshot of an email.',
  },
  {
    accountCode: 'DUR001',
    from: 'accounts@durnco.com.au',
    subject: 'PO DUR-9902',
    attachment: 'DUR-9902.pdf',
    poNumber: 'DUR-9902',
    reason: 'no-job-match',
    overall: 0.89,
    ageHours: 320,
    confidences: [0.95, 0.94, 0.7, 0.83, 0.86, 0.91, 0.88],
    pages: 1,
    note: 'Oldest in the queue — nearly a fortnight. Exactly what the chase exists for.',
  },
];

const FIELD_ORDER = [
  { key: 'poNumber', label: 'PO number' },
  { key: 'accountName', label: 'Account' },
  { key: 'siteAddress', label: 'Site address' },
  { key: 'customerReference', label: 'Customer reference' },
  { key: 'areaM2', label: 'Area (m²)' },
  { key: 'amountExGst', label: 'Amount ex GST' },
  { key: 'issuedOn', label: 'PO date' },
] as const;

export function buildPoExtractions(): PoExtraction[] {
  const rng = createRng(90210);

  return EXTRACTION_SEEDS.map((seed, index) => {
    const account = ACCOUNTS.find((candidate) => candidate.code === seed.accountCode) ?? null;

    // A job on the same account gives the reviewer something real to match to.
    const jobsForAccount = JOBS.filter(
      (job) => account !== null && job.accountId === account.id,
    ).slice(0, 4);
    const suggestedJob = seed.reason === 'no-job-match' ? null : (jobsForAccount[0] ?? null);
    const receivedAt = new Date(Date.now() - seed.ageHours * 3600_000).toISOString();
    const areaM2 = 400 + Math.round(rng() * 1600);
    const amountCents = 22000 + Math.round(areaM2 * 16);

    const values: Record<(typeof FIELD_ORDER)[number]['key'], string | null> = {
      poNumber: seed.poNumber,
      accountName: account?.name ?? seed.from.split('@')[1] ?? null,
      siteAddress: suggestedJob ? `${suggestedJob.siteName}, ${suggestedJob.suburb}` : null,
      customerReference: suggestedJob?.customerReference ?? null,
      areaM2: String(areaM2),
      amountExGst: `${String(Math.floor(amountCents / 100))}.${String(amountCents % 100).padStart(2, '0')}`,
      issuedOn: receivedAt.slice(0, 10),
    };

    return {
      id: objectId('px', index + 1),
      fromAddress: seed.from,
      subject: seed.subject,
      receivedAt,
      attachmentName: seed.attachment,
      pageCount: seed.pages,
      poNumber: seed.poNumber,
      suggestedAccountId: account?.id ?? null,
      suggestedAccountName: account?.name ?? null,
      suggestedJobId: suggestedJob?.id ?? null,
      suggestedJobNumber: suggestedJob?.jobNumber ?? null,
      amountExGst: values.amountExGst,
      overallConfidence: seed.overall,
      reason: seed.reason,
      state: 'needs-review' as const,

      documentText: [
        'PURCHASE ORDER',
        '',
        `Supplier:        PlastaGo Pty Ltd`,
        `PO number:       ${seed.poNumber ?? '— not legible —'}`,
        `Issued:          ${values.issuedOn ?? '—'}`,
        `Account:         ${values.accountName ?? '—'}`,
        `Delivery site:   ${values.siteAddress ?? '— not legible —'}`,
        `Reference:       ${values.customerReference ?? '—'}`,
        '',
        'Description                              Qty        Amount',
        `Plasterboard recycling pickup            ${String(areaM2)} m²   $${values.amountExGst ?? '—'}`,
        '',
        `TOTAL EX GST                                        $${values.amountExGst ?? '—'}`,
        '',
        `— extracted from ${seed.attachment} (${String(seed.pages)} page${seed.pages === 1 ? '' : 's'}) —`,
        seed.note,
      ].join('\n'),

      fields: FIELD_ORDER.map((field, fieldIndex) => ({
        key: field.key,
        label: field.label,
        value: values[field.key],
        confidence: seed.confidences[fieldIndex] ?? seed.overall,
      })),

      // Candidates are what "extract, then MATCH" produces: real records to
      // resolve to, never free text the reviewer has to retype.
      accountCandidates: (account ? [account] : ACCOUNTS.slice(0, 3)).map((candidate, rank) => ({
        id: candidate.id,
        label: candidate.name,
        detail: `${candidate.code} · ${candidate.primaryZone}`,
        confidence: account ? seed.overall : Math.max(0.2, 0.7 - rank * 0.18),
      })),

      jobCandidates: jobsForAccount.map((job, rank) => ({
        id: job.id,
        label: `#${String(job.jobNumber)} — ${job.siteName}`,
        detail: `${job.suburb} · ready ${job.readyDate} · ${String(job.expectedAreaM2)} m²`,
        confidence: Math.max(0.15, 0.82 - rank * 0.2),
      })),

      reviewedAt: null,
      reviewedBy: null,
    };
  });
}
