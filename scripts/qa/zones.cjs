const { execSync } = require('child_process');

const J = process.env.TEMP + '/qa.txt';
const BASE = 'http://localhost:4300/api/v1';

function api(method, path, body, jar = J) {
  const args = ['-s', '-b', jar, '-X', method, BASE + path];
  if (body) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body));
  const out = execSync('curl ' + args.map((a) => JSON.stringify(a)).join(' '), { encoding: 'utf8' });
  return out.trim() === '' ? null : JSON.parse(out);
}

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? '  → ' + detail : ''}`);
  }
}

const zones = () => api('GET', '/lookups/zones');
const settings = () => api('GET', '/settings');
const zoneByLabel = (label) => zones().find((z) => z.label === label);

console.log('\n── 5. Renaming a zone ─────────────────────────────────────────');
{
  const bm = zoneByLabel('Blue Mountains');
  const renamed = api('PATCH', `/settings/zones/${bm.value}`, { label: 'Blue Mtns' });
  check('rename returns the new label', renamed?.label === 'Blue Mtns', JSON.stringify(renamed?.error));
  check('the slug did NOT change', renamed?.slug === 'blue-mountains', renamed?.slug);
  check('it shows renamed in the lookup', zoneByLabel('Blue Mtns') !== undefined);

  // Put it back so later checks read naturally.
  api('PATCH', `/settings/zones/${bm.value}`, { label: 'Blue Mountains' });
}

console.log('\n── 6. Reordering ──────────────────────────────────────────────');
{
  const before = zones().map((z) => z.label);
  const ids = zones().map((z) => z.value);
  const moved = [ids[1], ids[0], ...ids.slice(2)];

  const after = api('PUT', '/settings/zones/order', { zoneIds: moved });
  check('reorder succeeds', Array.isArray(after), JSON.stringify(after?.error));
  const now = zones().map((z) => z.label);
  check('the first two swapped', now[0] === before[1] && now[1] === before[0], now.join(','));

  const short = api('PUT', '/settings/zones/order', { zoneIds: ids.slice(0, 2) });
  check('a partial list is refused (422)', short?.error?.code === 'VALIDATION_FAILED', JSON.stringify(short?.error?.code));

  const dupes = api('PUT', '/settings/zones/order', { zoneIds: [ids[0], ids[0], ...ids.slice(1, -1)] });
  check('a duplicated zone is refused', dupes?.error?.code === 'VALIDATION_FAILED', JSON.stringify(dupes?.error?.code));

  api('PUT', '/settings/zones/order', { zoneIds: ids });
  check('order restored', zones().map((z) => z.label).join(',') === before.join(','));
}

/** The zone section 7 creates and retires, so section 8 can try to reissue it. */
let retiredZoneLabel = '';

console.log('\n── 7. Retiring a zone ─────────────────────────────────────────');
{
  const s = settings();
  const sydney = s.pricing.zones.find((z) => z.slug === 'sydney');
  const refusedSydney = api('DELETE', `/settings/zones/${sydney.id}`);
  check(
    'refuses a zone with suburbs in it (409)',
    refusedSydney?.error?.code === 'CONFLICT' && /suburb/i.test(refusedSydney.error.message),
    refusedSydney?.error?.message,
  );

  /* A zone of its own each run, so a previous pass cannot decide the outcome. */
  const wollongong = zoneByLabel('Wollongong');
  const stamp = String(Date.now()).slice(-6);
  const made = api('POST', '/settings/zones', {
    label: `QA Zone ${stamp}`,
    copyRatesFromZoneId: wollongong.value,
  });
  check('a fresh zone is created', made?.id !== undefined, JSON.stringify(made?.error));

  const bm = settings().pricing.zones.find((z) => z.id === made.id);
  retiredZoneLabel = bm.label;
  check('the new zone reports 0 suburbs', bm.placeCount === 0, String(bm.placeCount));
  check('the new zone is archivable', bm.archivable === true);

  const retired = api('DELETE', `/settings/zones/${bm.id}`);
  check('retires a zone nothing points at', retired?.archived === true, JSON.stringify(retired?.error));

  const inLookup = zones().find((z) => z.value === bm.id);
  check('a retired zone is STILL named by the lookup', inLookup !== undefined);
  check('...and is flagged archived', inLookup?.archived === true);

  const again = api('DELETE', `/settings/zones/${bm.id}`);
  check('retiring twice is not an error', again?.archived === true);
}

console.log('\n── 8. A retired slug cannot be reissued ───────────────────────');
{
  const wol = zoneByLabel('Wollongong');
  const clash = api('POST', '/settings/zones', {
    label: retiredZoneLabel,
    copyRatesFromZoneId: wol.value,
  });
  check(
    'recreating a retired zone is refused (409)',
    clash?.error?.code === 'CONFLICT' && /retired/i.test(clash.error.message),
    clash?.error?.message,
  );
}

/* A start date no previous run can have used, so "already has a schedule" cannot fire. */
const FUTURE = `2030-${String((new Date().getMonth() % 12) + 1).padStart(2, '0')}-${String((Date.now() % 27) + 1).padStart(2, '0')}`;

console.log('\n── Schedules must price every LIVE zone ───────────────────────');
{
  const live = zones().filter((z) => !z.archived);
  const full = live.map((z) => ({ zoneId: z.value, serviceCharge: '100.00', ratePerM2: '0.10' }));

  const partial = api('POST', '/settings/rate-cards/tier-2/schedules', {
    effectiveFrom: FUTURE,
    zones: full.slice(0, -1),
  });
  check(
    'a schedule missing a zone is refused, and NAMES it',
    partial?.error?.code === 'VALIDATION_FAILED' && /has no price/i.test(JSON.stringify(partial.error.issues ?? '')),
    JSON.stringify(partial?.error?.issues ?? partial?.error?.message),
  );

  const bogus = api('POST', '/settings/rate-cards/tier-2/schedules', {
    effectiveFrom: FUTURE,
    zones: [...full, { zoneId: '6aaaaaaaaaaaaaaaaaaaaaaa', serviceCharge: '1.00', ratePerM2: '0.01' }],
  });
  check(
    'a rate for a zone that does not exist is refused',
    bogus?.error?.code === 'VALIDATION_FAILED',
    JSON.stringify(bogus?.error?.code),
  );

  const ok = api('POST', '/settings/rate-cards/tier-2/schedules', {
    effectiveFrom: FUTURE,
    zones: full,
  });
  check('a complete schedule is accepted', ok?.id === 'tier-2', JSON.stringify(ok?.error));

  const retiredZone = settings().pricing.zones.find((z) => z.archived);
  check(
    'a RETIRED zone is not required on a new schedule',
    retiredZone !== undefined && ok?.id === 'tier-2',
    'retired zone present: ' + String(retiredZone !== undefined),
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
