/**
 * A one-shot check that the Google credentials actually work (I3).
 *
 * ── Why this exists as a script and not a test ────────────────────────────
 * Every call it makes is BILLED, so it must never run in a suite. It answers
 * the one question no stubbed test can — "is this key, on this project, with
 * these APIs enabled, able to do the two things the platform needs?" — and it
 * spends at most two requests doing it.
 *
 *   npm run probe:maps                                   # geocode + routes
 *   npm run probe:maps -- "2 Macquarie St|Sydney|2000"   # one geocode only
 *
 * ⚠️ Deliberately prints the pin and Google's own rendering of the address.
 * "Which house did it actually find?" is the question worth asking of a
 * geocoder, and a bare latitude does not answer it.
 */
import { env } from '../config/env.js';
import { getMapsProvider } from '../integrations/maps.js';

async function main(): Promise<void> {
  console.log(`MAPS_PROVIDER = ${env.MAPS_PROVIDER}`);
  const maps = getMapsProvider();
  console.log(`provider      = ${maps.name}\n`);

  /*
   * An address on the command line means "check this one thing" — usually a
   * real street somebody is trying to explain. It skips the routes call, which
   * would be a second billed request nobody asked for.
   */
  const [line, suburb, postcode] = (process.argv[2] ?? '').split('|');

  console.log('── 1 geocoding request ──────────────────────────────────────');
  const point = await maps.geocode({
    addressLine: line?.trim() || '46 Allambie Circuit',
    suburb: suburb?.trim() || 'Kellyville',
    postcode: postcode?.trim() || '2155',
    state: 'NSW',
  });
  console.log(point ?? 'null — the warning logged above says why');

  if (line) return;

  console.log('\n── 1 routes request (5 stops around north-west Sydney) ──────');
  const ordered = await maps.optimiseStopOrder([
    { id: 'kellyville', latitude: -33.7118, longitude: 150.9542 },
    { id: 'castle-hill', latitude: -33.732, longitude: 151.0 },
    { id: 'rouse-hill', latitude: -33.6866, longitude: 150.9226 },
    { id: 'box-hill', latitude: -33.6421, longitude: 150.8938 },
    { id: 'baulkham-hills', latitude: -33.7614, longitude: 150.9926 },
  ]);
  console.log(ordered ?? 'null — the warning logged above says why');
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
