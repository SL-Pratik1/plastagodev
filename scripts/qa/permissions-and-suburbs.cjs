const { execSync } = require('child_process');
const fs = require('fs');

const BASE = 'http://localhost:4300/api/v1';
const DEV_LOG = process.env.TEMP + '/dev.log';

function curl(args) {
  const out = execSync('curl ' + args.map((a) => JSON.stringify(a)).join(' '), { encoding: 'utf8' });
  return out.trim() === '' ? null : JSON.parse(out);
}

function api(method, path, body, jar) {
  const args = ['-s', '-b', jar, '-X', method, BASE + path];
  if (body) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body));
  return curl(args);
}

/** Sign in as anybody, using the code the stub mailer prints to the log. */
function signIn(identifier, jar) {
  try {
    fs.unlinkSync(jar);
  } catch {
    /* first run */
  }

  const before = fs.readFileSync(DEV_LOG, 'utf8').length;
  const challenge = curl([
    '-s', '-c', jar, '-X', 'POST', BASE + '/auth/otp/request',
    '-H', 'Content-Type: application/json',
    '-d', JSON.stringify({ identifier }),
  ]);
  if (!challenge?.challengeId) throw new Error(`no challenge for ${identifier}`);

  const tail = fs.readFileSync(DEV_LOG, 'utf8').slice(before);
  const code = [...tail.matchAll(/code is (\d{6})/g)].at(-1)?.[1];
  if (!code) throw new Error(`no code in the log for ${identifier}`);

  const session = curl([
    '-s', '-b', jar, '-c', jar, '-X', 'POST', BASE + '/auth/otp/verify',
    '-H', 'Content-Type: application/json',
    '-d', JSON.stringify({ challengeId: challenge.challengeId, code }),
  ]);
  if (!session?.user) throw new Error(`sign-in failed for ${identifier}: ${JSON.stringify(session)}`);
  return session.user;
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

/* A start date no previous run can have used. */
const OPS_DATE = '2031-' + String((new Date().getMonth() % 12) + 1).padStart(2,'0') + '-' + String((Date.now() % 27) + 1).padStart(2,'0');

const ADMIN = process.env.TEMP + '/qa.txt';
const OPS = process.env.TEMP + '/qa-ops.txt';

console.log('\n── 9. Zone administration is super-admin only ─────────────────');
{
  const user = signIn('renee@plastago.com.au', OPS);
  check('signed in as operations', user.roles.includes('operations'), user.roles.join(','));

  const zones = api('GET', '/lookups/zones', null, ADMIN);
  const wol = zones.find((z) => z.label === 'Wollongong');

  const create = api('POST', '/settings/zones', { label: 'Ops Test', copyRatesFromZoneId: wol.value }, OPS);
  check('operations cannot CREATE a zone (403)', create?.error?.code === 'FORBIDDEN', JSON.stringify(create?.error?.code));

  const rename = api('PATCH', `/settings/zones/${wol.value}`, { label: 'Nope' }, OPS);
  check('operations cannot RENAME a zone (403)', rename?.error?.code === 'FORBIDDEN', JSON.stringify(rename?.error?.code));

  const retire = api('DELETE', `/settings/zones/${wol.value}`, null, OPS);
  check('operations cannot RETIRE a zone (403)', retire?.error?.code === 'FORBIDDEN', JSON.stringify(retire?.error?.code));

  /* ...but the rest of settings is still theirs, which is the point of the split. */
  const settings = api('GET', '/settings', null, OPS);
  check('operations can still READ settings', settings?.pricing !== undefined, JSON.stringify(settings?.error?.code));

  const live = zones.filter((z) => !z.archived);
  const schedule = api(
    'POST',
    '/settings/rate-cards/tier-3/schedules',
    { effectiveFrom: OPS_DATE, zones: live.map((z) => ({ zoneId: z.value, serviceCharge: '111.00', ratePerM2: '0.11' })) },
    OPS,
  );
  check('operations CAN still issue a rate schedule', schedule?.id === 'tier-3', JSON.stringify(schedule?.error?.code));
}

console.log('\n── Suburbs ────────────────────────────────────────────────────');
{
  const zones = api('GET', '/lookups/zones', null, ADMIN);
  const live = zones.filter((z) => !z.archived);
  const retired = zones.find((z) => z.archived);
  const newcastle = live.find((z) => z.label === 'Newcastle');
  const central = live.find((z) => z.label === 'Central Coast');

  const all = api('GET', '/lookups/places/all', null, ADMIN);
  check('the admin list loads', Array.isArray(all), JSON.stringify(all?.error));
  check('every row carries a zone NAME', all.every((p) => typeof p.zoneLabel === 'string' && p.zoneLabel !== ''), JSON.stringify(all[0]));

  /* Operations may write suburbs — a looser gate than zones, on purpose. */
  const opsCreate = api(
    'POST',
    '/lookups/places',
    { suburb: 'Ops Suburb', postcode: '2250', state: 'NSW', zoneId: central.value, latitude: -33.4, longitude: 151.3 },
    OPS,
  );
  check('operations CAN add a suburb', opsCreate?.id !== undefined, JSON.stringify(opsCreate?.error));

  const badLat = api(
    'POST',
    '/lookups/places',
    { suburb: 'Wrongway', postcode: '2251', state: 'NSW', zoneId: central.value, latitude: 33.4, longitude: 151.3 },
    ADMIN,
  );
  check('a positive latitude is refused', badLat?.error?.code === 'VALIDATION_FAILED', JSON.stringify(badLat?.error?.code));

  const dupe = api(
    'POST',
    '/lookups/places',
    { suburb: 'Ops Suburb', postcode: '2250', state: 'NSW', zoneId: central.value, latitude: -33.4, longitude: 151.3 },
    ADMIN,
  );
  check('a duplicate suburb+postcode is refused (409)', dupe?.error?.code === 'CONFLICT', JSON.stringify(dupe?.error?.code));

  const sameNameOtherPostcode = api(
    'POST',
    '/lookups/places',
    { suburb: 'Ops Suburb', postcode: '2777', state: 'NSW', zoneId: central.value, latitude: -33.7, longitude: 150.3 },
    ADMIN,
  );
  check(
    'the SAME suburb name in another postcode is allowed',
    sameNameOtherPostcode?.id !== undefined,
    JSON.stringify(sameNameOtherPostcode?.error),
  );

  const intoRetired = api(
    'POST',
    '/lookups/places',
    { suburb: 'Nowhere', postcode: '2999', state: 'NSW', zoneId: retired.value, latitude: -33.4, longitude: 151.3 },
    ADMIN,
  );
  check('a suburb cannot be put in a RETIRED zone', intoRetired?.error?.code === 'VALIDATION_FAILED', JSON.stringify(intoRetired?.error?.code));

  /* Re-zoning: the flow that makes a new zone reachable. */
  const rezoned = api(
    'PATCH',
    `/lookups/places/${opsCreate.id}`,
    { suburb: 'Ops Suburb', postcode: '2250', state: 'NSW', zoneId: newcastle.value, latitude: -33.4, longitude: 151.3 },
    ADMIN,
  );
  check('a suburb can be re-zoned', rezoned?.zoneLabel === 'Newcastle', JSON.stringify(rezoned?.zoneLabel ?? rezoned?.error));

  /* Nothing has ever been collected there, so it is really removed. */
  const removed = api('DELETE', `/lookups/places/${opsCreate.id}`, null, ADMIN);
  check('a never-used suburb is REMOVED, not archived', removed === null, JSON.stringify(removed));

  api('DELETE', `/lookups/places/${sameNameOtherPostcode.id}`, null, ADMIN);

  /* One with jobs behind it is retired instead. */
  const kellyville = all.find((p) => p.suburb === 'Kellyville');
  const archived = api('DELETE', `/lookups/places/${kellyville.id}`, null, ADMIN);
  check('a suburb with jobs behind it is ARCHIVED', archived?.id === kellyville.id, JSON.stringify(archived));

  const picker = api('GET', '/lookups/places?q=Kellyville', null, ADMIN);
  check('...and drops out of the booking picker', (picker ?? []).length === 0, JSON.stringify(picker));

  const restored = api('POST', `/lookups/places/${kellyville.id}/restore`, null, ADMIN);
  check('...and can be restored', restored?.suburb === 'Kellyville', JSON.stringify(restored?.error));

  const back = api('GET', '/lookups/places?q=Kellyville', null, ADMIN);
  check('...back in the picker', (back ?? []).length === 1, JSON.stringify(back));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
