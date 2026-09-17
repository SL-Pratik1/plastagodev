import mongoose from 'mongoose';
import { connectMongo, disconnectMongo, isMongoConnected } from '../db/mongo.js';
import { logger } from '../lib/logger.js';

/**
 * Turns the zone STRING on every collection into a reference to a `zones` row
 * (M6.3).
 *
 *   npm --workspace @plastago/api run migrate:zones
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Zones were a compile-time enum, so every collection stored the word
 * `"sydney"`. They are documents now and everything stores an id, so a database
 * written before that change has rows nothing can read: the zone register does
 * not exist, no job can be priced, and the settings screen shows an empty list.
 *
 * The alternative is a reseed, which throws the data away. This keeps it.
 *
 * ── What it does, in order ────────────────────────────────────────────────
 *   1. Collects every distinct zone word across all six places one appears.
 *   2. Creates the `zones` register from them, in the office's own order.
 *   3. Drops the indexes keyed on the old `zone` field — see the note there.
 *   4. Re-points `zonerates`, `places`, `accounts`, `jobs` and `leads`.
 *   5. Re-keys `places` from the old suburb slug to an ObjectId.
 *   6. Verifies nothing is left pointing at nothing.
 *
 * ── Safe to run twice ─────────────────────────────────────────────────────
 * Every step skips rows already converted, so a re-run does nothing. That
 * matters: a migration you are afraid to repeat is one you cannot resume after
 * it fails half way.
 *
 * ⚠️ NOT reversible on its own. Take a copy of the database first — the
 * conversion overwrites the old field rather than keeping both, because leaving
 * a stale `zone` string beside a live `zoneId` is how the two drift apart.
 */

const log = logger.child({ module: 'migrate-zones' });

/**
 * The order and names the seed would have given these three.
 *
 * ⚠️ Anything NOT in this table still migrates — it just gets a title-cased
 * name and lands at the end. A zone this script has never heard of is somebody
 * else's data, and refusing it would be worse than naming it imperfectly.
 */
const KNOWN: Record<string, { label: string; order: number }> = {
  sydney: { label: 'Sydney', order: 0 },
  wollongong: { label: 'Wollongong', order: 1 },
  newcastle: { label: 'Newcastle', order: 2 },
};

