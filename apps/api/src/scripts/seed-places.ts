import type { Place, Zone } from '@plastago/shared';
import mongoose from 'mongoose';
import { connectMongo, disconnectMongo, isMongoConnected } from '../db/mongo.js';
import { placeRepository } from '../domains/places/place.repository.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'seed-places' });

/**
 * Seeds the serviceable suburbs (M2.1, Matt 7:25).
 *
 * ── Why these sixteen and not a postcode file ─────────────────────────────
 * They are the greenfield estates PlastaGo actually collects from, and they are
 * the same list the console's demo data already uses — so a suburb picker looks
 * identical whether it is running on mocks or on the real API.
 *
 * ⚠️ This table is a statement about where the business goes. A suburb that is
 * missing means "we do not go there", and the booking form has to be able to say
 * so — adding suburbs is a commercial decision, not a data-completeness one.
 *
 *   npm --workspace @plastago/api run seed:places
 */

interface SeedPlace {
  suburb: string;
  postcode: string;
  zone: Zone;
  latitude: number;
  longitude: number;
}

const SUBURBS: readonly SeedPlace[] = [
  /* ── Sydney — the south-west and north-west growth corridors ─────────── */
  { suburb: 'Oran Park', postcode: '2570', zone: 'sydney', latitude: -34.0086, longitude: 150.7407 },
  {
    suburb: 'Catherine Field',
    postcode: '2557',
    zone: 'sydney',
    latitude: -34.0294,
    longitude: 150.7717,
  },
  {
    suburb: 'Gledswood Hills',
    postcode: '2557',
    zone: 'sydney',
    latitude: -34.0055,
    longitude: 150.7817,
  },
  { suburb: 'Austral', postcode: '2179', zone: 'sydney', latitude: -33.9271, longitude: 150.8125 },
  // Shares 2179 with Austral — which is why the picker offers both and a human
  // chooses, rather than resolving a postcode to one answer.
  {
    suburb: 'Leppington',
    postcode: '2179',
    zone: 'sydney',
    latitude: -33.9636,
    longitude: 150.8055,
  },
  { suburb: 'Box Hill', postcode: '2765', zone: 'sydney', latitude: -33.6449, longitude: 150.8757 },
  {
    suburb: 'Marsden Park',
    postcode: '2765',
    zone: 'sydney',
    latitude: -33.7042,
    longitude: 150.8347,
  },
  { suburb: 'Castle Hill', postcode: '2154', zone: 'sydney', latitude: -33.732, longitude: 151.005 },
  {
    suburb: 'Kellyville',
    postcode: '2155',
    zone: 'sydney',
    latitude: -33.7118,
    longitude: 150.9542,
  },
  { suburb: 'Camden', postcode: '2570', zone: 'sydney', latitude: -34.0548, longitude: 150.6957 },

  /* ── Wollongong ──────────────────────────────────────────────────────── */
  {
    suburb: 'Figtree',
    postcode: '2525',
    zone: 'wollongong',
    latitude: -34.4361,
    longitude: 150.8697,
  },
  {
    suburb: 'Shell Cove',
    postcode: '2529',
    zone: 'wollongong',
    latitude: -34.5906,
    longitude: 150.8583,
  },
  {
    suburb: 'Dapto',
    postcode: '2530',
    zone: 'wollongong',
    latitude: -34.5019,
    longitude: 150.7936,
  },

  /* ── Newcastle ───────────────────────────────────────────────────────── */
  {
    suburb: 'Fletcher',
    postcode: '2287',
    zone: 'newcastle',
    latitude: -32.8836,
    longitude: 151.6472,
  },
  {
    suburb: 'Thornton',
    postcode: '2322',
    zone: 'newcastle',
    latitude: -32.7873,
    longitude: 151.6339,
  },
  {
    suburb: 'Medowie',
    postcode: '2318',
    zone: 'newcastle',
    latitude: -32.7444,
    longitude: 151.8583,
  },
];

/**
 * The id a suburb answers to.
 *
 * Slugged rather than numbered, so an id survives the table being reordered or a
 * suburb being inserted in the middle of it — and so a job's stored place id
 * stays readable in the database.
 */
function slugOf(suburb: string): string {
  return suburb.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-places refuses to run with NODE_ENV=production');
  }

  await connectMongo();
  if (!isMongoConnected()) {
    throw new Error('Could not reach MongoDB — is it running?');
  }

  const places: Array<Omit<Place, 'label'>> = SUBURBS.map((place) => ({
    id: slugOf(place.suburb),
    suburb: place.suburb,
    postcode: place.postcode,
    state: 'NSW',
    zone: place.zone,
    latitude: place.latitude,
    longitude: place.longitude,
  }));

  await placeRepository.seed(places);
  log.info({ count: places.length }, 'places seeded');

  const byZone = new Map<Zone, number>();
  for (const place of places) byZone.set(place.zone, (byZone.get(place.zone) ?? 0) + 1);

  // eslint-disable-next-line no-console
  console.log(`
Seeded ${String(await placeRepository.count())} suburbs into "${mongoose.connection.name}".

  Sydney      ${String(byZone.get('sydney') ?? 0)}
  Wollongong  ${String(byZone.get('wollongong') ?? 0)}
  Newcastle   ${String(byZone.get('newcastle') ?? 0)}

A suburb that is not in this table means "we do not go there".
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
