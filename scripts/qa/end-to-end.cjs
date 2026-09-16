const { execSync } = require('child_process');

const BASE = 'http://localhost:4300/api/v1';
const ADMIN = process.env.TEMP + '/qa.txt';

function api(method, path, body, jar = ADMIN) {
  const args = ['-s', '-b', jar, '-X', method, BASE + path];
  if (body) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body));
  const out = execSync('curl ' + args.map((a) => JSON.stringify(a)).join(' '), { encoding: 'utf8' });
  return out.trim() === '' ? null : JSON.parse(out);
}

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? '  → ' + detail : ''}`);
  }
};

console.log('\n── 3. End to end: a job in a zone that did not exist an hour ago ──');

const zones = api('GET', '/lookups/zones');
const central = zones.find((z) => z.label === 'Central Coast');

/* A suburb in the new zone — without one, nothing can be booked there at all. */
const created = api('POST', '/lookups/places', {
  suburb: 'Gosford',
  postcode: '2250',
  state: 'NSW',
  zoneId: central.value,
  latitude: -33.4269,
  longitude: 151.3428,
});

/* Re-runnable: a second pass reuses the row the first one made. */
const suburb = created?.id
  ? created
  : api('GET', '/lookups/places/all').find((p) => p.suburb === 'Gosford');

check('suburb is in the new zone', suburb?.id !== undefined, JSON.stringify(created?.error));
check('it names the zone back', suburb?.zoneLabel === 'Central Coast', suburb?.zoneLabel);

const found = api('GET', '/lookups/places?q=Gosford');
check('it appears in the booking picker', (found ?? []).length === 1, JSON.stringify(found));
check('the picker carries the zone name, not an id', found?.[0]?.zoneLabel === 'Central Coast', found?.[0]?.zoneLabel);

/* Book a real job there. */
const accounts = api('GET', '/lookups/accounts');
const account = accounts[0];

const draft = {
  accountId: account.value,
  placeId: suburb.id,
  builderName: 'QA Builder',
  siteName: 'QA Site',
  lotNumber: '1',
  addressLine: '1 Test Street',
  readyDate: '2026-10-01',
  expectedAreaM2: 500,
  bagCount: 0,
  serviceLevel: 'standard',
  freightItem: 'plasterboard-bagged',
  siteContactEmail: '',
  purchaseOrderId: null,
  accessNotes: '',
  gateHours: '',
  craneAvailable: false,
  inductionRequired: false,
  riskAssessmentRequired: false,
  siteContactName: 'QA Contact',
  siteContactMobile: '0400000000',
  notes: '',
  poNumber: '',
};

const job = api('POST', '/jobs', draft);
check('the job is created', job?.id !== undefined, JSON.stringify(job?.error ?? job).slice(0, 220));

if (job?.id) {
  check('the job carries the new zone by NAME', job.zoneLabel === 'Central Coast', job.zoneLabel);

  const detail = api('GET', `/jobs/${job.id}`);

  /*
   * `appliedRate` is stored on the job but has never been on the API contract —
   * it is not on master either, so there is nothing here to check. The frozen
   * snapshot is verified directly against the database; what the API DOES
   * expose is the charge line below, which carries the same frozen zone name
   * and is the thing that actually reaches an invoice.
   */
  const charges = detail?.charges ?? [];
  const fee = charges.find((c) => c.code === 'service-fee');
  check(
    'the charge line reads "Service fee — Central Coast"',
    fee?.description === 'Service fee — Central Coast',
    fee?.description,
  );

  /* The grid filter, which is what an office person actually uses. */
  const filtered = api(`GET`, `/jobs?zoneId=${central.value}&pageSize=5`);
  check('the jobs grid filters by the new zone', (filtered?.data ?? []).some((j) => j.id === job.id), JSON.stringify(filtered?.error));
  check('grid rows carry the zone name', filtered?.data?.[0]?.zoneLabel === 'Central Coast', filtered?.data?.[0]?.zoneLabel);

  /* A bookmark from before this change carries a slug. It must not 500. */
  const stale = api('GET', '/jobs?zoneId=sydney&pageSize=5');
  check('a stale slug filter degrades instead of erroring', Array.isArray(stale?.data), JSON.stringify(stale?.error));
}

console.log('\n── Renaming does not touch work already priced ────────────────');
{
  const before = api('GET', `/jobs/${job.id}`);
  const frozenDescription = (before?.charges ?? []).find((c) => c.code === 'service-fee')?.description;

  api('PATCH', `/settings/zones/${central.value}`, { label: 'Central Coast NSW' });

  const after = api('GET', `/jobs/${job.id}`);
  const nowDescription = (after?.charges ?? []).find((c) => c.code === 'service-fee')?.description;

  check('the charge line still reads the OLD name', nowDescription === frozenDescription, `${frozenDescription} → ${nowDescription}`);
  check('but the job row shows the NEW name', after?.zoneLabel === 'Central Coast NSW', after?.zoneLabel);

  api('PATCH', `/settings/zones/${central.value}`, { label: 'Central Coast' });
}

console.log('\n── 1. Regression: the three original zones still work ─────────');
{
  const sydney = zones.find((z) => z.label === 'Sydney');
  const q = api(`GET`, `/settings/quote?rateCardId=default&zoneId=${sydney.value}&expectedAreaM2=1000&bagCount=2`);
  check('Sydney still prices at $440 for 1000 m² + 2 bags', q?.subtotalExGst === '440.00', q?.subtotalExGst);

  const board = api('GET', '/dispatch/board?date=2026-09-17');
  check('the dispatch board loads', board?.unallocatedBySuburb !== undefined || board?.runs !== undefined, JSON.stringify(board?.error));

  const report = api('GET', '/reports/zones?from=2026-01-01&to=2026-12-31');
  check('the zone report loads', Array.isArray(report?.rows), JSON.stringify(report?.error));
  if (Array.isArray(report?.rows)) {
    console.log('        ' + report.rows.map((r) => `${r.label}=${String(r.jobs)}`).join('  '));
    check('report rows are NAMED, not id-ed', report.rows.every((r) => r.label && !/^[0-9a-f]{24}$/.test(r.label)));
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