function titleCase(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

async function main(): Promise<void> {
  await connectMongo();
  if (!isMongoConnected()) {
    throw new Error('Could not reach MongoDB — is it running?');
  }

  const db = mongoose.connection.db;
  if (!db) throw new Error('no database handle');

  console.log(`\nMigrating "${mongoose.connection.name}"\n`);

  /* ── 1. Every zone word in the data ─────────────────────────────────── */

  const slugs = new Set<string>();
  const collect = (values: unknown[]) => {
    for (const value of values) if (typeof value === 'string' && value !== '') slugs.add(value);
  };

  collect(await db.collection('zonerates').distinct('zone'));
  collect(await db.collection('places').distinct('zone'));
  collect(await db.collection('accounts').distinct('primaryZone'));
  collect(await db.collection('jobs').distinct('zone'));
  collect(await db.collection('jobs').distinct('appliedRate.zone'));
  collect(await db.collection('leads').distinct('zone'));

  /* ── 2. The register ────────────────────────────────────────────────── */

  const ordered = [...slugs].sort(
    (a, b) => (KNOWN[a]?.order ?? 99) - (KNOWN[b]?.order ?? 99) || a.localeCompare(b),
  );

  const zoneId = new Map<string, mongoose.Types.ObjectId>();

  for (const [index, slug] of ordered.entries()) {
    /*
     * `$setOnInsert`, so a re-run never renames a zone the office has since
     * renamed or drags it back to the position this script first gave it.
     */
    await db.collection('zones').updateOne(
      { slug },
      {
        $setOnInsert: {
          slug,
          label: KNOWN[slug]?.label ?? titleCase(slug),
          displayOrder: index,
          archived: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );

    const stored = await db.collection('zones').findOne({ slug });
    if (!stored) throw new Error(`zone "${slug}" was not written`);
    zoneId.set(slug, stored._id as mongoose.Types.ObjectId);
  }

  console.log('  zones');
  for (const slug of ordered) {
    const zone = await db.collection('zones').findOne({ slug });
    console.log(`    ${String(zone?.label).padEnd(14)} ${slug.padEnd(14)} ${String(zone?._id)}`);
  }

  /* ── 3. Drop the indexes keyed on the OLD field ─────────────────────── */

  /*
   * ⚠️ This has to happen BEFORE anything is re-pointed, and it is the step
   * that is easy to miss.
   *
   * Mongo does NOT drop an index because a Mongoose schema stopped declaring
   * one. `card_zone_from_unique` is unique on `{rateCardId, zone, effectiveFrom}`
   * — so the moment the second row has its `zone` unset, it collides with the
   * first on `zone: null` and the whole update fails half way through.
   *
   * Dropped by NAME rather than by shape, so this cannot take an index somebody
   * added for another reason. Mongoose rebuilds the `zoneId` versions on the
   * next boot from the schema.
   */
  const STALE_INDEXES: Record<string, readonly string[]> = {
    zonerates: ['card_zone_from_unique', 'card_zone_open_unique', 'card_zone_resolve'],
    places: ['zone'],
    jobs: ['zone_ready'],
    leads: ['zone_status'],
  };

  console.log('\n  stale indexes');
  for (const [coll, names] of Object.entries(STALE_INDEXES)) {
    for (const name of names) {
      try {
        await db.collection(coll).dropIndex(name);
        console.log(`    dropped  ${coll}.${name}`);
      } catch {
        /* Already gone — a re-run, or a database that never had it. */
        console.log(`    absent   ${coll}.${name}`);
      }
    }
  }

  /* ── 4. Re-point the five collections ───────────────────────────────── */

  const repoint = async (coll: string, from: string, to: string): Promise<number> => {
    let moved = 0;

    for (const [slug, id] of zoneId) {
      const result = await db
        .collection(coll)
        .updateMany({ [from]: slug }, { $set: { [to]: id }, $unset: { [from]: '' } });
      moved += result.modifiedCount;
    }

    return moved;
  };

  console.log('\n  references');
  for (const [coll, from, to] of [
    ['zonerates', 'zone', 'zoneId'],
    ['places', 'zone', 'zoneId'],
    ['accounts', 'primaryZone', 'primaryZoneId'],
    ['jobs', 'zone', 'zoneId'],
    ['leads', 'zone', 'zoneId'],
  ] as const) {
    const n = await repoint(coll, from, to);
    console.log(`    ${coll.padEnd(12)} ${String(n).padStart(4)} row(s)`);
  }

  /*
   * The frozen price snapshot on a job.
   *
   * ⚠️ It gets BOTH an id and a label, and the label is deliberately the zone's
   * name as it reads today — there is no record of what it read when the job was
   * priced, because that is exactly the thing this migration is creating. From
   * here on it is frozen; this is the one moment it cannot be.
   */
  let snapshots = 0;
  for (const [slug, id] of zoneId) {
    const zone = await db.collection('zones').findOne({ slug });
    const result = await db
      .collection('jobs')
      .updateMany(
        { 'appliedRate.zone': slug },
        {
          $set: { 'appliedRate.zoneId': id, 'appliedRate.zoneLabel': zone?.label ?? titleCase(slug) },
          $unset: { 'appliedRate.zone': '' },
        },
      );
    snapshots += result.modifiedCount;
  }
  console.log(`    ${'appliedRate'.padEnd(12)} ${String(snapshots).padStart(4)} snapshot(s)`);

  /* Places gained an `archived` flag; a row written before it has none. */
  const flagged = await db
    .collection('places')
    .updateMany({ archived: { $exists: false } }, { $set: { archived: false } });
  console.log(`    ${'archived'.padEnd(12)} ${String(flagged.modifiedCount).padStart(4)} place(s)`);

  /* ── 5. Re-key places from the old suburb slug to an ObjectId ───────── */

  const slugKeyed = await db
    .collection('places')
    .find({ _id: { $type: 'string' } })
    .toArray();

  if (slugKeyed.length > 0) {
    /*
     * ⚠️ `_id` is immutable, so this is insert-then-delete rather than an
     * update. Safe only because nothing stores a place id — a job keeps the
     * suburb and postcode it was booked into, never the row it was picked from.
     * That was verified before this script was written; if it ever stops being
     * true, this step has to re-point those references first.
     */
    for (const place of slugKeyed) {
      const { _id, ...rest } = place;
      await db.collection('places').insertOne({ _id: new mongoose.Types.ObjectId(), ...rest });
      await db.collection('places').deleteOne({ _id });
    }
  }
  console.log(`\n  places re-keyed to ObjectId: ${String(slugKeyed.length)}`);

  /* ── 6. Verify ──────────────────────────────────────────────────────── */

  const ids = new Set(
    (await db.collection('zones').distinct('_id')).map((id) => String(id)),
  );

  let dangling = 0;
  let leftover = 0;

  console.log('\n  verification');
  for (const [coll, field, old] of [
    ['zonerates', 'zoneId', 'zone'],
    ['places', 'zoneId', 'zone'],
    ['accounts', 'primaryZoneId', 'primaryZone'],
    ['jobs', 'zoneId', 'zone'],
    ['leads', 'zoneId', 'zone'],
  ] as const) {
    const rows = await db.collection(coll).find({}, { projection: { [field]: 1 } }).toArray();
    const bad = rows.filter((row) => {
      const value = row[field] as unknown;
      return value != null && !ids.has(String(value));
    }).length;

    const stale = await db.collection(coll).countDocuments({ [old]: { $exists: true } });

    dangling += bad;
    leftover += stale;

    console.log(
      `    ${coll.padEnd(12)} ${String(rows.length).padStart(4)} rows · ${String(bad)} dangling · ${String(stale)} still on the old field`,
    );
  }

  const staleSnapshots = await db.collection('jobs').countDocuments({ 'appliedRate.zone': { $exists: true } });
  const slugLeft = await db.collection('places').countDocuments({ _id: { $type: 'string' } });

  console.log(`    ${'appliedRate'.padEnd(12)}      · ${String(staleSnapshots)} still on the old field`);
  console.log(`    ${'places._id'.padEnd(12)}      · ${String(slugLeft)} still slug-keyed`);

  const clean = dangling === 0 && leftover === 0 && staleSnapshots === 0 && slugLeft === 0;

  console.log(
    clean
      ? '\n  ✓ migrated — every zone reference resolves, nothing left on the old shape\n'
      : `\n  ✗ INCOMPLETE — ${String(dangling)} dangling, ${String(leftover + staleSnapshots)} on the old shape, ${String(slugLeft)} slug-keyed\n`,
  );

  if (!clean) throw new Error('migration did not finish cleanly — restore the backup and investigate');

  log.info({ zones: ordered.length }, 'zone migration complete');
}

await main()
  .catch((error: unknown) => {
    log.error({ err: error }, 'zone migration failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectMongo();
  });
